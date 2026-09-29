"""Bounded uploads and safe paths."""
import io
import os
import tempfile
from pathlib import Path
from fastapi import HTTPException
from PIL import Image, UnidentifiedImageError
from starlette.responses import JSONResponse
from app.config import IMAGE_LIMIT, VIDEO_LIMIT, BATCH_LIMIT

IMAGE_TYPES = {".png": {"image/png"}, ".jpg": {"image/jpeg"}, ".jpeg": {"image/jpeg"}, ".webp": {"image/webp"}, ".tif": {"image/tiff"}, ".tiff": {"image/tiff"}}
VIDEO_TYPES = {".mp4": {"video/mp4"}, ".mov": {"video/quicktime"}, ".avi": {"video/x-msvideo", "video/avi"}, ".webm": {"video/webm"}}

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
    ext = Path(upload.filename or "").suffix.lower()
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
        if not (raw[4:8] == b"ftyp" or raw[:4] == bytes.fromhex("1a45dfa3") or (raw[:4] == b"RIFF" and raw[8:12] == b"AVI ")):
            raise HTTPException(415, "Unsupported video content")
    else:
        try:
            with Image.open(io.BytesIO(raw)) as img:
                if img.format not in {"PNG", "JPEG", "TIFF", "WEBP"}:
                    raise HTTPException(415, "Unsupported image content")
                img.verify()
        except (UnidentifiedImageError, OSError, SyntaxError, Image.DecompressionBombError):
            raise HTTPException(415, "Invalid or unsupported image content") from None
    return raw

class UploadLimitMiddleware:
    """Bound the body before multipart parsing; large bodies spool to disk."""
    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http" or scope["method"] not in {"POST", "PUT", "PATCH"}:
            return await self.app(scope, receive, send)
        path = scope["path"].removeprefix("/api")
        limit = VIDEO_LIMIT if path == "/estimate/video" else BATCH_LIMIT if path == "/batch" else IMAGE_LIMIT * 2
        limit += 1024 * 1024
        try:
            declared = int(dict(scope.get("headers", [])).get(b"content-length", b"0"))
        except ValueError:
            return await JSONResponse({"detail": "Invalid content length"}, 400)(scope, receive, send)
        if declared > limit:
            return await JSONResponse({"detail": "Request exceeds the configured size limit"}, 413)(scope, receive, send)
        with tempfile.SpooledTemporaryFile(max_size=1024 * 1024) as body:
            size = 0
            while True:
                message = await receive()
                if message["type"] == "http.disconnect":
                    return
                chunk = message.get("body", b"")
                size += len(chunk)
                if size > limit:
                    return await JSONResponse({"detail": "Request exceeds the configured size limit"}, 413)(scope, receive, send)
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
