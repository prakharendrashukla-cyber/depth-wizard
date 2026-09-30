"""Cloud identity checks use real RSA signatures, but never contact a cloud project."""
import io
import time
from types import SimpleNamespace
from uuid import uuid4

import httpx
import jwt
import pytest
from cryptography.hazmat.primitives.asymmetric import rsa
from fastapi import HTTPException
from fastapi.testclient import TestClient
from PIL import Image
from starlette.requests import Request

from app import database, supabase_identity as identity
from app.main import app


@pytest.fixture
def cloud(monkeypatch):
    monkeypatch.setenv("AUTH_PROVIDER", "supabase")
    monkeypatch.setenv("SUPABASE_URL", "https://example.supabase.co")
    monkeypatch.setenv("ALLOW_GUEST", "true")
    identity._attempts.clear()


@pytest.fixture
def signed(monkeypatch, cloud):
    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    monkeypatch.setattr(identity, "jwks_client", lambda _: SimpleNamespace(get_signing_key_from_jwt=lambda _: SimpleNamespace(key=key.public_key())))
    claims = dict(sub=str(uuid4()), iss="https://example.supabase.co/auth/v1", aud="authenticated", role="authenticated", iat=int(time.time()), exp=int(time.time()) + 60)
    return lambda **overrides: jwt.encode(claims | overrides, key, algorithm="RS256")


def test_valid_signed_token(signed):
    assert identity.verify_supabase_token(signed())["id"]


@pytest.mark.parametrize("override", [{"exp": 1}, {"iss": "https://attacker/auth/v1"}, {"aud": "anon"}, {"sub": "not-a-uuid"}, {"role": "service_role"}, {"is_anonymous": True}])
def test_rejects_bad_claims(signed, override):
    with pytest.raises(HTTPException) as caught:
        identity.verify_supabase_token(signed(**override))
    assert caught.value.status_code == 401


def test_bad_signature(signed):
    token = signed().split(".")
    token[2] = "a" * len(token[2])
    with pytest.raises(HTTPException) as caught:
        identity.verify_supabase_token(".".join(token))
    assert caught.value.status_code == 401


def request(headers=(), peer="judge", method="POST"):
    return Request({"type": "http", "method": method, "path": "/estimate", "client": (peer, 1), "headers": list(headers)})


def test_guest_budget_and_spoofed_ip(cloud, monkeypatch):
    monkeypatch.setenv("GUEST_REQUESTS_PER_MINUTE", "2")
    assert identity.processing_identity(request()) is None
    assert identity.processing_identity(request([(b"x-forwarded-for", b"new-ip")])) is None
    with pytest.raises(HTTPException) as caught:
        identity.processing_identity(request([(b"x-forwarded-for", b"another-ip")]))
    assert caught.value.status_code == 429
    assert identity.processing_identity(request(peer="different-judge")) is None


def test_invalid_bearer_does_not_become_guest(cloud):
    with pytest.raises(HTTPException) as caught:
        identity.processing_identity(request([(b"authorization", b"Bearer invalid")]))
    assert caught.value.status_code == 401


def test_legacy_verifies_online(cloud, monkeypatch):
    uid = str(uuid4())
    monkeypatch.setenv("SUPABASE_PUBLISHABLE_KEY", "test-publishable")
    token = jwt.encode({"sub": uid}, "a" * 32, algorithm="HS256")
    def get(_self, url, headers):
        assert url == "https://example.supabase.co/auth/v1/user"
        assert headers["Authorization"] == "Bearer " + token
        return httpx.Response(200, json={"id": uid})
    monkeypatch.setattr(httpx.Client, "get", get)
    assert identity.verify_supabase_token(token)["id"] == uid


def test_guest_estimate_does_not_persist_and_old_auth_is_disabled(cloud):
    image = io.BytesIO()
    Image.new("RGB", (32, 32), "green").save(image, "PNG")
    with TestClient(app, base_url="http://localhost") as client:
        response = client.post("/api/estimate", files={"image": ("guest.png", image.getvalue(), "image/png")})
        assert response.status_code == 200, response.text
        assert "analysis_id" not in response.json()
        assert client.get("/analyses").status_code == 404
        assert client.post("/api/auth/login", json={}).status_code == 404
        assert client.post("/estimate", headers={"Origin": "https://untrusted.invalid"}).status_code == 403
    with database.SessionLocal() as db:
        assert db.query(database.Analysis).count() == 0
