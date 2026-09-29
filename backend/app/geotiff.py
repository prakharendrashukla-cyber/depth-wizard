"""
GeoTIFF & Satellite Metadata Parser for Depth Wizard.

Parses GeoTIFF files using tifffile + Pillow.
Extracts geospatial metadata: GSD, bounds, capture date, sensor info.
Supports Cartosat / Chandrayaan metadata.
"""
import io
import re
import logging
from typing import Dict, Optional, Tuple, Any, List
import numpy as np
from PIL import Image

try:
    import tifffile
    HAS_TIFFFILE = True
except ImportError:
    tifffile = None
    HAS_TIFFFILE = False

logger = logging.getLogger(__name__)

# ── GeoTIFF Standard Tag IDs ─────────────────────────────────────────────
TAG_IMAGE_WIDTH = 256
TAG_IMAGE_LENGTH = 257
TAG_BITS_PER_SAMPLE = 258
TAG_COMPRESSION = 259
TAG_PHOTOMETRIC_INTERPRETATION = 262
TAG_IMAGE_DESCRIPTION = 270
TAG_MAKE = 271
TAG_MODEL = 272
TAG_SOFTWARE = 305
TAG_DATETIME = 306
TAG_ARTIST = 315
TAG_SAMPLE_FORMAT = 339
TAG_MODEL_PIXEL_SCALE = 33550
TAG_MODEL_TIEPOINT = 33922
TAG_MODEL_TRANSFORMATION = 34264
TAG_GEO_KEY_DIRECTORY = 34735
TAG_GEO_DOUBLE_PARAMS = 34736
TAG_GEO_ASCII_PARAMS = 34737
TAG_GDAL_METADATA = 42112
TAG_GDAL_NODATA = 42113


def pixel_to_latlon(
    x: float,
    y: float,
    geo_transform: Tuple[float, float, float, float, float, float],
) -> Tuple[float, float]:
    """
    Convert pixel coordinates (x, y) to geographic/projected coordinates (X, Y)
    using a standard 6-parameter affine transformation matrix (GDAL style).

    geo_transform format:
        (top_left_x, pixel_width, row_rotation, top_left_y, col_rotation, pixel_height)

    Args:
        x: Pixel column index (0 to width).
        y: Pixel row index (0 to height).
        geo_transform: 6-element tuple of affine transformation coefficients.

    Returns:
        (geo_x, geo_y): Projected coordinate or (longitude, latitude).
    """
    tl_x, px_w, rot_x, tl_y, rot_y, px_h = geo_transform
    geo_x = tl_x + x * px_w + y * rot_x
    geo_y = tl_y + x * rot_y + y * px_h
    return (round(float(geo_x), 6), round(float(geo_y), 6))


def get_bounds_geojson(
    geo_transform: Tuple[float, float, float, float, float, float],
    width: int,
    height: int,
) -> Dict[str, Any]:
    """
    Generate a GeoJSON Polygon Feature representing the spatial footprint/bounding box of the raster.

    Args:
        geo_transform: 6-element affine transform tuple.
        width: Image pixel width.
        height: Image pixel height.

    Returns:
        GeoJSON Feature dictionary with polygon coordinates.
    """
    # 4 corners in pixel space (clockwise from top-left)
    tl = pixel_to_latlon(0.0, 0.0, geo_transform)
    tr = pixel_to_latlon(float(width), 0.0, geo_transform)
    br = pixel_to_latlon(float(width), float(height), geo_transform)
    bl = pixel_to_latlon(0.0, float(height), geo_transform)

    return {
        "type": "Feature",
        "geometry": {
            "type": "Polygon",
            "coordinates": [[
                [tl[0], tl[1]],
                [tr[0], tr[1]],
                [br[0], br[1]],
                [bl[0], bl[1]],
                [tl[0], tl[1]],  # Close polygon ring
            ]],
        },
        "properties": {
            "raster_width": width,
            "raster_height": height,
            "top_left": tl,
            "top_right": tr,
            "bottom_right": br,
            "bottom_left": bl,
        },
    }


