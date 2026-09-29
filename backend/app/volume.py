"""
Volume Estimation and Shadow Analysis for Depth Wizard.

Computes volume above ground baseline (cubic meters) using trapezoidal / cell integration.
Also computes shadow casting from configurable sun azimuth and elevation angles.
"""

import base64
import io
import logging
import math
from typing import Any, Dict, List, Optional, Tuple, Union

import numpy as np
from PIL import Image

logger = logging.getLogger(__name__)


def estimate_volume(
    height_map: np.ndarray,
    scale_factor: float = 1.0,
    ground_percentile: float = 10.0,
    pixel_size_m: float = 1.0,
) -> Dict[str, Any]:
    """
    Compute total volume and layer breakdown above the ground baseline.

    Args:
        height_map: 2D numpy array (H, W) of relative depth or height values.
        scale_factor: Multiplier to convert relative height to absolute meters.
        ground_percentile: Percentile used to define the ground plane baseline (default 10.0).
        pixel_size_m: Real-world horizontal dimension of each pixel in meters (default 1.0m).

    Returns:
        Dictionary containing:
            - total_volume_m3: float (total cubic meters above baseline)
            - above_ground_area_m2: float (footprint area with elevation > baseline)
            - total_area_m2: float (entire raster area)
            - ground_baseline_m: float (estimated absolute ground elevation)
            - peak_height_m: float (maximum absolute elevation)
            - max_height_above_ground_m: float (peak relief above baseline)
            - mean_height_above_ground_m: float (mean relief over elevated area)
            - volume_by_layer: list of 10 height layers with cumulative & layer volumes:
                - layer_index: int (1-10)
                - height_m: float (top elevation of this layer above ground)
                - layer_volume_m3: float (volume in this slice)
                - cumulative_volume_m3: float (volume up to this height)
                - layer_percentage: float (% of total volume)
            - pixel_size_m: float
            - scale_factor: float
    """
    if height_map is None or not isinstance(height_map, np.ndarray) or height_map.ndim != 2:
        raise ValueError("height_map must be a 2D numpy array.")

    h, w = height_map.shape
    d = height_map.astype(np.float64)

    # Normalize depth map to [0, 1]
    d_min = float(np.nanmin(d))
    d_max = float(np.nanmax(d))
    span = d_max - d_min
    if span > 1e-7:
        norm_h = (d - d_min) / span
    else:
        norm_h = np.zeros_like(d)

    # Convert to physical metric heights
    h_m = norm_h * float(scale_factor)

    # Robust ground plane baseline (e.g. 10th percentile)
    p_clamped = max(0.0, min(50.0, float(ground_percentile)))
    ground_baseline_m = float(np.percentile(h_m, p_clamped))
    peak_height_m = float(np.max(h_m))

    # Height above ground baseline (clipped at 0)
    h_above = np.maximum(0.0, h_m - ground_baseline_m)

    # Spatial integration parameters
    cell_area = float(pixel_size_m * pixel_size_m)
    total_raster_area = float(h * w * cell_area)

    # Total volume: sum of height * cell_area
    total_volume_m3 = float(np.sum(h_above) * cell_area)

    # Elevated area calculation (> 1mm above baseline)
    elevated_mask = h_above > 1e-3
    above_ground_area_m2 = float(np.sum(elevated_mask) * cell_area)

    max_height_above_ground_m = float(np.max(h_above))
    if np.any(elevated_mask):
        mean_height_above_ground_m = float(np.mean(h_above[elevated_mask]))
    else:
        mean_height_above_ground_m = 0.0

    # Layer-by-layer volume breakdown (10 equally spaced horizontal slices)
    num_layers = 10
    volume_by_layer: List[Dict[str, Any]] = []

    if max_height_above_ground_m > 1e-5:
        layer_thickness = max_height_above_ground_m / num_layers
        for i in range(num_layers):
            h_bottom = i * layer_thickness
            h_top = (i + 1) * layer_thickness

            # Sliced volume contribution in [h_bottom, h_top]
            layer_slice_h = np.clip(h_above - h_bottom, 0.0, layer_thickness)
            layer_vol = float(np.sum(layer_slice_h) * cell_area)

            # Cumulative volume up to h_top
            cum_vol = float(np.sum(np.minimum(h_above, h_top)) * cell_area)

            pct = (layer_vol / total_volume_m3 * 100.0) if total_volume_m3 > 1e-6 else 0.0

            volume_by_layer.append(
                {
                    "layer_index": i + 1,
                    "height_m": round(h_top, 3),
                    "layer_volume_m3": round(layer_vol, 2),
                    "cumulative_volume_m3": round(cum_vol, 2),
                    "layer_percentage": round(pct, 2),
                }
            )
    else:
        for i in range(num_layers):
            volume_by_layer.append(
                {
                    "layer_index": i + 1,
                    "height_m": 0.0,
                    "layer_volume_m3": 0.0,
                    "cumulative_volume_m3": 0.0,
                    "layer_percentage": 0.0,
                }
            )

    logger.info(
        "Volume estimation: total=%.2f m³, elevated_area=%.2f m², max_relief=%.2f m",
        total_volume_m3,
        above_ground_area_m2,
        max_height_above_ground_m,
    )

    return {
        "total_volume_m3": round(total_volume_m3, 2),
        "above_ground_area_m2": round(above_ground_area_m2, 2),
        "total_area_m2": round(total_raster_area, 2),
        "ground_baseline_m": round(ground_baseline_m, 2),
        "peak_height_m": round(peak_height_m, 2),
        "max_height_above_ground_m": round(max_height_above_ground_m, 2),
        "mean_height_above_ground_m": round(mean_height_above_ground_m, 2),
        "volume_by_layer": volume_by_layer,
        "pixel_size_m": round(pixel_size_m, 3),
        "scale_factor": round(scale_factor, 3),
    }


