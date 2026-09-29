import io
import os
import time
from concurrent.futures import ThreadPoolExecutor
from unittest.mock import patch
import numpy as np
import pytest
from PIL import Image
from fastapi import HTTPException
from fastapi.testclient import TestClient
os.environ["DEPTH_MODEL"] = "procedural-fallback"
from app import main
from app.depth import DepthEstimator
from app.safety import safe_path
from app.batch import BatchProcessor

@pytest.fixture
def client(owner):
    with TestClient(main.app, base_url="http://localhost", raise_server_exceptions=False) as client:
        yield client

def png():
    buf = io.BytesIO()
    Image.new("RGB", (20, 20), "red").save(buf, format="PNG")
    return buf.getvalue()

def test_paths(tmp_path):
    assert safe_path(tmp_path, "file.png") == str(tmp_path / "file.png")
    for name in ["../secret", str(tmp_path.parent / "secret")]:
        with pytest.raises(HTTPException) as error:
            safe_path(tmp_path, name)
        assert error.value.status_code == 404

def test_api_and_cors(client):
    assert client.get("/health").status_code == 200
    assert client.get("/api/does-not-exist").status_code == 404
    assert client.get("/estimate/missing").status_code == 404
    r = client.options("/estimate", headers={"Origin": "http://localhost:5173", "Access-Control-Request-Method": "POST"})
    assert r.headers["access-control-allow-origin"] == "http://localhost:5173"
    r = client.options("/estimate", headers={"Origin": "https://other.example", "Access-Control-Request-Method": "POST"})
    assert "access-control-allow-origin" not in r.headers

def test_uploads(client, monkeypatch):
    assert client.post("/estimate", files={"image": ("x.txt", b"bad", "text/plain")}).status_code == 415
    assert client.post("/estimate", files={"image": ("x.png", b"bad", "image/png")}).status_code == 415
    monkeypatch.setattr("app.safety.IMAGE_LIMIT", 10)
    assert client.post("/estimate", files={"image": ("x.png", png(), "image/png")}).status_code == 413
    assert client.post("/estimate/video", files={"video": ("x.mp4", b"bad", "video/mp4")}).status_code == 415
    r = client.post("/estimate", content=b"x", headers={"Content-Length": str(200*1024*1024)})
    assert r.status_code == 413

def test_estimate_and_failed_switch(client):
    r = client.post("/estimate", files={"image": ("x.png", png(), "image/png")}, data={"model": "procedural-fallback"})
    assert r.status_code == 200, r.text
    assert r.json()["point_cloud"]["count"] > 0
    previous = main.estimator
    with patch.object(main, "DepthEstimator", side_effect=RuntimeError("secret internals")):
        r = client.post("/estimate", files={"image": ("x.png", png(), "image/png")}, data={"model": "midas-small"})
    assert r.status_code == 500
    assert "secret internals" not in r.text
    assert main.estimator is previous

def test_model_switch_keeps_instance():
    est = DepthEstimator("procedural-fallback")
    with patch.object(est, "_load_midas", side_effect=RuntimeError("failed")):
        # Candidate loads on a new instance.
        with patch.object(DepthEstimator, "_load_midas", side_effect=RuntimeError("failed")):
            with pytest.raises(RuntimeError):
                est.load_model("midas-small")
    assert est.model_id == "procedural-fallback"
    assert np.isfinite(est.estimate(Image.new("RGB", (16,16)))).all()

def test_concurrent_model_snapshots():
    with ThreadPoolExecutor(max_workers=4) as pool:
        models = list(pool.map(lambda _: main.get_estimator("procedural-fallback"), range(8)))
    assert all(m.model_id == "procedural-fallback" for m in models)

def test_batch_expiry():
    bp = BatchProcessor()
    job = bp.create_job([("x.png", png())])
    bp.process_job(job, DepthEstimator("procedural-fallback"))
    assert job not in bp._job_images
    bp.jobs[job].expires_at = time.time() - 1
    bp.cleanup()
    assert job not in bp.jobs