def extract_satellite_metadata(tiff_tags: Dict[Any, Any]) -> Dict[str, Any]:
    """
    Parse ISRO / Cartosat / Chandrayaan / Satellite metadata from TIFF tags.

    Inspects ImageDescription, Software, Model, GDAL tags, and custom metadata
    blocks for orbital, sensor, radiometric, and solar geometry parameters.

    Args:
        tiff_tags: Dictionary mapping tag IDs or tag names to values.

    Returns:
        Structured satellite metadata dictionary.
    """
    # Aggregate text representations across all tags for substring/regex inspection
    text_corpus_lines = []
    raw_cleaned_tags: Dict[str, Any] = {}

    for tag_key, tag_val in tiff_tags.items():
        key_str = str(tag_key)
        # Format string or numeric tag value
        if isinstance(tag_val, bytes):
            try:
                val_str = tag_val.decode("utf-8", errors="ignore").strip()
            except Exception:
                val_str = str(tag_val)
        else:
            val_str = str(tag_val).strip()

        # Limit giant binary payloads in raw_tags
        if len(val_str) < 1000:
            raw_cleaned_tags[key_str] = val_str
            text_corpus_lines.append(f"{key_str}: {val_str}")

    full_text = "\n".join(text_corpus_lines)
    full_text_upper = full_text.upper()

    # ── 1. Mission / Satellite Identification ────────────────────────
    mission = None
    sensor = None
    is_isro = False

    if "CHANDRAYAAN-2" in full_text_upper or "CHANDRAYAAN2" in full_text_upper or "CH-2" in full_text_upper:
        mission = "Chandrayaan-2"
        is_isro = True
    elif "CHANDRAYAAN-1" in full_text_upper or "CHANDRAYAAN1" in full_text_upper:
        mission = "Chandrayaan-1"
        is_isro = True
    elif "CHANDRAYAAN-3" in full_text_upper or "CHANDRAYAAN3" in full_text_upper:
        mission = "Chandrayaan-3"
        is_isro = True
    elif "CARTOSAT-3" in full_text_upper:
        mission = "Cartosat-3"
        is_isro = True
    elif "CARTOSAT-2" in full_text_upper:
        mission = "Cartosat-2"
        is_isro = True
    elif "CARTOSAT-1" in full_text_upper:
        mission = "Cartosat-1"
        is_isro = True
    elif "RESOURCESAT" in full_text_upper:
        mission = "Resourcesat"
        is_isro = True
    elif "RISAT" in full_text_upper:
        mission = "RISAT"
        is_isro = True
    elif "ISRO" in full_text_upper:
        mission = "ISRO Earth Observation / Planetary"
        is_isro = True
    elif "SENTINEL-2" in full_text_upper or "SENTINEL2" in full_text_upper:
        mission = "Sentinel-2"
    elif "LANDSAT-8" in full_text_upper or "LANDSAT 8" in full_text_upper or "LANDSAT-9" in full_text_upper:
        mission = "Landsat 8/9"
    elif "WORLDVIEW" in full_text_upper:
        mission = "WorldView"
    elif "PLANETSCOPE" in full_text_upper:
        mission = "PlanetScope"

    # ── 2. Sensor Identification ─────────────────────────────────────
    if "OHRC" in full_text_upper or "ORBITER HIGH RESOLUTION" in full_text_upper:
        sensor = "OHRC (Orbiter High Resolution Camera)"
    elif "TMC-2" in full_text_upper or "TMC2" in full_text_upper:
        sensor = "TMC-2 (Terrain Mapping Camera 2)"
    elif "TMC" in full_text_upper:
        sensor = "TMC (Terrain Mapping Camera)"
    elif "PAN-FORE" in full_text_upper or "PAN_AFT" in full_text_upper or "PAN-A" in full_text_upper or "PAN-F" in full_text_upper:
        sensor = "Cartosat Stereo PAN"
    elif "PAN" in full_text_upper:
        sensor = "Panchromatic (PAN)"
    elif "LISS-4" in full_text_upper or "LISS4" in full_text_upper:
        sensor = "LISS-4 Multispectral"
    elif "LISS-3" in full_text_upper or "LISS3" in full_text_upper:
        sensor = "LISS-3 Multispectral"
    elif "AWIFS" in full_text_upper:
        sensor = "AWiFS"
    elif "MSI" in full_text_upper:
        sensor = "MSI (MultiSpectral Instrument)"
    elif "OLI" in full_text_upper:
        sensor = "OLI (Operational Land Imager)"

    # ── 3. Regex Extraction for Satellite Parameters ─────────────────
    def _search_float(patterns: List[str]) -> Optional[float]:
        for pat in patterns:
            match = re.search(pat, full_text, re.IGNORECASE)
            if match:
                try:
                    return float(match.group(1))
                except (ValueError, TypeError):
                    continue
        return None

    def _search_str(patterns: List[str]) -> Optional[str]:
        for pat in patterns:
            match = re.search(pat, full_text, re.IGNORECASE)
            if match:
                return match.group(1).strip()
        return None

    # Sun Elevation Angle
    sun_elevation = _search_float([
        r"(?:SUN_ELEVATION|SOLAR_ELEVATION|SUN_ALTITUDE|SUN_ELEV)\s*[:=]\s*([0-9.\-]+)",
        r"SunElevation\s*=\s*([0-9.\-]+)",
    ])

    # Sun Azimuth Angle
    sun_azimuth = _search_float([
        r"(?:SUN_AZIMUTH|SOLAR_AZIMUTH|SUN_AZIM)\s*[:=]\s*([0-9.\-]+)",
        r"SunAzimuth\s*=\s*([0-9.\-]+)",
    ])

    # Incidence / Look Angle
    incidence_angle = _search_float([
        r"(?:INCIDENCE_ANGLE|INCIDENCE|INC_ANGLE)\s*[:=]\s*([0-9.\-]+)",
        r"(?:LOOK_ANGLE|OFF_NADIR_ANGLE|VIEWING_ANGLE|ROLL_ANGLE)\s*[:=]\s*([0-9.\-]+)",
    ])

    # Orbit / Pass Number
    orbit_num_str = _search_str([
        r"(?:ORBIT_NUMBER|ORBIT_NO|ORBIT|PASS_NUMBER|REVOLUTION)\s*[:=]\s*([0-9A-Za-z]+)",
        r"Orbit\s*:\s*([0-9]+)",
    ])

    # Acquisition Date
    acq_date = _search_str([
        r"(?:ACQUISITION_DATE|DATE_ACQUIRED|SCENE_CAPTURE_TIME|START_TIME|DATE_TIME)\s*[:=]\s*([0-9T:\-\. Z]+)",
        r"(?:CAPTURE_DATE|IMAGING_DATE)\s*[:=]\s*([0-9\-]+)",
    ])

    # Processing Level
    processing_level = _search_str([
        r"(?:PROCESSING_LEVEL|PRODUCT_LEVEL|DATA_LEVEL|PRODUCT_TYPE)\s*[:=]\s*([A-Za-z0-9_\-]+)",
        r"Level\s*[:=]\s*([A-Za-z0-9_\-]+)",
    ])

    # Spatial Resolution / GSD
    resolution_m = _search_float([
        r"(?:SPATIAL_RESOLUTION|GROUND_RESOLUTION|RESOLUTION|GSD_M)\s*[:=]\s*([0-9.\-]+)",
        r"(?:PIXEL_SPACING|PIXEL_SIZE)\s*[:=]\s*([0-9.\-]+)",
    ])

    # Fallback to TIFF tags for make/model/software
    if not mission:
        tag_make = tiff_tags.get(TAG_MAKE) or tiff_tags.get("Make")
        tag_model = tiff_tags.get(TAG_MODEL) or tiff_tags.get("Model")
        if tag_make or tag_model:
            mission = f"{tag_make or ''} {tag_model or ''}".strip()

    if not sensor and is_isro:
        sensor = "ISRO High-Resolution Optical Imager"

    return {
        "mission": mission or "Earth Observation / Planetary Satellite",
        "sensor": sensor or "Optical Sensor",
        "orbit_number": orbit_num_str,
        "sun_elevation_deg": sun_elevation,
        "sun_azimuth_deg": sun_azimuth,
        "incidence_angle_deg": incidence_angle,
        "look_angle_deg": incidence_angle,
        "acquisition_date": acq_date,
        "processing_level": processing_level or "Level-1B / Orthorectified",
        "spatial_resolution_m": resolution_m,
        "is_isro_payload": is_isro,
        "raw_tags": raw_cleaned_tags,
    }


