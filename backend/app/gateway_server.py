"""Public static frontend and authenticated proxy to the private Cloud Run API."""
import asyncio
import json
import logging
import os
import time
from contextlib import asynccontextmanager
from pathlib import Path
from urllib.parse import quote

import httpx
from fastapi import FastAPI, HTTPException, Request
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import FileResponse, JSONResponse, Response, StreamingResponse
from fastapi.staticfiles import StaticFiles
from starlette.background import BackgroundTask

from app.supabase_identity import verify_supabase_token

logger = logging.getLogger("depth_wizard.gateway")
logging.basicConfig(level=logging.INFO)

BACKEND_URL = os.getenv("PRIVATE_BACKEND_URL", "").rstrip("/")
SUPABASE_URL = os.getenv("SUPABASE_URL", "").rstrip("/")
PUBLISHABLE_KEY = os.getenv("SUPABASE_PUBLISHABLE_KEY", "")
PUBLIC_ORIGIN = os.getenv("GATEWAY_PUBLIC_ORIGIN", "").rstrip("/")
FRONTEND_DIST = Path(__file__).resolve().parents[1] / "frontend" / "dist"
MAX_REQUEST_BYTES = int(os.getenv("GATEWAY_MAX_REQUEST_BYTES", str(100 * 1024 * 1024)))
IAP_JWT_TTL = 300

_proxy_client: httpx.AsyncClient | None = None
_iap_jwt: str | None = None
_iap_jwt_expiry = 0
_iap_jwt_lock = asyncio.Lock()

_API_ROOTS = {
    "models", "benchmarks", "samples", "estimate", "calibrate", "contour",
    "volume", "uncertainty", "validate", "export", "health",
}
_SAFE_RESPONSE_HEADERS = {
    "cache-control", "content-disposition", "content-encoding", "content-length",
    "content-type", "etag", "last-modified", "retry-after",
}
_HOP_HEADERS = {
    "connection", "keep-alive", "proxy-authenticate", "proxy-authorization",
    "te", "trailer", "transfer-encoding", "upgrade", "host", "content-length",
    "origin", "x-forwarded-for", "x-forwarded-host", "x-forwarded-proto", "x-goog-iap-jwt-assertion",
}


async def _create_iap_jwt() -> str:
    """Create a short-lived, service-account-signed JWT accepted by IAP."""
    global _iap_jwt, _iap_jwt_expiry
    now = int(time.time())
    if _iap_jwt and now < _iap_jwt_expiry - 30:
        return _iap_jwt
    async with _iap_jwt_lock:
        now = int(time.time())
        if _iap_jwt and now < _iap_jwt_expiry - 30:
            return _iap_jwt
        if not BACKEND_URL or not BACKEND_URL.startswith("https://"):
            raise HTTPException(503, "The private analysis service is not configured")
        metadata_headers = {"Metadata-Flavor": "Google"}
        async with httpx.AsyncClient(timeout=5) as client:
            try:
                email_response = await client.get(
                    "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/email",
                    headers=metadata_headers,
                )
                email_response.raise_for_status()
                service_account = email_response.text.strip()
                token_response = await client.get(
                    "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token",
                    headers=metadata_headers,
                )
                token_response.raise_for_status()
                access_token = token_response.json()["access_token"]
                payload = {
                    "iss": service_account,
                    "sub": service_account,
                    "aud": BACKEND_URL + "/*",
                    "iat": now,
                    "exp": now + IAP_JWT_TTL,
                }
                url = "https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/" + quote(service_account, safe="@.-_") + ":signJwt"
                signed = await client.post(
                    url,
                    headers={"Authorization": "Bearer " + access_token},
                    json={"payload": json.dumps(payload, separators=(",", ":"))},
                )
                if signed.status_code in (401, 403):
                    logger.error("Gateway service identity cannot sign its IAP request token")
                    raise HTTPException(503, "The private analysis connection is not authorized")
                signed.raise_for_status()
                _iap_jwt = signed.json()["signedJwt"]
                _iap_jwt_expiry = now + IAP_JWT_TTL
                return _iap_jwt
            except HTTPException:
                raise
            except (httpx.HTTPError, KeyError, ValueError) as exc:
                logger.warning("Could not create private-service request token: %s", type(exc).__name__)
                raise HTTPException(503, "The private analysis service is temporarily unavailable") from exc


