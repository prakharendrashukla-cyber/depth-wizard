"""
Contour Map Generator for Depth Wizard.

Generates contour lines at configurable intervals from depth/height maps.
Outputs SVG paths, full SVG document, and ASCII DXF CAD/GIS export.
Also computes slope (steepness) and aspect (direction) maps from height gradients.
"""

import logging
import math
from typing import Any, Dict, List, Optional, Tuple, Union

import numpy as np

logger = logging.getLogger(__name__)


def _interpolate_edge(
    x1: float, y1: float, v1: float,
    x2: float, y2: float, v2: float,
    iso: float,
) -> Tuple[float, float]:
    """Linearly interpolate the coordinate on a grid cell edge where value == iso."""
    diff = v2 - v1
    if abs(diff) < 1e-9:
        t = 0.5
    else:
        t = (iso - v1) / diff
    t = max(0.0, min(1.0, t))
    return x1 + t * (x2 - x1), y1 + t * (y2 - y1)


def _marching_squares_level(
    Z: np.ndarray,
    iso_val: float,
) -> List[Tuple[Tuple[float, float], Tuple[float, float]]]:
    """
    Extract contour line segments for a single isovalue using Marching Squares.

    Returns:
        List of segments: [ ((x1, y1), (x2, y2)), ... ]
    """
    h, w = Z.shape
    if h < 2 or w < 2:
        return []

    # 4 corner arrays for all 2x2 cells
    tl = Z[:-1, :-1]
    tr = Z[:-1, 1:]
    br = Z[1:, 1:]
    bl = Z[1:, :-1]

    # Fast pruning: cell must cross the iso value
    cell_min = np.minimum(np.minimum(tl, tr), np.minimum(br, bl))
    cell_max = np.maximum(np.maximum(tl, tr), np.maximum(br, bl))
    active_mask = (cell_min <= iso_val) & (cell_max >= iso_val)

    rows, cols = np.where(active_mask)
    if len(rows) == 0:
        return []

    segments: List[Tuple[Tuple[float, float], Tuple[float, float]]] = []

    for r, c in zip(rows, cols):
        v0 = float(tl[r, c])  # Top-Left (c, r)
        v1 = float(tr[r, c])  # Top-Right (c+1, r)
        v2 = float(br[r, c])  # Bottom-Right (c+1, r+1)
        v3 = float(bl[r, c])  # Bottom-Left (c, r+1)

        # 4-bit binary index: bit0=TL, bit1=TR, bit2=BR, bit3=BL
        case_idx = 0
        if v0 >= iso_val:
            case_idx |= 1
        if v1 >= iso_val:
            case_idx |= 2
        if v2 >= iso_val:
            case_idx |= 4
        if v3 >= iso_val:
            case_idx |= 8

        if case_idx == 0 or case_idx == 15:
            continue

        # Cell vertex coordinates
        x_left = float(c)
        x_right = float(c + 1)
        y_top = float(r)
        y_bottom = float(r + 1)

        # Edge interpolation helpers (computed lazily as needed)
        def edge_top():
            return _interpolate_edge(x_left, y_top, v0, x_right, y_top, v1, iso_val)

        def edge_right():
            return _interpolate_edge(x_right, y_top, v1, x_right, y_bottom, v2, iso_val)

        def edge_bottom():
            return _interpolate_edge(x_left, y_bottom, v3, x_right, y_bottom, v2, iso_val)

        def edge_left():
            return _interpolate_edge(x_left, y_top, v0, x_left, y_bottom, v3, iso_val)

        # Marching squares case resolution
        if case_idx in (1, 14):
            segments.append((edge_top(), edge_left()))
        elif case_idx in (2, 13):
            segments.append((edge_top(), edge_right()))
        elif case_idx in (3, 12):
            segments.append((edge_left(), edge_right()))
        elif case_idx in (4, 11):
            segments.append((edge_right(), edge_bottom()))
        elif case_idx in (6, 9):
            segments.append((edge_top(), edge_bottom()))
        elif case_idx in (7, 8):
            segments.append((edge_left(), edge_bottom()))
        elif case_idx == 5:
            # Saddle point 1: resolve using center average
            center_val = (v0 + v1 + v2 + v3) * 0.25
            if center_val >= iso_val:
                segments.append((edge_top(), edge_left()))
                segments.append((edge_right(), edge_bottom()))
            else:
                segments.append((edge_top(), edge_right()))
                segments.append((edge_left(), edge_bottom()))
        elif case_idx == 10:
            # Saddle point 2
            center_val = (v0 + v1 + v2 + v3) * 0.25
            if center_val >= iso_val:
                segments.append((edge_top(), edge_right()))
                segments.append((edge_left(), edge_bottom()))
            else:
                segments.append((edge_top(), edge_left()))
                segments.append((edge_right(), edge_bottom()))

    return segments