def compute_shadow_map(
    height_map: np.ndarray,
    sun_azimuth_deg: float = 180.0,
    sun_elevation_deg: float = 45.0,
    scale_factor: float = 1.0,
    pixel_size_m: float = 1.0,
) -> Dict[str, Any]:
    """
    Compute shadow casting from 3D height data and sun position.

    Uses high-speed vectorized ray marching from each pixel toward the sun direction.

    Args:
        height_map: 2D numpy array (H, W) of relative depth or height values.
        sun_azimuth_deg: Sun azimuth angle in degrees (0°=North, 90°=East, 180°=South, 270°=West).
        sun_elevation_deg: Sun elevation angle above horizon in degrees (0.1° to 89.9°).
        scale_factor: Multiplier to convert relative height to absolute meters.
        pixel_size_m: Real-world horizontal dimension of each pixel in meters (default 1.0m).

    Returns:
        Dictionary containing:
            - shadow_mask: 2D numpy array (H, W) of bools (True = pixel in shadow, False = illuminated)
            - shadow_percentage: float (% of total pixels in shadow)
            - illuminated_percentage: float (% of total pixels illuminated)
            - shadow_map_base64: str (base64-encoded PNG image for frontend display)
            - sun_params: dict with azimuth_deg, elevation_deg, scale_factor, pixel_size_m
    """
    if height_map is None or not isinstance(height_map, np.ndarray) or height_map.ndim != 2:
        raise ValueError("height_map must be a 2D numpy array.")

    h, w = height_map.shape
    d = height_map.astype(np.float32)

    # Normalize depth map to [0, 1]
    d_min = float(np.nanmin(d))
    d_max = float(np.nanmax(d))
    span = d_max - d_min
    if span > 1e-7:
        norm_h = (d - d_min) / span
    else:
        norm_h = np.zeros_like(d)

    # Convert to physical metric heights
    Z = norm_h * float(scale_factor)
    px_size = max(1e-4, float(pixel_size_m))

    # Clamp sun elevation to valid range above horizon
    elev_deg = max(0.1, min(89.9, float(sun_elevation_deg)))
    elev_rad = math.radians(elev_deg)
    tan_elev = math.tan(elev_rad)

    # Sun azimuth angle
    az_deg = float(sun_azimuth_deg) % 360.0
    az_rad = math.radians(az_deg)

    # Direction vector towards the sun in image coordinates:
    # y increases downward (South), x increases rightward (East)
    # North (0°)  -> dy = -1, dx =  0
    # East  (90°) -> dy =  0, dx = +1
    # South (180°)-> dy = +1, dx =  0
    # West  (270°)-> dy =  0, dx = -1
    dir_x = math.sin(az_rad)
    dir_y = -math.cos(az_rad)

    # Step normalization so max(|dx|, |dy|) == 1.0
    max_dir = max(abs(dir_x), abs(dir_y))
    if max_dir < 1e-6:
        step_x = 0.0
        step_y = 0.0
    else:
        step_x = dir_x / max_dir
        step_y = dir_y / max_dir

    # Maximum relief span in scene
    max_relief = float(np.max(Z) - np.min(Z))
    # Step distance in meters
    step_dist_m = math.sqrt(step_x ** 2 + step_y ** 2) * px_size
    z_rise_per_step = max(1e-4, step_dist_m * tan_elev)

    # Maximum steps needed before ray rises above highest possible blocker
    max_steps = int(math.ceil(max_relief / z_rise_per_step)) + 2
    max_steps = max(1, min(max_steps, max(h, w)))

    # Fast vectorized 2D slice marching
    shadow_mask = np.zeros((h, w), dtype=bool)

    for step in range(1, max_steps + 1):
        r_off = int(round(step * step_y))
        c_off = int(round(step * step_x))

        if r_off == 0 and c_off == 0:
            continue

        # Target slice (pixels being evaluated for illumination/shadow)
        t_r_start = max(0, -r_off)
        t_r_end = min(h, h - r_off)
        t_c_start = max(0, -c_off)
        t_c_end = min(w, w - c_off)

        if t_r_start >= t_r_end or t_c_start >= t_c_end:
            break

        # Blocker sample slice (terrain that could cast shadow onto target)
        s_r_start = t_r_start + r_off
        s_r_end = t_r_end + r_off
        s_c_start = t_c_start + c_off
        s_c_end = t_c_end + c_off

        # Ray height threshold above target pixel
        dist_m = math.sqrt(r_off ** 2 + c_off ** 2) * px_size
        ray_rise = dist_m * tan_elev

        # Target pixel is in shadow if blocking terrain exceeds ray altitude
        is_blocked = Z[s_r_start:s_r_end, s_c_start:s_c_end] > (
            Z[t_r_start:t_r_end, t_c_start:t_c_end] + ray_rise
        )

        shadow_mask[t_r_start:t_r_end, t_c_start:t_c_end] |= is_blocked

    total_pixels = float(shadow_mask.size)
    shadow_count = float(np.sum(shadow_mask))
    shadow_pct = round((shadow_count / total_pixels) * 100.0, 2)
    illuminated_pct = round(100.0 - shadow_pct, 2)

    # ── Render Base64 PNG Shadow Overlay ─────────────────────────────────────
    # RGBA overlay: Lit areas = transparent (0,0,0,0); Shadowed = Dark Navy tint (8, 10, 16, 210)
    rgba = np.zeros((h, w, 4), dtype=np.uint8)
    rgba[shadow_mask] = [8, 10, 16, 210]  # Dark theme matching #080a10 shadow overlay
    rgba[~shadow_mask] = [255, 255, 255, 0]  # Transparent illuminated region

    shadow_img = Image.fromarray(rgba, mode="RGBA")
    buf = io.BytesIO()
    shadow_img.save(buf, format="PNG")
    shadow_base64 = base64.b64encode(buf.getvalue()).decode("ascii")

    logger.info(
        "Shadow computation: sun_az=%.1f°, sun_el=%.1f°, shadows=%.1f%% of area",
        az_deg,
        elev_deg,
        shadow_pct,
    )

    return {
        "shadow_mask": shadow_mask,
        "shadow_percentage": shadow_pct,
        "illuminated_percentage": illuminated_pct,
        "shadow_map_base64": shadow_base64,
        "sun_params": {
            "azimuth_deg": az_deg,
            "elevation_deg": elev_deg,
            "scale_factor": scale_factor,
            "pixel_size_m": pixel_size_m,
        },
    }
