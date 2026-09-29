"""
Unit tests for the new Depth Wizard backend modules:
1. app.calibration
2. app.contour
3. app.volume
"""

import sys
import numpy as np

# ── Test 1: Calibration Engine ───────────────────────────────────────────────
print("=== 1. Testing app.calibration ===")
from app.calibration import calibrate_from_gcps, apply_calibration

# Create synthetic 100x100 ramp
depth_map = np.linspace(0.0, 100.0, 10000).reshape(100, 100).astype(np.float32)

# Known formula: height = 50.0 * norm_depth + 10.0
# At (x=0, y=0) -> norm_depth=0.0 -> height=10.0
# At (x=99, y=99) -> norm_depth=1.0 -> height=60.0
# At (x=50, y=50) -> norm_depth=0.505 -> height=35.25
gcps = [
    {"x": 0, "y": 0, "known_height_m": 10.0},
    {"x": 50, "y": 50, "known_height_m": 35.25},
    {"x": 99, "y": 99, "known_height_m": 60.0},
]

calib_res = calibrate_from_gcps(depth_map, gcps)
print(f"  Calibration fit: scale={calib_res['scale_factor']}, offset={calib_res['offset']}, R²={calib_res['r_squared']}, RMSE={calib_res['rmse']}")
assert abs(calib_res["scale_factor"] - 50.0) < 0.2, f"Scale factor unexpected: {calib_res['scale_factor']}"
assert abs(calib_res["offset"] - 10.0) < 0.2, f"Offset unexpected: {calib_res['offset']}"
assert calib_res["r_squared"] > 0.99, f"R² unexpected: {calib_res['r_squared']}"
assert calib_res["confidence"] == "high"
assert len(calib_res["residuals"]) == 3

# Test apply_calibration
calibrated_grid = apply_calibration(depth_map, calib_res["scale_factor"], calib_res["offset"])
assert calibrated_grid.shape == (100, 100)
assert abs(calibrated_grid[0, 0] - 10.0) < 0.2
assert abs(calibrated_grid[99, 99] - 60.0) < 0.2
print("  [PASS] Calibration Engine tested successfully.")

# ── Test 2: Contour Generator ───────────────────────────────────────────────
print("\n=== 2. Testing app.contour ===")
from app.contour import generate_contours, compute_slope_aspect, contours_to_svg, contours_to_dxf

# Create synthetic cone / hill
y, x = np.ogrid[-50:50, -50:50]
r = np.sqrt(x**2 + y**2)
hill = np.maximum(0, 50 - r).astype(np.float32)

contours = generate_contours(hill, num_levels=8, scale_factor=100.0)
assert "contour_levels" in contours
assert len(contours["contour_levels"]) == 8
assert contours["num_contours"] > 0
assert "<path" in contours["svg_paths"]
print(f"  Generated {contours['num_contours']} contours across {len(contours['contour_levels'])} levels.")

# Test Slope & Aspect
slope_aspect = compute_slope_aspect(hill, scale_factor=100.0, pixel_size_m=1.0)
assert "slope_map" in slope_aspect
assert "aspect_map" in slope_aspect
assert slope_aspect["slope_map"].shape == (100, 100)
assert slope_aspect["aspect_map"].shape == (100, 100)
assert "slope_stats" in slope_aspect
assert "slope_classes" in slope_aspect
print(f"  Slope stats: mean={slope_aspect['slope_stats']['mean']}°, max={slope_aspect['slope_stats']['max']}°")
print(f"  Slope classes: {slope_aspect['slope_classes']}")

# Test SVG generation
svg_doc = contours_to_svg(contours, width=400, height=400)
assert svg_doc.startswith('<?xml version="1.0"')
assert '<svg xmlns="http://www.w3.org/2000/svg"' in svg_doc
assert '</svg>' in svg_doc
print(f"  SVG Export: {len(svg_doc)} characters.")

# Test DXF generation
dxf_doc = contours_to_dxf(contours)
assert "SECTION" in dxf_doc
assert "HEADER" in dxf_doc
assert "ENTITIES" in dxf_doc
assert "LINE" in dxf_doc
assert "EOF" in dxf_doc
print(f"  DXF Export: {len(dxf_doc)} characters.")
print("  [PASS] Contour Generator tested successfully.")

# ── Test 3: Volume & Shadow Analysis ─────────────────────────────────────────
print("\n=== 3. Testing app.volume ===")
from app.volume import estimate_volume, compute_shadow_map

# Test volume for a 100x100 plateau of 10m height on 1m resolution
plateau = np.zeros((100, 100), dtype=np.float32)
plateau[25:75, 25:75] = 1.0  # 50x50 = 2500 pixels at height 1.0

vol = estimate_volume(plateau, scale_factor=10.0, ground_percentile=10.0, pixel_size_m=1.0)
print(f"  Volume: total={vol['total_volume_m3']} m³, elevated_area={vol['above_ground_area_m2']} m²")
assert vol["total_volume_m3"] > 20000.0, f"Volume should be ~25000 m³, got {vol['total_volume_m3']}"
assert len(vol["volume_by_layer"]) == 10
assert vol["max_height_above_ground_m"] == 10.0

# Test shadow casting
# Hill with sun at 45° elevation from East (90° azimuth)
shadow = compute_shadow_map(hill, sun_azimuth_deg=90.0, sun_elevation_deg=30.0, scale_factor=50.0, pixel_size_m=1.0)
assert "shadow_mask" in shadow
assert shadow["shadow_mask"].shape == (100, 100)
assert shadow["shadow_percentage"] > 0.0
assert len(shadow["shadow_map_base64"]) > 50
print(f"  Shadow computation: {shadow['shadow_percentage']}% in shadow, base64 PNG len={len(shadow['shadow_map_base64'])}")
print("  [PASS] Volume & Shadow Analysis tested successfully.")

print("\n=======================================================")
print("  ALL 3 MODULES CREATED AND FULLY VALIDATED! (100% PASS)")
print("=======================================================")
