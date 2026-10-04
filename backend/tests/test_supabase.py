"""Cloud identity checks use real RSA signatures, but never contact a cloud project."""
import base64
import io
import time
import asyncio
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

from app import database, main, quotas, supabase_identity as identity, supabase_admin
from app.main import app
from app.identity import get_current_user


@pytest.fixture
def cloud(monkeypatch):
    monkeypatch.setenv("AUTH_PROVIDER", "supabase")
    monkeypatch.setenv("SUPABASE_URL", "https://example.supabase.co")


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


def test_cloud_guest_is_never_a_processing_identity(cloud):
    for req in (request(), request([(b"x-forwarded-for", b"spoofed-ip")])):
        with pytest.raises(HTTPException) as caught:
            identity.processing_identity(req)
        assert caught.value.status_code == 401


def test_invalid_bearer_does_not_become_guest(cloud):
    with pytest.raises(HTTPException) as caught:
        identity.processing_identity(request([(b"authorization", b"Bearer invalid")]))
    assert caught.value.status_code == 401


def test_quota_ip_uses_trusted_forwarded_suffix_and_hashes_address(monkeypatch):
    monkeypatch.setenv("TRUSTED_PROXY_HOPS", "1")
    one_proxy = request([(b"x-forwarded-for", b"203.0.113.200, 198.51.100.7")], peer="10.0.0.1")
    assert quotas._client_ip(one_proxy) == "198.51.100.7"

    monkeypatch.setenv("TRUSTED_PROXY_HOPS", "2")
    two_proxies = request(
        [(b"x-forwarded-for", b"203.0.113.200, 198.51.100.7, 192.0.2.20")],
        peer="10.0.0.1",
    )
    assert quotas._client_ip(two_proxies) == "198.51.100.7"
    digest = quotas._ip_hash(two_proxies, "server-secret")
    assert len(digest) == 64
    assert "198.51.100.7" not in digest


def test_quota_ip_falls_back_to_direct_peer_when_forwarded_chain_is_short(monkeypatch):
    monkeypatch.setenv("TRUSTED_PROXY_HOPS", "2")
    req = request([(b"x-forwarded-for", b"198.51.100.7")], peer="10.0.0.1")
    assert quotas._client_ip(req) == "10.0.0.1"


def test_postprocessing_routes_reserve_the_shared_cloud_quota(cloud, monkeypatch):
    user_id = str(uuid4())
    reservations = []

    async def reserve(_request, reserved_user):
        reservations.append(reserved_user)

    monkeypatch.setattr(main, "reserve_analysis", reserve)
    monkeypatch.setattr(main, "track_task", lambda coroutine: coroutine.close())
    app.dependency_overrides[get_current_user] = lambda: {"id": user_id}
    buffer = io.BytesIO()
    Image.new("L", (16, 16), 10).save(buffer, format="PNG")
    payload = {"depth_map_b64": base64.b64encode(buffer.getvalue()).decode()}

    response = TestClient(app).post("/api/volume", json=payload, headers={"Authorization": "Bearer test-token"})
    assert response.status_code == 200, response.text
    assert reservations == [user_id]


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


def test_unauthenticated_estimate_is_rejected_before_processing(cloud):
    image = io.BytesIO()
    Image.new("RGB", (32, 32), "green").save(image, "PNG")
    with TestClient(app, base_url="http://localhost") as client:
        response = client.post("/api/estimate", files={"image": ("guest.png", image.getvalue(), "image/png")})
        assert response.status_code == 401, response.text
        assert client.get("/analyses").status_code == 404
        assert client.post("/api/auth/login", json={}).status_code == 404
        assert client.post("/estimate", headers={"Authorization": "Bearer invalid", "Origin": "https://untrusted.invalid"}).status_code == 403
        assert client.post("/api/estimate/video", headers={"Authorization": "Bearer invalid"}).status_code == 403
        assert client.post("/api/batch", headers={"Authorization": "Bearer invalid"}).status_code == 403
    with database.SessionLocal() as db:
        assert db.query(database.Analysis).count() == 0


def test_account_deletion_removes_all_paginated_files_before_auth_user(monkeypatch):
    user_id = str(uuid4())
    rows = [{"id": str(uuid4()), "image_path": f"{user_id}/{index}.jpg"} for index in range(101)]
    initial_count = len(rows)
    deleted_objects = []
    deletion_events = []
    monkeypatch.setattr(supabase_admin, "_credentials", lambda: ("https://example.supabase.co", "service-test-key"))

    class FakeResponse:
        def __init__(self, status_code=200, payload=None):
            self.status_code = status_code
            self.payload = payload

        def json(self):
            return self.payload

    class FakeAsyncClient:
        def __init__(self, **_kwargs):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *_args):
            return None

        async def get(self, url, **_kwargs):
            assert url.endswith("/rest/v1/analyses")
            return FakeResponse(payload=rows[:100])

        async def request(self, method, url, **kwargs):
            assert method == "DELETE" and "/storage/v1/object/depth-wizard" in url
            deleted_objects.extend(kwargs["json"]["prefixes"])
            deletion_events.append("files")
            return FakeResponse(status_code=200, payload={})

        async def delete(self, url, params=None, **_kwargs):
            if url.endswith("/rest/v1/analyses"):
                assert params["user_id"] == f"eq.{user_id}"
                expression = params["id"]
                ids = set(expression[4:-1].split(","))
                deletion_events.append("rows")
                rows[:] = [row for row in rows if row["id"] not in ids]
                return FakeResponse(status_code=204)
            assert url.endswith(f"/auth/v1/admin/users/{user_id}")
            deletion_events.append("user")
            return FakeResponse(status_code=204)

    monkeypatch.setattr(supabase_admin.httpx, "AsyncClient", FakeAsyncClient)
    asyncio.run(supabase_admin.delete_account_data(user_id))

    assert len(deleted_objects) == initial_count
    assert rows == []
    assert deletion_events[-1] == "user"
    assert deletion_events.index("files") < deletion_events.index("rows") < deletion_events.index("user")
