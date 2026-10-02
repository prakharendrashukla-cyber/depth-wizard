"""Gateway isolation and Cloud Run HTTPS checks without cloud credentials."""
import asyncio

import httpx
from fastapi import HTTPException

from app import gateway_server as gateway


def test_gateway_auth_origin_and_cookie_isolation(monkeypatch):
    monkeypatch.setattr(gateway, "BACKEND_URL", "https://private.example")
    monkeypatch.setattr(gateway, "SUPABASE_URL", "https://example.supabase.co")
    monkeypatch.setattr(gateway, "PUBLISHABLE_KEY", "sb_publishable_test")
    monkeypatch.setattr(gateway, "PUBLIC_ORIGIN", "https://gateway.example")

    def identity(token):
        if token != "user-token":
            raise HTTPException(401, "Invalid session")
        return {"id": "test-user"}

    async def iap_token():
        return "service-token"

    forwarded = []

    async def backend(request):
        assert request.headers["authorization"] == "Bearer user-token"
        assert request.headers["proxy-authorization"] == "Bearer service-token"
        assert "cookie" not in request.headers
        assert "x-goog-iap-jwt-assertion" not in request.headers
        forwarded.append(request)

        class Body(httpx.AsyncByteStream):
            async def __aiter__(self):
                yield b'{"ok":true}'

        return httpx.Response(200, stream=Body(), headers={
            "content-type": "application/json", "set-cookie": "backend=session",
        })

    monkeypatch.setattr(gateway, "verify_supabase_token", identity)
    monkeypatch.setattr(gateway, "_create_iap_jwt", iap_token)

    async def verify():
        async with gateway.lifespan(gateway.app):
            await gateway._proxy_client.aclose()
            gateway._proxy_client = httpx.AsyncClient(transport=httpx.MockTransport(backend))
            # Cloud Run terminates HTTPS before the HTTP container connection.
            async with httpx.AsyncClient(transport=httpx.ASGITransport(app=gateway.app), base_url="http://gateway.example") as client:
                assert (await client.get("/api/models")).status_code == 401
                assert (await client.get("/api/models", headers={"authorization": "Bearer bad"})).status_code == 401
                headers = {"authorization": "Bearer user-token", "origin": "https://gateway.example",
                           "cookie": "browser=session", "x-goog-iap-jwt-assertion": "spoofed"}
                # The second call must also strip cookies cached by the proxy client.
                for _ in range(2):
                    response = await client.post("/api/estimate", headers=headers, content=b"sample")
                    assert response.status_code == 200
                    assert "set-cookie" not in response.headers
                assert len(forwarded) == 2
                assert str(forwarded[0].url) == "https://private.example/api/estimate"
                assert (await client.post("/api/estimate", headers={**headers, "origin": "https://other.example"})).status_code == 403
                assert (await client.get("/api/auth/me", headers=headers)).status_code == 404
                assert (await client.get("/health")).status_code == 200
                config = await client.get("/app-config.js")
                assert '"analysisRequiresLogin": true' in config.text
                assert "service-token" not in config.text

    asyncio.run(verify())