def _stitch_segments_to_polylines(
    segments: List[Tuple[Tuple[float, float], Tuple[float, float]]],
    tolerance: float = 0.05,
) -> List[List[Dict[str, float]]]:
    """
    Connect unordered line segments into continuous polyline chains.

    Args:
        segments: List of ((x1, y1), (x2, y2))
        tolerance: Spatial tolerance for vertex snapping.

    Returns:
        List of continuous paths: [ [{"x": x, "y": y}, ...], ... ]
    """
    if not segments:
        return []

    # Quantize point helper for spatial hashing
    inv_tol = 1.0 / max(1e-4, tolerance)

    def quantize(pt: Tuple[float, float]) -> Tuple[int, int]:
        return int(round(pt[0] * inv_tol)), int(round(pt[1] * inv_tol))

    # Build adjacency graph
    # Node key -> list of (neighbor_key, original_neighbor_pt, seg_index)
    adj: Dict[Tuple[int, int], List[Tuple[Tuple[int, int], Tuple[float, float], int]]] = {}
    key_to_pt: Dict[Tuple[int, int], Tuple[float, float]] = {}

    for seg_idx, (p1, p2) in enumerate(segments):
        k1 = quantize(p1)
        k2 = quantize(p2)
        if k1 == k2:
            continue

        key_to_pt[k1] = p1
        key_to_pt[k2] = p2

        adj.setdefault(k1, []).append((k2, p2, seg_idx))
        adj.setdefault(k2, []).append((k1, p1, seg_idx))

    used_edges = set()
    polylines: List[List[Dict[str, float]]] = []

    # 1. Trace paths starting from endpoints (degree != 2)
    start_candidates = [k for k, neighbors in adj.items() if len(neighbors) != 2]
    # If all nodes have degree 2 (closed loops), start from any node
    if not start_candidates:
        start_candidates = list(adj.keys())

    for start_node in list(adj.keys()):
        for neighbor_node, neighbor_pt, seg_idx in adj[start_node]:
            if seg_idx in used_edges:
                continue

            # Start new path
            path: List[Tuple[float, float]] = [key_to_pt[start_node], neighbor_pt]
            used_edges.add(seg_idx)

            curr = neighbor_node
            while True:
                # Find next unused edge from curr
                next_step = None
                for nxt_node, nxt_pt, nxt_seg_idx in adj.get(curr, []):
                    if nxt_seg_idx not in used_edges:
                        next_step = (nxt_node, nxt_pt, nxt_seg_idx)
                        break

                if next_step is None:
                    break

                nxt_node, nxt_pt, nxt_seg_idx = next_step
                used_edges.add(nxt_seg_idx)
                path.append(nxt_pt)
                curr = nxt_node
                if curr == start_node:
                    break

            if len(path) >= 2:
                polylines.append([{"x": round(pt[0], 2), "y": round(pt[1], 2)} for pt in path])

    return polylines


