"""Inference and endpoint checks without a running server or model downloads."""
import base64
import io
import os
import time

import numpy as np
import pytest
from fastapi.testclient import TestClient
from PIL import Image

from app.depth import DepthEstimator, colorize_depth
from app.main import app
from app.mesh import depth_to_point_cloud


@pytest.fixture
def scene():
    ramp = np.tile(np.arange(64, dtype=np.uint8) * 4, (48, 1))
    return Image.fromarray(np.stack([ramp, ramp, ramp], axis=-1))


def test_procedural_inference(scene):
    estimator = DepthEstimator("procedural-fallback")
    depth = estimator.estimate(scene)
    assert depth.shape == (48, 64)
    assert np.isfinite(depth).all()
    assert float(np.ptp(depth)) > 0
    assert colorize_depth(depth).size == scene.size
    positions, colors = depth_to_point_cloud(scene, depth, step=2)
    assert positions.shape == colors.shape == (24 * 32, 3)
    assert np.isfinite(positions).all()
    assert ((colors >= 0) & (colors <= 1)).all()


def test_estimate_payload_and_timings(owner, scene):
    image = io.BytesIO()
    scene.save(image, format="PNG")
    with TestClient(app, base_url="http://localhost") as client:
        started = time.perf_counter()
        response = client.post("/api/estimate", files={"image": ("scene.png", image.getvalue(), "image/png")})
        elapsed = time.perf_counter() - started
    assert response.status_code == 200, response.text
    result = response.json()
    cloud = result["point_cloud"]
    for name in ("positions", "colors"):
        values = np.frombuffer(base64.b64decode(cloud[name]), dtype=np.float32)
        assert values.size == cloud["count"] * 3
        assert np.isfinite(values).all()
    with Image.open(io.BytesIO(base64.b64decode(result["depth_map"]))) as depth_image:
        assert depth_image.size == scene.size
    for name in ("depth_time_s", "pointcloud_time_s", "height_time_s"):
        assert 0 <= result["metadata"][name] <= elapsed


@pytest.mark.neural
@pytest.mark.skipif(os.getenv("RUN_NEURAL_TESTS") != "1", reason="Set RUN_NEURAL_TESTS=1 to download/load real model weights")
def test_neural_model_inference(scene):
    pytest.importorskip("torch")
    pytest.importorskip("transformers")
    estimator = DepthEstimator("depth-anything-v2-small")
    assert estimator.model_id == "depth-anything-v2-small"
    depth = estimator.estimate(scene)
    assert depth.shape == (48, 64)
    assert np.isfinite(depth).all()