def parse_geotiff(file_bytes: bytes) -> Dict[str, Any]:
    """
    Parse GeoTIFF / satellite raster files using tifffile with Pillow fallback.

    Extracts:
        - Image data as normalized RGB PIL Image
        - Spatial reference (GeoTransform, CRS/Projection, Bounds, GSD)
        - ISRO / Cartosat / Chandrayaan / Satellite metadata tags
        - Elevation / Radiometric data range

    Args:
        file_bytes: Raw binary bytes of GeoTIFF or standard TIFF file.

    Returns:
        Dictionary containing:
            - status: "success" or "error"
            - image: PIL.Image.Image (RGB 8-bit)
            - metadata: detailed geospatial & satellite metadata dictionary
    """
    if not file_bytes:
        raise ValueError("File bytes are empty.")

    tags_dict: Dict[Any, Any] = {}
    data: Optional[np.ndarray] = None
    geo_transform: Optional[Tuple[float, float, float, float, float, float]] = None
    crs_name: Optional[str] = None
    gsd_m: Optional[float] = None
    capture_date: Optional[str] = None

    # ── 1. Attempt parsing via tifffile ──────────────────────────────
    if HAS_TIFFFILE:
        try:
            with tifffile.TiffFile(io.BytesIO(file_bytes)) as tif:
                data = tif.asarray()
                if tif.pages:
                    first_page = tif.pages[0]
                    for tag in first_page.tags.values():
                        tags_dict[tag.code] = tag.value
                        tags_dict[tag.name] = tag.value

                    # Check for GeoTIFF metadata structure
                    if hasattr(tif, "geotiff_metadata") and tif.geotiff_metadata:
                        gt_meta = tif.geotiff_metadata
                        if "ModelPixelScale" in gt_meta:
                            tags_dict[TAG_MODEL_PIXEL_SCALE] = gt_meta["ModelPixelScale"]
                        if "ModelTiepoint" in gt_meta:
                            tags_dict[TAG_MODEL_TIEPOINT] = gt_meta["ModelTiepoint"]
                        if "ModelTransformation" in gt_meta:
                            tags_dict[TAG_MODEL_TRANSFORMATION] = gt_meta["ModelTransformation"]
        except Exception as exc:
            logger.warning("tifffile parsing encountered error: %s. Falling back to Pillow.", exc)
            data = None

    # ── 2. Fallback to Pillow if tifffile was unavailable or failed ───
    if data is None:
        try:
            pil_raw = Image.open(io.BytesIO(file_bytes))
            data = np.array(pil_raw)
            if hasattr(pil_raw, "tag_v2"):
                for k, v in pil_raw.tag_v2.items():
                    tags_dict[k] = v
            elif hasattr(pil_raw, "tag"):
                for k, v in pil_raw.tag.items():
                    tags_dict[k] = v
        except Exception as exc:
            logger.error("Could not parse TIFF with Pillow: %s", exc)
            raise ValueError(f"Invalid TIFF image file: {exc}")

    if data is None or data.size == 0:
        raise ValueError("Decoded image raster data is empty.")

    # ── 3. Dimensions & Raster Structure ─────────────────────────────
    if data.ndim == 2:
        height, width = data.shape
        bands = 1
    elif data.ndim == 3:
        # Check channel ordering: (H, W, C) vs (C, H, W)
        if data.shape[0] in (1, 3, 4) and data.shape[0] < data.shape[1] and data.shape[0] < data.shape[2]:
            data = np.transpose(data, (1, 2, 0))
        height, width, bands = data.shape
    else:
        raise ValueError(f"Unsupported image array shape: {data.shape}")

    # ── 4. Convert Raster to Normalized 8-bit RGB PIL Image ──────────
    if bands == 1:
        single_channel = data.squeeze()
        c_min, c_max = float(single_channel.min()), float(single_channel.max())
        if c_max > c_min:
            norm_2d = np.clip((single_channel - c_min) / (c_max - c_min) * 255.0, 0, 255).astype(np.uint8)
        else:
            norm_2d = np.zeros((height, width), dtype=np.uint8)
        pil_image = Image.fromarray(norm_2d).convert("RGB")
    else:
        # Multi-band / RGB / Multispectral: take first 3 channels
        rgb_data = data[:, :, :3]
        if rgb_data.dtype != np.uint8:
            c_min, c_max = float(rgb_data.min()), float(rgb_data.max())
            if c_max > c_min:
                norm_rgb = np.clip((rgb_data - c_min) / (c_max - c_min) * 255.0, 0, 255).astype(np.uint8)
            else:
                norm_rgb = np.zeros((height, width, 3), dtype=np.uint8)
            pil_image = Image.fromarray(norm_rgb)
        else:
            if rgb_data.shape[2] == 3:
                pil_image = Image.fromarray(rgb_data, mode="RGB")
            else:
                pil_image = Image.fromarray(rgb_data[:, :, 0]).convert("RGB")

    # ── 5. Extract GeoTIFF Transform & Geospatial References ─────────
    # ModelPixelScaleTag = [ScaleX, ScaleY, ScaleZ]
    # ModelTiepointTag = [I, J, K, X, Y, Z]
    pixel_scale = tags_dict.get(TAG_MODEL_PIXEL_SCALE) or tags_dict.get("ModelPixelScaleTag")
    tiepoints = tags_dict.get(TAG_MODEL_TIEPOINT) or tags_dict.get("ModelTiepointTag")
    model_transform = tags_dict.get(TAG_MODEL_TRANSFORMATION) or tags_dict.get("ModelTransformationTag")

    is_georeferenced = False

    if pixel_scale is not None and tiepoints is not None:
        try:
            scale_x = float(pixel_scale[0])
            scale_y = float(pixel_scale[1])
            # Tiepoints: typically [I=0, J=0, K=0, X=origin_x, Y=origin_y, Z=0]
            if len(tiepoints) >= 6:
                tp_i, tp_j, _, tp_x, tp_y, _ = tiepoints[:6]
                origin_x = float(tp_x) - float(tp_i) * scale_x
                origin_y = float(tp_y) + float(tp_j) * scale_y
                # GeoTIFF standard: North-up images have negative pixel_height
                geo_transform = (origin_x, scale_x, 0.0, origin_y, 0.0, -scale_y)
                gsd_m = float((abs(scale_x) + abs(scale_y)) / 2.0)
                is_georeferenced = True
        except Exception as exc:
            logger.warning("Failed to calculate GeoTransform from Tiepoint/Scale tags: %s", exc)

    elif model_transform is not None:
        try:
            # 4x4 matrix flattened (16 elements)
            m = [float(v) for v in model_transform]
            if len(m) >= 16:
                # GDAL affine: (origin_x, rot_x, rot_y, origin_y, rot_x2, rot_y2)
                geo_transform = (m[3], m[0], m[1], m[7], m[4], m[5])
                gsd_m = float((abs(m[0]) + abs(m[5])) / 2.0)
                is_georeferenced = True
        except Exception as exc:
            logger.warning("Failed to calculate GeoTransform from ModelTransformation tag: %s", exc)

    # ── 6. CRS / Coordinate Reference System ─────────────────────────
    geokey_dir = tags_dict.get(TAG_GEO_KEY_DIRECTORY) or tags_dict.get("GeoKeyDirectoryTag")
    geo_ascii = tags_dict.get(TAG_GEO_ASCII_PARAMS) or tags_dict.get("GeoAsciiParamsTag")

    if geo_ascii:
        if isinstance(geo_ascii, bytes):
            crs_name = geo_ascii.decode("utf-8", errors="ignore").replace("|", " ").strip()
        else:
            crs_name = str(geo_ascii).replace("|", " ").strip()
    elif geokey_dir is not None:
        # Check standard key codes (e.g. 4326 for WGS84, 326xx for UTM)
        key_list = list(geokey_dir)
        if 4326 in key_list:
            crs_name = "EPSG:4326 (WGS 84 / Geographic)"
        elif any(32601 <= k <= 32660 for k in key_list if isinstance(k, int)):
            utm_zone = [k - 32600 for k in key_list if isinstance(k, int) and 32601 <= k <= 32660][0]
            crs_name = f"WGS 84 / UTM Zone {utm_zone}N (EPSG:{32600 + utm_zone})"
        else:
            crs_name = "GeoTIFF Projected / Geographic CRS"
    elif is_georeferenced:
        crs_name = "Georeferenced Coordinate System"

    # ── 7. Geographic Bounds & GeoJSON ───────────────────────────────
    bounds = None
    bounds_geojson = None

    if is_georeferenced and geo_transform is not None:
        tl = pixel_to_latlon(0.0, 0.0, geo_transform)
        tr = pixel_to_latlon(float(width), 0.0, geo_transform)
        br = pixel_to_latlon(float(width), float(height), geo_transform)
        bl = pixel_to_latlon(0.0, float(height), geo_transform)

        all_x = [tl[0], tr[0], br[0], bl[0]]
        all_y = [tl[1], tr[1], br[1], bl[1]]

        bounds = {
            "min_x": round(min(all_x), 6),
            "max_x": round(max(all_x), 6),
            "min_y": round(min(all_y), 6),
            "max_y": round(max(all_y), 6),
            "corners": {
                "top_left": tl,
                "top_right": tr,
                "bottom_right": br,
                "bottom_left": bl,
            },
        }
        bounds_geojson = get_bounds_geojson(geo_transform, width, height)

    # ── 8. Capture Date ──────────────────────────────────────────────
    raw_date = tags_dict.get(TAG_DATETIME) or tags_dict.get("DateTime")
    if raw_date:
        if isinstance(raw_date, bytes):
            capture_date = raw_date.decode("utf-8", errors="ignore").strip()
        else:
            capture_date = str(raw_date).strip()

    # ── 9. Satellite & Sensor Info ───────────────────────────────────
    sensor_info = extract_satellite_metadata(tags_dict)
    if not capture_date and sensor_info.get("acquisition_date"):
        capture_date = sensor_info["acquisition_date"]
    if gsd_m is None and sensor_info.get("spatial_resolution_m"):
        gsd_m = sensor_info["spatial_resolution_m"]

    # ── 10. Elevation Range (DEM / Single-band Rasters) ──────────────
    elevation_range = None
    if bands == 1:
        elevation_range = {
            "min": round(float(data.min()), 2),
            "max": round(float(data.max()), 2),
            "mean": round(float(data.mean()), 2),
            "unit": "meters / digital numbers",
        }

    return {
        "status": "success",
        "image": pil_image,
        "metadata": {
            "width": width,
            "height": height,
            "bands": bands,
            "dtype": str(data.dtype),
            "is_georeferenced": is_georeferenced,
            "geo_transform": geo_transform,
            "crs": crs_name,
            "bounds": bounds,
            "bounds_geojson": bounds_geojson,
            "gsd_m": round(gsd_m, 4) if gsd_m is not None else None,
            "capture_date": capture_date,
            "sensor_info": sensor_info,
            "elevation_range": elevation_range,
        },
    }
