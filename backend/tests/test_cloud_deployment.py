import base64
import io

import numpy as np
import pytest
from fastapi.testclient import TestClient
from PIL import Image

from app.main import app


def test_public_runtime_config_rejects_privileged_key(monkeypatch):
    monkeypatch.setenv("AUTH_PROVIDER", "supabase")
    monkeypatch.setenv("SUPABASE_URL", "https://example.supabase.co")
    monkeypatch.setenv("SUPABASE_PUBLISHABLE_KEY", "sb_publishable_example")
    monkeypatch.setenv("SECRET_KEY", "never-publish-this-secret")
    client = TestClient(app)
    response = client.get("/app-config.js")
    assert response.status_code == 200
    assert response.headers["cache-control"] == "no-store"
    assert "sb_publishable_example" in response.text
    assert "never-publish" not in response.text
    monkeypatch.setenv("SUPABASE_PUBLISHABLE_KEY", "sb_secret_sensitive")
    denied = client.get("/app-config.js")
    assert denied.status_code == 503
    assert "sb_secret_sensitive" not in denied.text


def test_shadow_areas_require_horizontal_calibration(owner):
    pixels = np.zeros((16, 16), dtype=np.uint8)
    pixels[4:12, 4:12] = 255
    buffer = io.BytesIO()
    Image.fromarray(pixels).save(buffer, format="PNG")
    payload = {"depth_map_b64": base64.b64encode(buffer.getvalue()).decode(), "scale_factor": 10}
    client = TestClient(app)
    uncalibrated = client.post("/api/volume/shadow", json=payload)
    assert uncalibrated.status_code == 200
    data = uncalibrated.json()
    assert data["shadow_map_base64"]
    assert data["shadow_area_m2"] is None
    assert data["illuminated_area_m2"] is None
    assert data["shadow_pixels"] + data["illuminated_pixels"] == 256
    calibrated = client.post("/api/volume/shadow", json={**payload, "pixel_size_m": 2}).json()
    assert calibrated["shadow_area_m2"] + calibrated["illuminated_area_m2"] == pytest.approx(1024)
    assert client.post("/api/volume/shadow", json={**payload, "pixel_size_m": 0}).status_code == 422
