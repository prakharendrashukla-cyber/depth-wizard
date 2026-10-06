"""Bounded uploads and safe paths."""
import io
import os
import tempfile
from pathlib import Path

from fastapi import HTTPException
from PIL import Image, UnidentifiedImageError
from starlette.responses import JSONResponse

from app.config import IMAGE_LIMIT, VIDEO_LIMIT, BATCH_LIMIT, MAX_IMAGE_PIXELS, ALLOWED_ORIGINS

IMAGE_TYPES = {".png": {"image/png"}, ".jpg": {"image/jpeg"}, ".jpeg": {"image/jpeg"},
               ".webp": {"image/webp"}, ".tif": {"image/tiff"}, ".tiff": {"image/tiff"}}
VIDEO_TYPES = {".mp4": {"video/mp4"}, ".mov": {"video/quicktime"},
               ".avi": {"video/x-msvideo", "video/avi"}, ".webm": {"video/webm"}}


def safe_path(base, name):
    base = os.path.realpath(base)
    candidate = os.path.realpath(os.path.join(base, name))
    try:
        if os.path.commonpath([base, candidate]) != base:
            raise ValueError("outside base")
    except ValueError:
        raise HTTPException(404, "Not found") from None
    return candidate


async def read_upload(upload, video=False):
    types = VIDEO_TYPES if video else IMAGE_TYPES
    filename = (upload.filename or "").replace("\\", "/")
    ext = Path(filename).suffix.lower()
    mime = (upload.content_type or "application/octet-stream").split(";")[0].lower()
    if ext not in types or mime not in types[ext] | {"application/octet-stream"}:
        raise HTTPException(415, "Unsupported file type")
    limit = VIDEO_LIMIT if video else IMAGE_LIMIT
    chunks, size = [], 0
    while chunk := await upload.read(65536):
        size += len(chunk)
        if size > limit:
            raise HTTPException(413, "Upload exceeds the configured size limit")
        chunks.append(chunk)
    if not size:
        raise HTTPException(400, "Uploaded file is empty")
    raw = b"".join(chunks)
    if video:
        if not (raw[4:8] == b"ftyp" or raw[:4] == bytes.fromhex("1a45dfa3")
                or (raw[:4] == b"RIFF" and raw[8:12] == b"AVI ")):
            raise HTTPException(415, "Unsupported video content")
    else:
        try:
            with Image.open(io.BytesIO(raw)) as img:
                if img.format not in {"PNG", "JPEG", "TIFF", "WEBP"}:
                    raise HTTPException(415, "Unsupported image content")
                if img.width < 1 or img.height < 1 or img.width * img.height > MAX_IMAGE_PIXELS:
                    raise HTTPException(413, "Image dimensions exceed the configured pixel limit")
                img.verify()
        except (UnidentifiedImageError, OSError, SyntaxError, Image.DecompressionBombError):
            raise HTTPException(415, "Invalid or unsupported image content") from None
    return raw


class UploadLimitMiddleware:
    """Bound request bodies before multipart parsing or authentication dependencies run."""

    def __init__(self, app):
        self.app = app

    @staticmethod
    def rejection(scope, detail, status):
        headers = {
            "Cache-Control": "no-store",
            "X-Content-Type-Options": "nosniff",
            "X-Frame-Options": "DENY",
            "Referrer-Policy": "strict-origin-when-cross-origin",
            "Permissions-Policy": "camera=(self), microphone=(), geolocation=()",
            "X-Permitted-Cross-Domain-Policies": "none",
        }
        if os.getenv("APP_ENV", "development").strip().lower() == "production":
            headers["Strict-Transport-Security"] = "max-age=31536000; includeSubDomains"
        origin = dict(scope.get("headers", [])).get(b"origin", b"").decode("latin-1")
        if origin in ALLOWED_ORIGINS:
            headers["Access-Control-Allow-Origin"] = origin
            headers["Access-Control-Allow-Credentials"] = "true"
            headers["Vary"] = "Origin"
        return JSONResponse({"detail": detail}, status_code=status, headers=headers)

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http" or scope["method"] not in {"POST", "PUT", "PATCH"}:
            return await self.app(scope, receive, send)
        path = scope["path"].removeprefix("/api")
        headers = {key.lower(): value for key, value in scope.get("headers", [])}
        if os.getenv("PUBLIC_DEMO_ONLY", "false").strip().lower() == "true":
            return await self.rejection(scope, "Cloud analysis is disabled on this public demo.", 403)(scope, receive, send)
        protected_paths = {"/estimate", "/estimate/video", "/uncertainty", "/validate", "/batch",
                           "/calibrate", "/contour", "/volume", "/volume/shadow", "/export/ply",
                           "/export/report", "/export/pdf", "/account"}
        guest_allowed = os.getenv("ALLOW_GUEST_ANALYSIS", "true").strip().lower() == "true"
        if (os.getenv("AUTH_PROVIDER", "local") == "supabase" and path in protected_paths
                and not headers.get(b"authorization", b"")
                and not (guest_allowed and path != "/account")):
            return await self.rejection(scope, "Please log in", 401)(scope, receive, send)
        if path == "/estimate/video" and os.getenv("ENABLE_VIDEO_ANALYSIS", "false").strip().lower() != "true":
            return await self.rejection(scope, "Video analysis is currently disabled.", 403)(scope, receive, send)
        batch_blocked = (os.getenv("AUTH_PROVIDER", "local") == "supabase"
                         or os.getenv("ENABLE_BATCH_ANALYSIS", "false").strip().lower() != "true")
        if (path == "/batch" or path.startswith("/batch/")) and batch_blocked:
            return await self.rejection(scope, "Batch analysis is currently disabled.", 403)(scope, receive, send)

        if path == "/estimate/video":
            limit = VIDEO_LIMIT
        elif path == "/batch":
            limit = BATCH_LIMIT
        elif path in {"/estimate", "/uncertainty", "/validate"}:
            limit = IMAGE_LIMIT * (2 if path == "/validate" else 1)
        else:
            limit = 5 * 1024 * 1024
        limit += 1024 * 1024
        try:
            declared = int(headers.get(b"content-length", b"0"))
        except ValueError:
            return await self.rejection(scope, "Invalid content length", 400)(scope, receive, send)
        if declared > limit:
            return await self.rejection(scope, "Request exceeds the configured size limit", 413)(scope, receive, send)

        with tempfile.SpooledTemporaryFile(max_size=1024 * 1024) as body:
            size = 0
            while True:
                message = await receive()
                if message["type"] == "http.disconnect":
                    return
                chunk = message.get("body", b"")
                size += len(chunk)
                if size > limit:
                    return await self.rejection(scope, "Request exceeds the configured size limit", 413)(scope, receive, send)
                body.write(chunk)
                if not message.get("more_body", False):
                    break
            body.seek(0)
            sent = False

            async def replay():
                nonlocal sent
                if sent:
                    return await receive()
                chunk = body.read(65536)
                more = body.tell() < size
                sent = not more
                return {"type": "http.request", "body": chunk, "more_body": more}

            await self.app(scope, replay, send)