def generate_contours(
    height_map: np.ndarray,
    num_levels: int = 10,
    scale_factor: float = 1.0,
) -> Dict[str, Any]:
    """
    Generate contour lines from a height/depth map.

    Uses marching squares algorithm to find iso-height contour lines.

    Args:
        height_map: 2D numpy array (H, W) of relative depth or height values.
        num_levels: Number of elevation contour levels to generate (default 10).
        scale_factor: Multiplier to convert relative height to absolute meters.

    Returns:
        Dictionary containing:
            - contour_levels: list of dicts, each with:
                - level_index: int
                - level_m: float (height in meters)
                - relative_level: float (normalized [0, 1])
                - is_index_contour: bool (True every 5th contour for major styling)
                - paths: list of polyline point lists [{"x": float, "y": float}, ...]
                - svg_path_d: str (SVG path data 'd' string for this level)
                - num_segments: int
            - svg_paths: str (combined SVG <path> elements for all levels)
            - min_height_m: float
            - max_height_m: float
            - height_span_m: float
            - num_contours: int (total number of discrete contour paths)
            - width: int (grid width)
            - height: int (grid height)
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

    # Convert to metric height grid
    Z = norm_h * float(scale_factor)
    min_h_m = float(np.min(Z))
    max_h_m = float(np.max(Z))
    h_span = max_h_m - min_h_m

    num_levels = max(2, min(50, int(num_levels)))

    # Compute iso-height levels with padding so contours don't hit extreme edges
    step = h_span / (num_levels + 1) if h_span > 1e-4 else 1.0
    iso_levels = [min_h_m + (i + 1) * step for i in range(num_levels)]

    contour_levels = []
    total_contours = 0
    all_svg_path_elements = []

    # Palette colors for elevation contours (dark-theme aesthetic)
    palette = [
        "#388bfd",  # blue
        "#58a6ff",  # light blue
        "#56d364",  # green
        "#3fb950",  # bright green
        "#d29922",  # amber
        "#e3b341",  # light amber
        "#f0883e",  # orange
        "#f85149",  # red
        "#db61a2",  # pink
        "#bc8cff",  # purple
    ]

    for idx, iso_val in enumerate(iso_levels):
        segments = _marching_squares_level(Z, iso_val)
        paths = _stitch_segments_to_polylines(segments)
        total_contours += len(paths)

        # Build SVG 'd' path string
        svg_d_parts = []
        for poly in paths:
            if len(poly) < 2:
                continue
            d_str = f"M {poly[0]['x']} {poly[0]['y']} " + " ".join(
                [f"L {pt['x']} {pt['y']}" for pt in poly[1:]]
            )
            svg_d_parts.append(d_str)

        level_svg_d = " ".join(svg_d_parts)
        is_index = (idx % 5 == 0)  # Major index contour every 5 levels
        color = palette[idx % len(palette)]
        stroke_width = "1.8" if is_index else "0.9"
        opacity = "0.95" if is_index else "0.75"

        if level_svg_d:
            all_svg_path_elements.append(
                f'<path d="{level_svg_d}" stroke="{color}" stroke-width="{stroke_width}" '
                f'fill="none" stroke-opacity="{opacity}" class="contour-level-{idx}" '
                f'data-elevation="{round(iso_val, 2)}" />'
            )

        contour_levels.append(
            {
                "level_index": idx,
                "level_m": round(float(iso_val), 3),
                "relative_level": round(float((iso_val - min_h_m) / max(1e-6, h_span)), 4),
                "is_index_contour": is_index,
                "color": color,
                "paths": paths,
                "svg_path_d": level_svg_d,
                "num_segments": len(paths),
            }
        )

    svg_paths_combined = "\n".join(all_svg_path_elements)

    logger.info(
        "Generated %d contour levels (%d total polylines) for %dx%d map, span: %.2fm to %.2fm",
        len(contour_levels),
        total_contours,
        w,
        h,
        min_h_m,
        max_h_m,
    )

    return {
        "contour_levels": contour_levels,
        "svg_paths": svg_paths_combined,
        "min_height_m": round(min_h_m, 3),
        "max_height_m": round(max_h_m, 3),
        "height_span_m": round(h_span, 3),
        "num_contours": total_contours,
        "width": w,
        "height": h,
    }


def compute_slope_aspect(
    height_map: np.ndarray,
    scale_factor: float = 1.0,
    pixel_size_m: float = 1.0,
) -> Dict[str, Any]:
    """
    Compute slope (steepness) and aspect (compass direction) maps from height data.
    Uses np.gradient for partial derivatives.

    Args:
        height_map: 2D numpy array (H, W) of relative depth or height values.
        scale_factor: Multiplier to convert relative height to absolute meters.
        pixel_size_m: Spatial resolution per pixel in meters (default 1.0m).

    Returns:
        Dictionary containing:
            - slope_map: np.ndarray (H, W) of slopes in degrees (0 to 90°)
            - aspect_map: np.ndarray (H, W) of aspects in degrees (0 to 360°, North=0°, East=90°, South=180°, West=270°)
            - slope_stats: dict with {mean, max, min, std}
            - aspect_stats: dict with {mean_deg, dominant_direction}
            - slope_histogram: list of 18 bins (5° each) with {bin_start, bin_end, count, percentage}
            - slope_classes: dict with percentage distribution:
                - flat_pct (<5°)
                - gentle_pct (5-15°)
                - moderate_pct (15-30°)
                - steep_pct (30-45°)
                - very_steep_pct (>45°)
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

    # Metric height grid
    Z = norm_h * float(scale_factor)
    px_size = max(1e-4, float(pixel_size_m))

    # Compute spatial partial derivatives (dz/dy along axis 0, dz/dx along axis 1)
    dz_dy, dz_dx = np.gradient(Z, px_size)

    # Slope computation: magnitude of gradient vector -> degrees
    grad_mag = np.sqrt(dz_dx ** 2 + dz_dy ** 2)
    slope_rad = np.arctan(grad_mag)
    slope_map = np.degrees(slope_rad).astype(np.float32)
    slope_map = np.clip(slope_map, 0.0, 90.0)

    # Aspect computation: compass azimuth direction facing downslope (0-360°)
    # np.arctan2(-dy, dx) converted to degrees 0-360
    aspect_rad = np.arctan2(-dz_dy, dz_dx)
    aspect_deg = np.degrees(aspect_rad)
    aspect_map = np.mod(aspect_deg + 360.0, 360.0).astype(np.float32)

    # For nearly flat terrain (slope < 0.5°), set aspect to 0
    flat_mask = slope_map < 0.5
    aspect_map[flat_mask] = 0.0

    # Slope statistical summary
    slope_stats = {
        "mean": round(float(np.mean(slope_map)), 2),
        "max": round(float(np.max(slope_map)), 2),
        "min": round(float(np.min(slope_map)), 2),
        "std": round(float(np.std(slope_map)), 2),
    }

    # 18-bin slope histogram (5° intervals from 0° to 90°)
    hist_counts, bin_edges = np.histogram(slope_map, bins=18, range=(0.0, 90.0))
    total_px = float(slope_map.size)
    slope_histogram = [
        {
            "bin_start": round(float(bin_edges[i]), 1),
            "bin_end": round(float(bin_edges[i + 1]), 1),
            "count": int(hist_counts[i]),
            "percentage": round(float(hist_counts[i] / total_px * 100.0), 2),
        }
        for i in range(len(hist_counts))
    ]

    # Standard GIS slope terrain classification
    flat_pct = float(np.mean(slope_map < 5.0) * 100.0)
    gentle_pct = float(np.mean((slope_map >= 5.0) & (slope_map < 15.0)) * 100.0)
    moderate_pct = float(np.mean((slope_map >= 15.0) & (slope_map < 30.0)) * 100.0)
    steep_pct = float(np.mean((slope_map >= 30.0) & (slope_map < 45.0)) * 100.0)
    very_steep_pct = float(np.mean(slope_map >= 45.0) * 100.0)

    slope_classes = {
        "flat_pct": round(flat_pct, 2),
        "gentle_pct": round(gentle_pct, 2),
        "moderate_pct": round(moderate_pct, 2),
        "steep_pct": round(steep_pct, 2),
        "very_steep_pct": round(very_steep_pct, 2),
    }

    # Dominant aspect direction
    non_flat_aspects = aspect_map[~flat_mask]
    if len(non_flat_aspects) > 0:
        mean_aspect = float(np.mean(non_flat_aspects))
        directions = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"]
        dir_idx = int(round(mean_aspect / 45.0)) % 8
        dominant_dir = directions[dir_idx]
    else:
        mean_aspect = 0.0
        dominant_dir = "Flat"

    return {
        "slope_map": slope_map,
        "aspect_map": aspect_map,
        "slope_stats": slope_stats,
        "aspect_stats": {
            "mean_deg": round(mean_aspect, 2),
            "dominant_direction": dominant_dir,
        },
        "slope_histogram": slope_histogram,
        "slope_classes": slope_classes,
    }


