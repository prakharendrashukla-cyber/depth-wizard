"""Deterministic versions of the original numerical smoke scripts."""
import base64
import io
import struct

import numpy as np
import pytest
from PIL import Image

from app.calibration import apply_calibration, calibrate_from_gcps
from app.contour import compute_slope_aspect, contours_to_dxf, contours_to_svg, generate_contours
from app.height import analyze_height, generate_ply_file
from app.volume import compute_shadow_map, estimate_volume


def test_height_statistics_and_transects():
    depth = np.linspace(10, 100, 40_000, dtype=np.float32).reshape(200, 200)
    result = analyze_height(depth, scale_factor=50)
    assert result["raw_stats"]["min_depth"] == 10
    assert result["raw_stats"]["max_depth"] == 100
    assert result["calibrated_metrics"]["max_height_m"] == pytest.approx(44.5)
    assert sum(bin_["count"] for bin_ in result["histogram"]) == depth.size
    assert len(result["transects"]["horizontal"]) == 100
    assert result["transects"]["diagonal"][0] == 0
    assert result["transects"]["diagonal"][-1] == 1


def test_binary_ply_round_trip():
    positions = np.array([[0, 0, 0], [1, 2, 3], [-2, 5, 9]], dtype=np.float32)
    colors = np.eye(3, dtype=np.float32)
    header, payload = generate_ply_file(positions, colors).split(b"end_header\n", 1)
    assert b"format binary_little_endian 1.0" in header
    assert b"element vertex 3\n" in header
    vertices = list(struct.iter_unpack("<fffBBB", payload))
    np.testing.assert_allclose([v[:3] for v in vertices], positions)
    np.testing.assert_array_equal([v[3:] for v in vertices], colors * 255)


def test_gcp_scale_and_offset():
    depth = np.linspace(0, 100, 10_000, dtype=np.float32).reshape(100, 100)
    points = [(0, 0), (50, 50), (99, 99)]
    gcps = [{"x": x, "y": y, "known_height_m": 10 + 50 * float(depth[y, x]) / 100}
            for x, y in points]
    result = calibrate_from_gcps(depth, gcps)
    assert result["scale_factor"] == pytest.approx(50, abs=0.01)
    assert result["offset"] == pytest.approx(10, abs=0.01)
    assert result["r_squared"] > 0.99
    assert result["confidence"] == "high"
    calibrated = apply_calibration(depth, result["scale_factor"], result["offset"])
    np.testing.assert_allclose(calibrated[[0, 99], [0, 99]], [10, 60], atol=0.01)


@pytest.fixture
def hill():
    y, x = np.ogrid[-50:50, -50:50]
    return np.maximum(0, 50 - np.sqrt(x**2 + y**2)).astype(np.float32)


def test_contours_and_exports(hill):
    contours = generate_contours(hill, num_levels=8, scale_factor=100)
    assert len(contours["contour_levels"]) == 8
    assert contours["num_contours"] > 0
    svg = contours_to_svg(contours, width=400, height=400)
    assert "<path" in svg and "</svg>" in svg
    dxf = contours_to_dxf(contours)
    assert all(token in dxf for token in ["SECTION", "ENTITIES", "LINE", "EOF"])
    slopes = compute_slope_aspect(hill, scale_factor=100, pixel_size_m=1)
    assert slopes["slope_map"].shape == hill.shape
    assert slopes["aspect_map"].shape == hill.shape
    assert np.isfinite(slopes["slope_map"]).all()


def test_plateau_volume():
    plateau = np.zeros((100, 100), dtype=np.float32)
    plateau[25:75, 25:75] = 1
    volume = estimate_volume(plateau, scale_factor=10, ground_percentile=10, pixel_size_m=1)
    assert volume["total_volume_m3"] == pytest.approx(25_000)
    assert volume["above_ground_area_m2"] == pytest.approx(2_500)
    assert volume["max_height_above_ground_m"] == 10
    assert len(volume["volume_by_layer"]) == 10


def test_shadow_image(hill):
    shadow = compute_shadow_map(hill, sun_azimuth_deg=90, sun_elevation_deg=30,
                                scale_factor=50, pixel_size_m=1)
    assert shadow["shadow_mask"].shape == hill.shape
    assert 0 < shadow["shadow_percentage"] < 100
    with Image.open(io.BytesIO(base64.b64decode(shadow["shadow_map_base64"]))) as image:
        assert image.size == (100, 100)