async def _proxy(request: Request, suffix: str = ""):
    if request.method == "OPTIONS":
        return Response(status_code=204)
    if not SUPABASE_URL or not PUBLISHABLE_KEY:
        raise HTTPException(503, "Sign-in is not configured")
    if not BACKEND_URL:
        raise HTTPException(503, "The private analysis service is not configured")

    authorization = request.headers.get("authorization", "")
    scheme, _, user_token = authorization.partition(" ")
    if scheme.lower() != "bearer" or not user_token.strip():
        raise HTTPException(401, "Please sign in to run analysis")
    await run_in_threadpool(verify_supabase_token, user_token.strip())

    api_root = suffix.split("/", 1)[0]
    if api_root not in _API_ROOTS or any(part in {".", ".."} for part in suffix.split("/")):
        raise HTTPException(404, "API endpoint not found")

    origin = request.headers.get("origin")
    # Cloud Run terminates TLS before the container; its base URL can be HTTP.
    expected_origin = PUBLIC_ORIGIN or str(request.base_url).rstrip("/")
    if origin and origin.rstrip("/") != expected_origin:
        raise HTTPException(403, "Cross-origin API requests are not allowed")

    try:
        declared_length = int(request.headers.get("content-length", "0"))
    except ValueError:
        raise HTTPException(400, "Invalid request size") from None
    if declared_length > MAX_REQUEST_BYTES:
        raise HTTPException(413, "Request is too large")
    body = await request.body()
    if len(body) > MAX_REQUEST_BYTES:
        raise HTTPException(413, "Request is too large")

    safe_headers = {
        name: value for name, value in request.headers.items()
        if name.lower() not in _HOP_HEADERS and name.lower() != "cookie"
    }
    try:
        safe_headers["proxy-authorization"] = "Bearer " + await _create_iap_jwt()
        path = "/api" + ("/" + suffix if suffix else "")
        target = BACKEND_URL + path
        if request.url.query:
            target += "?" + request.url.query
        assert _proxy_client is not None
        outgoing = _proxy_client.build_request(
            request.method,
            target,
            headers=safe_headers,
            content=body,
        )
        # A shared httpx client may have cached a prior backend Set-Cookie.
        outgoing.headers.pop("cookie", None)
        response = await _proxy_client.send(outgoing, stream=True)
        response_headers = {
            name: value for name, value in response.headers.items()
            if name.lower() in _SAFE_RESPONSE_HEADERS
        }
        return StreamingResponse(
            response.aiter_raw(),
            status_code=response.status_code,
            headers=response_headers,
            background=BackgroundTask(response.aclose),
        )
    except HTTPException:
        raise
    except httpx.HTTPError as exc:
        logger.warning("Private analysis request failed: %s", type(exc).__name__)
        raise HTTPException(502, "The private analysis service could not complete this request") from exc


@asynccontextmanager
async def lifespan(app: FastAPI):
    global _proxy_client
    timeout = httpx.Timeout(1800, connect=30)
    _proxy_client = httpx.AsyncClient(timeout=timeout, follow_redirects=False)
    yield
    await _proxy_client.aclose()
    _proxy_client = None


app = FastAPI(title="Depth Wizard Gateway", docs_url=None, redoc_url=None, openapi_url=None, lifespan=lifespan)


@app.get("/health", include_in_schema=False)
async def health():
    return {"status": "ok", "service": "gateway"}


@app.get("/app-config.js", include_in_schema=False)
async def browser_config():
    if PUBLISHABLE_KEY.startswith("sb_secret_"):
        raise HTTPException(503, "A Supabase publishable key is required")
    return Response(
        "window.__DEPTH_WIZARD_CONFIG__ = " + json.dumps({
            "authProvider": "supabase",
            "supabaseUrl": SUPABASE_URL,
            "supabasePublishableKey": PUBLISHABLE_KEY,
            "supabaseGoogleEnabled": os.getenv("SUPABASE_GOOGLE_ENABLED", "false").lower() == "true",
            "analysisRequiresLogin": True,
        }) + ";",
        media_type="application/javascript",
        headers={"Cache-Control": "no-store"},
    )


@app.api_route("/api", methods=["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"])
async def proxy_api_root(request: Request):
    return await _proxy(request)


@app.api_route("/api/{suffix:path}", methods=["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"])
async def proxy_api(suffix: str, request: Request):
    return await _proxy(request, suffix)


if FRONTEND_DIST.is_dir():
    for directory in ("assets", "icons"):
        path = FRONTEND_DIST / directory
        if path.is_dir():
            app.mount("/" + directory, StaticFiles(directory=path), name=directory)


@app.get("/{full_path:path}", include_in_schema=False)
async def frontend(full_path: str, request: Request):
    if request.method not in {"GET", "HEAD"}:
        raise HTTPException(404, "Not found")
    first_segment = full_path.strip("/").split("/", 1)[0]
    if first_segment in {
        "auth", "analyses", "estimate", "export", "batch", "samples", "models",
        "health", "calibrate", "volume", "contour", "validate", "uncertainty",
        "benchmarks", "docs", "redoc", "openapi.json",
    }:
        raise HTTPException(404, "Not found")
    if not FRONTEND_DIST.is_dir():
        return JSONResponse({"detail": "Frontend bundle is missing"}, status_code=503)
    candidate = (FRONTEND_DIST / full_path).resolve()
    if candidate != FRONTEND_DIST.resolve() and FRONTEND_DIST.resolve() not in candidate.parents:
        raise HTTPException(404, "Not found")
    if full_path and candidate.is_file():
        return FileResponse(candidate)
    if full_path and Path(full_path).suffix:
        raise HTTPException(404, "Not found")
    return FileResponse(FRONTEND_DIST / "index.html")
