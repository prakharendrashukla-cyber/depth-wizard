import io
import pytest
from PIL import Image
from fastapi.testclient import TestClient
from app.main import app
from app.database import SessionLocal, User
from app.identity import configure_secret, password_matches
from sqlalchemy import select

def register(client, email="one@example.com"):
    return client.post("/auth/register", json={"email": email, "name": "User", "password": "password-123"})

def test_register_login_logout():
    with TestClient(app, base_url="http://localhost") as client:
        assert client.post("/estimate").status_code == 401
        response = register(client, "ONE@EXAMPLE.COM")
        assert response.status_code == 201
        cookie = response.headers["set-cookie"]
        assert "HttpOnly" in cookie and "SameSite=lax" in cookie and "Max-Age=604800" in cookie
        assert client.get("/auth/me").json()["email"] == "one@example.com"
        with SessionLocal() as db:
            user = db.scalar(select(User))
            assert user.password_hash != "password-123"
            assert password_matches(user.password_hash, "password-123")
        assert register(client).status_code == 409
        assert client.post("/auth/logout").status_code == 204
        assert client.get("/auth/me").status_code == 401
        assert client.post("/auth/login", json={"email":"one@example.com","password":"incorrect-password"}).status_code == 401
        assert client.post("/auth/login", json={"email":"one@example.com","password":"password-123"}).status_code == 200

def test_validation_and_rate_limit():
    with TestClient(app, base_url="http://localhost") as client:
        assert client.post("/auth/register", json={"email":"bad","password":"tiny","name":"User"}).status_code == 422
        for _ in range(9):
            register(client)
        assert register(client).status_code == 429

def test_cross_user_history():
    with TestClient(app, base_url="http://localhost") as a, TestClient(app, base_url="http://localhost") as b:
        register(a); register(b, "two@example.com")
        raw=io.BytesIO()
        Image.new("RGB",(32,32),"green").save(raw,format="PNG")
        response=a.post("/estimate",files={"image":("scene.png",raw.getvalue(),"image/png")})
        assert response.status_code == 200, response.text
        aid=response.json()["analysis_id"]
        assert a.get(f"/analyses/{aid}").status_code == 200
        assert b.get(f"/analyses/{aid}").status_code == 404
        assert b.delete(f"/analyses/{aid}").status_code == 404
        assert b.get("/analyses").json()["items"] == []

def test_production_secret_required(monkeypatch):
    monkeypatch.setenv("APP_ENV","production")
    monkeypatch.delenv("SECRET_KEY")
    with pytest.raises(RuntimeError, match="SECRET_KEY"):
        configure_secret()

def test_remote_cookie_and_origin():
    with TestClient(app, base_url="https://demo.example.com") as client:
        assert "Secure" in register(client).headers["set-cookie"]
        assert client.get("/auth/me").status_code == 200
        assert client.post("/auth/logout", headers={"Origin":"https://evil.example.com"}).status_code == 403


@pytest.mark.parametrize("path", [
    "/estimate", "/calibrate", "/contour", "/volume", "/volume/shadow",
    "/uncertainty", "/validate", "/export/ply", "/export/report", "/export/pdf",
])
def test_processing_requires_auth(path):
    with TestClient(app, base_url="http://localhost") as client:
        assert client.post(path).status_code == 401


@pytest.mark.parametrize("path", ["/estimate/video", "/batch"])
def test_optional_processing_is_disabled_by_default(path):
    with TestClient(app, base_url="http://localhost") as client:
        assert client.post(path).status_code == 403


def test_batch_ownership_survives_memory_expiry(monkeypatch):
    monkeypatch.setenv("ENABLE_BATCH_ANALYSIS", "true")
    from app.database import BatchJobRecord
    with TestClient(app, base_url="http://localhost") as a, TestClient(app, base_url="http://localhost") as b:
        register(a)
        register(b, "two@example.com")
        owner_id = a.get("/auth/me").json()["id"]
        with SessionLocal.begin() as db:
            db.add(BatchJobRecord(id="expired-job", user_id=owner_id, status="done"))
        for endpoint in ("status", "summary", "download"):
            assert b.get(f"/batch/expired-job/{endpoint}").status_code == 404
        status = a.get("/batch/expired-job/status")
        assert status.status_code == 200
        assert status.json()["artifacts_available"] is False
        assert a.get("/batch/expired-job/download").status_code == 410