def contours_to_svg(
    contours: Dict[str, Any],
    width: Optional[int] = None,
    height: Optional[int] = None,
    bg_color: str = "#080a10",
) -> str:
    """
    Convert contour data dictionary into a complete standalone SVG document.

    Args:
        contours: Dictionary output from generate_contours().
        width: Optional SVG canvas width in pixels (defaults to contours['width']).
        height: Optional SVG canvas height in pixels (defaults to contours['height']).
        bg_color: Background color hex string (default dark theme '#080a10').

    Returns:
        Complete valid XML/SVG document string.
    """
    w = width or contours.get("width", 640)
    h = height or contours.get("height", 480)
    levels = contours.get("contour_levels", [])

    svg_lines = [
        f'<?xml version="1.0" encoding="UTF-8"?>',
        f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {w} {h}" width="{w}" height="{h}">',
        f'  <defs>',
        f'    <style>',
        f'      .contour-bg {{ fill: {bg_color}; }}',
        f'      .contour-text {{ fill: #c9d1d9; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, monospace; font-size: 10px; font-weight: 600; text-shadow: 0 1px 3px rgba(0,0,0,0.8); }}',
        f'    </style>',
        f'  </defs>',
        f'  <!-- Background -->',
        f'  <rect width="{w}" height="{h}" class="contour-bg" />',
        f'  <!-- Contour Lines -->',
        f'  <g id="contours" stroke-linecap="round" stroke-linejoin="round">',
    ]

    labels = []

    for lvl in levels:
        color = lvl.get("color", "#58a6ff")
        is_index = lvl.get("is_index_contour", False)
        stroke_width = "1.8" if is_index else "0.9"
        opacity = "0.95" if is_index else "0.75"
        elev_m = lvl.get("level_m", 0.0)

        for path in lvl.get("paths", []):
            if len(path) < 2:
                continue

            d_str = f"M {path[0]['x']} {path[0]['y']} " + " ".join(
                [f"L {pt['x']} {pt['y']}" for pt in path[1:]]
            )

            svg_lines.append(
                f'    <path d="{d_str}" stroke="{color}" stroke-width="{stroke_width}" '
                f'fill="none" stroke-opacity="{opacity}" />'
            )

            # Add elevation text label near middle of index contour paths
            if is_index and len(path) > 10:
                mid_pt = path[len(path) // 2]
                labels.append(
                    f'    <text x="{mid_pt["x"] + 2}" y="{mid_pt["y"] - 2}" '
                    f'class="contour-text">{round(elev_m, 1)}m</text>'
                )

    svg_lines.append('  </g>')

    # Add text labels on top
    if labels:
        svg_lines.append('  <!-- Elevation Labels -->')
        svg_lines.append('  <g id="labels">')
        svg_lines.extend(labels)
        svg_lines.append('  </g>')

    svg_lines.append('</svg>')
    return "\n".join(svg_lines)


def contours_to_dxf(contours: Dict[str, Any]) -> str:
    """
    Convert contour data to standard AutoCAD ASCII DXF format for CAD and GIS tools.

    Outputs AutoCAD Release 12 / 2000 compatible ASCII DXF with:
      - HEADER section
      - TABLES section (LAYER table)
      - ENTITIES section (3D LINE entities with X, Y, Z coordinates)

    Args:
        contours: Dictionary output from generate_contours().

    Returns:
        Complete ASCII DXF file content string.
    """
    levels = contours.get("contour_levels", [])

    lines: List[str] = [
        "0", "SECTION",
        "2", "HEADER",
        "9", "$ACADVER",
        "1", "AC1009",  # AutoCAD R11/R12 compatible
        "0", "ENDSEC",
        "0", "SECTION",
        "2", "TABLES",
        "0", "TABLE",
        "2", "LAYER",
        "70", str(max(1, len(levels))),
    ]

    # Define layer for each contour level
    for idx, lvl in enumerate(levels):
        layer_name = f"CONTOUR_{int(round(lvl.get('level_m', 0)))}M"
        lines.extend([
            "0", "LAYER",
            "2", layer_name,
            "70", "64",
            "62", str((idx % 7) + 1),  # AutoCAD color index 1-7
            "6", "CONTINUOUS",
        ])

    lines.extend([
        "0", "ENDTAB",
        "0", "ENDSEC",
        "0", "SECTION",
        "2", "ENTITIES",
    ])

    # Add 3D LINE entities for all contour segments
    for lvl in levels:
        elev_z = float(lvl.get("level_m", 0.0))
        layer_name = f"CONTOUR_{int(round(elev_z))}M"

        for path in lvl.get("paths", []):
            if len(path) < 2:
                continue

            for i in range(len(path) - 1):
                p1 = path[i]
                p2 = path[i + 1]

                lines.extend([
                    "0", "LINE",
                    "8", layer_name,
                    "10", f"{p1['x']:.3f}",   # Start X
                    "20", f"{p1['y']:.3f}",   # Start Y
                    "30", f"{elev_z:.3f}",   # Start Z (Elevation)
                    "11", f"{p2['x']:.3f}",   # End X
                    "21", f"{p2['y']:.3f}",   # End Y
                    "31", f"{elev_z:.3f}",   # End Z (Elevation)
                ])

    lines.extend([
        "0", "ENDSEC",
        "0", "EOF",
        "",
    ])

    return "\n".join(lines)
