"""Inference and endpoint checks without a running server or model downloads."""
import base64
import io
import os
import time

import numpy as np
import pytest
from app import main
from app.depth import DepthEstimator, colorize_depth, list_available_models
from app.main import app
from app.mesh import depth_to_point_cloud
from fastapi.testclient import TestClient
from PIL import Image


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


def test_available_models_separates_implementation_from_cached_weights(monkeypatch):
    monkeypatch.setattr("app.depth._model_dependencies_installed", lambda model_type: True)
    monkeypatch.setattr("app.depth._model_weights_cached", lambda model_id, info: False)
    models = {entry["id"]: entry for entry in list_available_models()}
    assert models["depth-anything-v2-small"]["available"] is True
    assert models["depth-anything-v2-small"]["weights_cached"] is False
    assert models["metric3d"]["available"] is False
    assert models["metric3d"]["unavailable_reason"]
    availability = {model_id: entry["available"] for model_id, entry in models.items()}
    assert availability["procedural-fallback"] is True
    assert availability["metric3d"] is False


def test_failed_explicit_model_switch_keeps_actual_model(monkeypatch):
    estimator = DepthEstimator("procedural-fallback")

    def fail_load(self, hf_id, model_id):
        raise OSError("weights unavailable")

    monkeypatch.setattr(DepthEstimator, "_load_depth_anything", fail_load)
    with pytest.raises(OSError, match="weights unavailable"):
        estimator.load_model("depth-anything-v2-small")
    assert estimator.model_id == "procedural-fallback"
    assert estimator.model_name == "procedural-fallback"


def test_unknown_estimator_id_does_not_run_procedural(scene):
    estimator = DepthEstimator("procedural-fallback")
    estimator.model_id = "not-a-registered-model"
    with pytest.raises(RuntimeError, match="unknown model id"):
        estimator.estimate(scene)


def test_unimplemented_metric3d_is_not_advertised_or_substituted():
    estimator = DepthEstimator("procedural-fallback")
    with pytest.raises(NotImplementedError, match="metric3d.*not implemented"):
        estimator.load_model("metric3d")
    assert estimator.model_id == "procedural-fallback"


def test_api_model_switch_reports_load_failure_without_replacing_estimator(monkeypatch):
    current = DepthEstimator("procedural-fallback")
    monkeypatch.setattr(main, "estimator", current)

    def fail_init(self, model_id=None):
        raise OSError("weights are not cached")

    monkeypatch.setattr(DepthEstimator, "__init__", fail_init)
    with pytest.raises(Exception) as exc_info:
        main.get_estimator("depth-anything-v2-small")
    assert getattr(exc_info.value, "status_code", None) == 503
    assert "no alternate model was selected" in str(exc_info.value.detail)
    assert main.estimator is current
    assert current.model_id == "procedural-fallback"


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
