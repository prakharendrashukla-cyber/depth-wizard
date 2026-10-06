"""
Depth Wizard — FastAPI Backend (v1.0)

Endpoints:
    GET  /health              → liveness + model info
    GET  /models              → list available depth models
    GET  /samples             → list bundled demo images
    GET  /samples/{name}      → get sample image file
    GET  /benchmarks          → benchmark comparison data
    POST /estimate            → depth map + 3D point cloud from a single image
    POST /estimate/video      → video multi-frame depth processing
    POST /calibrate           → GCP calibration
    POST /contour             → contour map generation
    POST /volume              → volume estimation
    POST /volume/shadow       → shadow map computation
    POST /uncertainty         → uncertainty / confidence map
    POST /validate            → accuracy validation against ground truth
    POST /export/ply          → 3D point cloud PLY export
    POST /export/report       → JSON analysis report export
    POST /export/pdf          → PDF report generation
    POST /batch               → batch multi-image processing
    GET  /batch/{job_id}/status   → batch job status
    GET  /batch/{job_id}/download → batch ZIP download
"""

import base64
import io
import json
import logging
import os
import time
import asyncio
import threading
from pathlib import Path
from contextlib import asynccontextmanager
from typing import Optional, List

import numpy as np
from fastapi import Depends, FastAPI, UploadFile, File, HTTPException, Form, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, FileResponse, Response
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field
from PIL import Image

from app.depth import DepthEstimator, colorize_depth, list_available_models
from sqlalchemy.orm import Session
from sqlalchemy import select
from app.database import init_db, get_db, User, BatchJobRecord, SessionLocal, now
from app.identity import get_current_user, configure_secret, COOKIE_NAME
from app.auth import router as auth_router, create_first_admin
from app.analyses import router as analyses_router, save_analysis
from app.config import ALLOWED_ORIGINS, MAX_BATCH_FILES, BATCH_LIMIT, MAX_IMAGE_PIXELS
from app.safety import safe_path, read_upload, UploadLimitMiddleware
from app.mesh import depth_to_point_cloud
from app.height import analyze_height, generate_ply_file
from app.quotas import read_user_quota, reserve_analysis, quota_settings
from app.supabase_admin import cleanup_expired_analyses, delete_account_data

# ── Logging ──────────────────────────────────────────────────────────────
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s  %(levelname)-8s  %(name)s  %(message)s",
)
logger = logging.getLogger(__name__)

# ── Global model reference ───────────────────────────────────────────────
estimator: DepthEstimator | None = None
estimator_lock = threading.RLock()
background_tasks: set[asyncio.Task] = set()

MAX_IMAGE_DIM = 518  # Native Depth Anything V2 patch resolution (37*14=518) for 35% faster inference
MAX_INFERENCE_WAIT_SECONDS = float(os.getenv("MAX_INFERENCE_WAIT_SECONDS", "30"))
INFERENCE_CONCURRENCY = int(os.getenv("INFERENCE_CONCURRENCY", "1"))
if not 1 <= INFERENCE_CONCURRENCY <= 4 or not 0.1 <= MAX_INFERENCE_WAIT_SECONDS <= 120:
    raise RuntimeError("Inference concurrency and wait settings are outside the allowed range")
inference_semaphore = asyncio.Semaphore(INFERENCE_CONCURRENCY)
SAMPLE_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "sample_images")

# ── Batch processor singleton ────────────────────────────────────────────
batch_processor = None


def public_demo_only() -> bool:
    return False


def feature_enabled(name: str) -> bool:
    if name == "ENABLE_BATCH_ANALYSIS" and os.getenv("AUTH_PROVIDER", "local") == "supabase":
        # The existing batch-job persistence is SQLite-backed and not durable on Cloud Run.
        return False
    return os.getenv(name, "false").strip().lower() == "true"


def safe_filename(value: str | None) -> str:
    name = (value or "upload").replace("\\", "/").rsplit("/", 1)[-1]
    name = "".join(char for char in name if char.isprintable() and char not in "\r\n\t")[:255]
    return name or "upload"


async def limited_inference(function, *args, **kwargs):
    try:
        await asyncio.wait_for(inference_semaphore.acquire(), timeout=MAX_INFERENCE_WAIT_SECONDS)
    except asyncio.TimeoutError:
        raise HTTPException(503, "The analysis service is busy. Please retry shortly.",
                            headers={"Retry-After": "10"}) from None
    try:
        return await asyncio.to_thread(function, *args, **kwargs)
    finally:
        inference_semaphore.release()


async def reserve_cloud_analysis(request: Request, user):
    """Apply shared admission controls to compute routes; guests run without quota reservation."""
    if os.getenv("AUTH_PROVIDER", "local") != "supabase":
        return
    if isinstance(user, dict) and user.get("id"):
        await reserve_analysis(request, user["id"])
        track_task(cleanup_expired_analyses(quota_settings()["retention_days"]))


async def run_retention_maintenance():
    while True:
        if os.getenv("AUTH_PROVIDER", "local") == "supabase" and not public_demo_only():
            try:
                removed = await cleanup_expired_analyses(quota_settings()["retention_days"])
                if removed:
                    logger.info("Removed %s expired saved analyses", removed)
            except Exception as exc:
                logger.warning("Saved-analysis retention job failed (%s)", type(exc).__name__)
        await asyncio.sleep(24 * 60 * 60)


def get_estimator(model_id=None) -> DepthEstimator:
    """Publish only fully loaded models; in-flight callers keep their old snapshot."""
    global estimator
    from app.depth import MODEL_REGISTRY
    if model_id and model_id not in MODEL_REGISTRY:
        raise HTTPException(400, "Unknown depth model")
    with estimator_lock:
        if estimator is None or (model_id and estimator.model_id != model_id):
            try:
                candidate = DepthEstimator(model_id or os.getenv("DEPTH_MODEL") or None)
            except Exception as exc:
                logger.warning("Requested depth model %s failed to load", model_id, exc_info=exc)
                if model_id:
                    raise HTTPException(
                        503,
                        f"Model '{model_id}' could not be loaded; no alternate model was selected.",
                    ) from exc
                raise
            estimator = candidate
        return estimator

def track_task(coro):
    task = asyncio.create_task(coro)
    background_tasks.add(task)
    def finished(done):
        background_tasks.discard(done)
        if not done.cancelled() and done.exception():
            logger.error("Background task failed", exc_info=done.exception())
    task.add_done_callback(finished)
    return task

async def cleanup_jobs():
    while True:
        await asyncio.sleep(60)
        if batch_processor is not None:
            batch_processor.cleanup()

def timed_call(fn, *args):
    started = time.perf_counter()
    result = fn(*args)
    return result, time.perf_counter() - started


def _png_data_url(pixels: np.ndarray) -> str:
    """Encode an image array as a PNG data URL for browser rendering."""
    buffer = io.BytesIO()
    Image.fromarray(pixels).save(buffer, format="PNG")
    encoded = base64.b64encode(buffer.getvalue()).decode("ascii")
    return f"data:image/png;base64,{encoded}"


def get_batch_processor():
    """Get or create batch processor singleton."""
    global batch_processor
    if batch_processor is None:
        from app.batch import BatchProcessor
        batch_processor = BatchProcessor()
    return batch_processor


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Start loading depth model in background thread without blocking server bind."""
    if os.getenv("AUTH_PROVIDER", "local") not in {"local", "supabase"}:
        raise RuntimeError("AUTH_PROVIDER must be local or supabase")
    if os.getenv("AUTH_PROVIDER", "local") == "local":
        configure_secret()
    init_db()
    if os.getenv("AUTH_PROVIDER", "local") == "local":
        create_first_admin()
    if not public_demo_only():
        track_task(asyncio.to_thread(get_estimator))
    track_task(cleanup_jobs())
    track_task(run_retention_maintenance())
    yield
    tasks = [task for task in list(background_tasks) if task.get_loop() is asyncio.get_running_loop()]
    for task in tasks:
        task.cancel()
    await asyncio.gather(*tasks, return_exceptions=True)
    logger.info("Shutting down.")


# ── App ──────────────────────────────────────────────────────────────────
production = os.getenv("APP_ENV", "development").strip().lower() == "production"
app = FastAPI(
    title="Depth Wizard API",
    description="Single-view depth estimation, 3D reconstruction, height analysis & geospatial intelligence",
    version="1.0.0",
    docs_url=None if production else "/docs",
    redoc_url=None if production else "/redoc",
    openapi_url=None if production else "/openapi.json",
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=ALLOWED_ORIGINS,
    allow_credentials=True,
    allow_methods=["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allow_headers=["Authorization", "Content-Type", "Accept"],
)


app.include_router(auth_router)
app.include_router(analyses_router)
app.add_middleware(UploadLimitMiddleware)


def apply_security_headers(response):
    response.headers.setdefault("X-Content-Type-Options", "nosniff")
    response.headers.setdefault("X-Frame-Options", "DENY")
    response.headers.setdefault("Referrer-Policy", "strict-origin-when-cross-origin")
    response.headers.setdefault("Permissions-Policy", "camera=(self), microphone=(), geolocation=()")
    response.headers.setdefault("X-Permitted-Cross-Domain-Policies", "none")
    if production:
        response.headers.setdefault("Strict-Transport-Security", "max-age=31536000; includeSubDomains")
    return response

@app.exception_handler(Exception)
async def unexpected_error(request, exc):
    logger.error("Unhandled API error", exc_info=exc)
    return JSONResponse({"detail": "Unable to complete the request"}, status_code=500)

@app.middleware("http")
async def rewrite_api_prefix(request: Request, call_next):
    """Rewrite /api/* requests so API routes match with or without /api prefix."""
    path = request.url.path
    request.scope["api_request"] = path == "/api" or path.startswith("/api/")
    if path.startswith("/api/"):
        request.scope["path"] = path[4:]
    elif path == "/api":
        request.scope["path"] = "/"
    normalized_path = request.scope["path"]
    if normalized_path == "/estimate/video" and not feature_enabled("ENABLE_VIDEO_ANALYSIS"):
        return apply_security_headers(JSONResponse({"detail": "Video analysis is currently disabled."}, status_code=403,
                            headers={"Cache-Control": "no-store"}))
    if normalized_path == "/batch" or normalized_path.startswith("/batch/"):
        if not feature_enabled("ENABLE_BATCH_ANALYSIS"):
            return apply_security_headers(JSONResponse({"detail": "Batch analysis is currently disabled."}, status_code=403,
                                headers={"Cache-Control": "no-store"}))
    # Public demo restrictions removed - all models and endpoints enabled
    if os.getenv("AUTH_PROVIDER", "local") == "supabase" and request.scope["path"].split("/")[1] in {"auth", "analyses", "batch"}:
        # Supabase mode uses the SDK for private history. The batch UI calls
        # /estimate per file. Never mix local cookie identities with cloud users.
        return apply_security_headers(JSONResponse({"detail": "Use Supabase for saved history in cloud mode"}, status_code=404))
    if request.method not in {"GET", "HEAD", "OPTIONS"}:
        origin = request.headers.get("origin")
        same_origin = str(request.base_url).rstrip("/")
        if origin and origin not in ALLOWED_ORIGINS and origin != same_origin:
            return apply_security_headers(JSONResponse({"detail": "Origin is not allowed"}, status_code=403))
    response = await call_next(request)
    if request.scope.get("api_request") or COOKIE_NAME in request.cookies or request.scope["path"].startswith(("/auth", "/analyses")):
        response.headers["Cache-Control"] = "no-store"
    return apply_security_headers(response)


# ── Helpers ──────────────────────────────────────────────────────────────

@app.get("/app-config.js", include_in_schema=False)
async def browser_config():
    """Publish an explicit allowlist; credentials and database URLs stay private."""
    config = {
        "authProvider": os.getenv("AUTH_PROVIDER", "local"),
        "supabaseUrl": os.getenv("SUPABASE_URL", ""),
        "supabasePublishableKey": os.getenv("SUPABASE_PUBLISHABLE_KEY", ""),
        "supabaseGoogleEnabled": os.getenv("SUPABASE_GOOGLE_ENABLED", "false").lower() == "true",
        "publicDemoOnly": public_demo_only(),
        "batchAnalysisEnabled": feature_enabled("ENABLE_BATCH_ANALYSIS"),
        "videoAnalysisEnabled": feature_enabled("ENABLE_VIDEO_ANALYSIS"),
    }
    key = config["supabasePublishableKey"]
    if key.startswith("sb_secret_"):
        raise HTTPException(503, "Use a Supabase publishable key")
    if key and not key.startswith("sb_publishable_"):
        # Legacy anon JWTs are public; reject a mistaken service-role JWT.
        import jwt
        try:
            if jwt.decode(key, options={"verify_signature": False}).get("role") != "anon":
                raise ValueError("Not an anon key")
        except Exception as exc:
            raise HTTPException(503, "Use a Supabase publishable key") from exc
    return Response("window.__DEPTH_WIZARD_CONFIG__ = " + json.dumps(config) + ";",
                    media_type="application/javascript", headers={"Cache-Control": "no-store"})

def _pil_to_base64(img: Image.Image, fmt: str = "PNG", quality: int = 85) -> str:
    buf = io.BytesIO()
    if fmt.upper() in ("JPEG", "JPG"):
        img.convert("RGB").save(buf, format="JPEG", quality=quality, optimize=True)
    elif fmt.upper() == "WEBP":
        img.save(buf, format="WEBP", quality=quality)
    else:
        img.save(buf, format="PNG", optimize=False)
    return base64.b64encode(buf.getvalue()).decode()


def _ndarray_to_base64(arr: np.ndarray) -> str:
    return base64.b64encode(arr.tobytes()).decode()


def _resize_image(img: Image.Image, max_dim: int) -> Image.Image:
    """Resize so the longest side <= max_dim, preserving aspect ratio."""
    w, h = img.size
    if max(w, h) <= max_dim:
        return img
    scale = max_dim / max(w, h)
    new_w, new_h = int(w * scale), int(h * scale)
    return img.resize((new_w, new_h), Image.LANCZOS)


def _decode_image(raw: bytes) -> Image.Image:
    """Decode bytes to PIL Image, handling GeoTIFF as well."""
    try:
        img = Image.open(io.BytesIO(raw)).convert("RGB")
        return img
    except Exception:
        # Try GeoTIFF parsing
        try:
            from app.geotiff import parse_geotiff
            result = parse_geotiff(raw)
            return result["image"]
        except Exception:
            raise HTTPException(400, "Could not decode image.")


def _decode_bounded_raster(raw: bytes) -> Image.Image:
    """Decode a supplied raster only after bounding its compressed and decoded size."""
    if not raw or len(raw) > 5 * 1024 * 1024:
        raise HTTPException(413, "Raster input exceeds the configured size limit")
    try:
        with Image.open(io.BytesIO(raw)) as image:
            if image.format not in {"PNG", "JPEG", "WEBP", "TIFF"}:
                raise HTTPException(415, "Unsupported raster content")
            if image.width < 1 or image.height < 1 or image.width * image.height > MAX_IMAGE_PIXELS:
                raise HTTPException(413, "Raster dimensions exceed the configured pixel limit")
            image.load()
            return image.convert("L")
    except HTTPException:
        raise
    except (Image.DecompressionBombError, OSError, SyntaxError, ValueError):
        raise HTTPException(415, "Invalid or unsupported raster content") from None


def _decode_bounded_raster_base64(value: str) -> Image.Image:
    encoded = value.split(",")[-1].strip()
    if not encoded or len(encoded) > 7 * 1024 * 1024:
        raise HTTPException(413, "Raster input exceeds the configured size limit")
    try:
        raw = base64.b64decode(encoded, validate=True)
    except (ValueError, base64.binascii.Error):
        raise HTTPException(400, "Invalid raster encoding") from None
    return _decode_bounded_raster(raw)


# ══════════════════════════════════════════════════════════════════════════
# ── ROUTES ───────────────────────────────────────────────────────────────
# ══════════════════════════════════════════════════════════════════════════

@app.get("/health")
async def health():
    return {"status": "ok"}


@app.get("/models")
async def get_models():
    """List all available depth models with their capabilities."""
    current = estimator.model_id if estimator else "loading"
    models = list_available_models(current_model=current)
    return {
        "models": models,
        "current_model": current,
    }


@app.get("/benchmarks")
async def get_benchmarks():
    """Return benchmark comparison data for standard datasets."""
    try:
        from app.validation import get_benchmark_results
        return {"benchmarks": get_benchmark_results()}
    except Exception as exc:
        logger.error("Error fetching benchmarks: %s", exc)
        return {"benchmarks": []}


@app.get("/samples")
async def list_samples():
    """Return available bundled demo samples."""
    samples = []
    if os.path.exists(SAMPLE_DIR):
        for fname in sorted(os.listdir(SAMPLE_DIR)):
            if fname.endswith((".png", ".jpg", ".jpeg")) and not fname.endswith(("_depth.png", "_infer.png")):
                samples.append({
                    "id": fname,
                    "name": fname.replace(".png", "").replace(".jpg", "").replace("_", " ").title(),
                    "filename": fname,
                    "url": f"/samples/{fname}"
                })
    return {"samples": samples}


@app.get("/samples/{name}")
async def get_sample_image(name: str):
    file_path = safe_path(SAMPLE_DIR, name)
    if not os.path.isfile(file_path):
        raise HTTPException(404, "Sample image not found")
    return FileResponse(file_path)


# ── Core Depth Estimation ────────────────────────────────────────────────

@app.post("/estimate", dependencies=[Depends(get_current_user)])
async def estimate_depth(
    request: Request,
    image: UploadFile = File(...),
    model: Optional[str] = Form(None),
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """
    Accept an image, run depth estimation, and return:
      - depth_map        base64 PNG  (coloured depth visualisation)
      - original_image   base64 PNG  (resized input for frontend display)
      - point_cloud       { positions, colors, count }
      - depth_raw         { min, max, mean }
      - metadata          dimensions, timing, model, etc.
    """
    raw = await read_upload(image)
    await reserve_cloud_analysis(request, user)
    est = await asyncio.to_thread(get_estimator, model)
    img = _decode_image(raw)

    # Check for GeoTIFF metadata
    geo_metadata = None
    try:
        from app.geotiff import parse_geotiff
        geo_result = parse_geotiff(raw)
        if geo_result.get("metadata", {}).get("is_georeferenced"):
            geo_metadata = geo_result.get("metadata")
    except Exception:
        pass

    original_w, original_h = img.size
    img = _resize_image(img, MAX_IMAGE_DIM)
    proc_w, proc_h = img.size
    filename = safe_filename(image.filename)
    logger.info("Processing uploaded image  %dx%d -> %dx%d", original_w, original_h, proc_w, proc_h)

    # ── Depth estimation (Async Non-blocking) ────────────────────────
    t0 = time.perf_counter()
    try:
        depth = await limited_inference(est.estimate, img)
    except Exception as exc:
        logger.exception("Depth inference failed using %s", est.model_id)
        raise HTTPException(
            503,
            f"Model '{est.model_id}' failed during inference; no alternate model was used.",
        ) from exc
    depth_time = time.perf_counter() - t0
    logger.info("Depth estimation: %.2fs", depth_time)

    # Ensure depth matches processed image size
    if depth.shape != (proc_h, proc_w):
        depth_img = Image.fromarray(depth)
        depth_img = depth_img.resize((proc_w, proc_h), Image.BILINEAR)
        depth = np.array(depth_img, dtype=np.float32)

    # ── Fast Parallel Post-Processing ─────────────────────────────────
    depth_colored = colorize_depth(depth)

    # Run point cloud and height analysis concurrently
    pc_task = asyncio.to_thread(timed_call, depth_to_point_cloud, img, depth, 2, 55000)
    height_task = asyncio.to_thread(timed_call, analyze_height, depth, 1.0)
    ((positions, colors), pc_time), (height_data, height_time) = await asyncio.gather(pc_task, height_task)
    logger.info("Point cloud & height analysis: %d points in %.2fs", len(positions), pc_time)

    # ── Build response ───────────────────────────────────────────────
    response = {
        "status": "success",
        "model": est.model_name,
        "model_id": est.model_id,
        "metadata": {
            "original_width": original_w,
            "original_height": original_h,
            "processed_width": proc_w,
            "processed_height": proc_h,
            "num_points": len(positions),
            "depth_time_s": round(depth_time, 3),
            "pointcloud_time_s": round(pc_time, 3),
            "height_time_s": round(height_time, 3),
            "filename": filename,
        },
        "depth_map": _pil_to_base64(depth_colored, fmt="PNG"),
        "original_image": _pil_to_base64(img, fmt="JPEG", quality=85),
        "point_cloud": {
            "positions": _ndarray_to_base64(positions),
            "colors": _ndarray_to_base64(colors),
            "count": len(positions),
        },
        "depth_stats": {
            "min": float(depth.min()),
            "max": float(depth.max()),
            "mean": float(depth.mean()),
        },
        "height_analysis": height_data,
    }

    if geo_metadata:
        response["geo_metadata"] = geo_metadata

    if os.getenv("AUTH_PROVIDER", "local") == "local":
        response["analysis_id"] = save_analysis(db, user, response)
    return JSONResponse(content=response)


@app.get("/quota")
async def analysis_quota(user: User = Depends(get_current_user)):
    """Return a signed-in user's remaining analysis and private-storage budget."""
    if os.getenv("AUTH_PROVIDER", "local") != "supabase" or not isinstance(user, dict):
        raise HTTPException(404, "Quota information is available in cloud mode")
    return await read_user_quota(user["id"])


@app.delete("/account", status_code=204)
async def delete_cloud_account(user: User = Depends(get_current_user)):
    """Delete the authenticated user's private files, rows, and Auth account."""
    if os.getenv("AUTH_PROVIDER", "local") != "supabase" or not isinstance(user, dict):
        raise HTTPException(404, "Account deletion is available in cloud mode")
    try:
        await delete_account_data(user["id"])
    except Exception as exc:
        logger.warning("Account deletion failed (%s)", type(exc).__name__)
        raise HTTPException(503, "Account deletion could not be completed. Please retry or contact support.") from None
    return Response(status_code=204)


# ── GCP Calibration ──────────────────────────────────────────────────────

class CalibrateRequest(BaseModel):
    depth_map_b64: str
    gcps: List[dict]  # [{x, y, known_height_m}]


@app.post("/calibrate")
async def calibrate(req: CalibrateRequest, request: Request, user: User = Depends(get_current_user)):
    """Calibrate depth map using Ground Control Points."""
    try:
        from app.calibration import calibrate_from_gcps

        await reserve_cloud_analysis(request, user)
        # Decode depth map from base64 PNG
        depth_img = _decode_bounded_raster_base64(req.depth_map_b64)
        depth_map = np.array(depth_img, dtype=np.float32)

        result = calibrate_from_gcps(depth_map, req.gcps)
        return JSONResponse(content=result)
    except HTTPException:
        raise
    except ValueError as exc:
        logger.exception("Invalid request data")
        raise HTTPException(400, "Invalid input data") from exc
    except Exception as exc:
        logger.exception("Request processing failed")
        raise HTTPException(500, "Unable to complete the request") from exc


# ── Contour Map ──────────────────────────────────────────────────────────

class ContourRequest(BaseModel):
    depth_map_b64: str
    num_levels: int = 10
    scale_factor: float = 1.0
    format: str = "json"  # "json", "svg", "dxf"


@app.post("/contour")
async def generate_contour(req: ContourRequest, request: Request, user: User = Depends(get_current_user)):
    """Generate contour lines and slope/aspect maps from depth data."""
    try:
        from app.contour import generate_contours, compute_slope_aspect, contours_to_svg, contours_to_dxf

        await reserve_cloud_analysis(request, user)
        depth_img = _decode_bounded_raster_base64(req.depth_map_b64)
        depth_map = np.array(depth_img, dtype=np.float32)

        # Generate contours
        contours = generate_contours(depth_map, num_levels=req.num_levels, scale_factor=req.scale_factor)

        # Compute slope and aspect
        slope_aspect = compute_slope_aspect(depth_map, scale_factor=req.scale_factor)

        # Convert slope/aspect maps to base64 for frontend display
        slope_map = slope_aspect.get("slope_map")
        if slope_map is not None:
            # Colorize slope: green (flat) to red (steep)
            slope_norm = np.clip(slope_map / 90.0, 0, 1)
            r = (slope_norm * 255).astype(np.uint8)
            g = ((1 - slope_norm) * 200).astype(np.uint8)
            b = np.full_like(r, 50)
            slope_rgb = np.stack([r, g, b], axis=-1)
            slope_b64 = _pil_to_base64(Image.fromarray(slope_rgb))
            slope_aspect["slope_map_base64"] = slope_b64
            del slope_aspect["slope_map"]

        aspect_map = slope_aspect.get("aspect_map")
        if aspect_map is not None:
            # Colorize aspect using HSV wheel
            aspect_norm = (aspect_map / 360.0 * 255).astype(np.uint8)
            aspect_rgb = np.stack([aspect_norm, np.full_like(aspect_norm, 180), np.full_like(aspect_norm, 200)], axis=-1)
            aspect_b64 = _pil_to_base64(Image.fromarray(aspect_rgb))
            slope_aspect["aspect_map_base64"] = aspect_b64
            del slope_aspect["aspect_map"]

        h, w = depth_map.shape

        if req.format == "svg":
            svg_content = contours_to_svg(contours, w, h)
            return Response(content=svg_content, media_type="image/svg+xml")
        elif req.format == "dxf":
            dxf_content = contours_to_dxf(contours)
            return Response(
                content=dxf_content.encode("utf-8"),
                media_type="application/dxf",
                headers={"Content-Disposition": 'attachment; filename="contours.dxf"'},
            )

        return JSONResponse(content={
            "contours": contours,
            "slope_aspect": slope_aspect,
            "image_width": w,
            "image_height": h,
        })
    except HTTPException:
        raise
    except ValueError as exc:
        logger.exception("Invalid request data")
        raise HTTPException(400, "Invalid input data") from exc
    except Exception as exc:
        logger.exception("Request processing failed")
        raise HTTPException(500, "Unable to complete the request") from exc


# ── Volume Estimation ────────────────────────────────────────────────────

class VolumeRequest(BaseModel):
    depth_map_b64: str
    scale_factor: float = 1.0
    ground_percentile: float = 10.0


@app.post("/volume")
async def compute_volume(req: VolumeRequest, request: Request, user: User = Depends(get_current_user)):
    """Estimate volume above ground from depth map."""
    try:
        from app.volume import estimate_volume

        await reserve_cloud_analysis(request, user)
        depth_img = _decode_bounded_raster_base64(req.depth_map_b64)
        depth_map = np.array(depth_img, dtype=np.float32)

        result = estimate_volume(depth_map, scale_factor=req.scale_factor, ground_percentile=req.ground_percentile)
        return JSONResponse(content=result)
    except HTTPException:
        raise
    except ValueError as exc:
        logger.exception("Invalid request data")
        raise HTTPException(400, "Invalid input data") from exc
    except Exception as exc:
        logger.exception("Request processing failed")
        raise HTTPException(500, "Unable to complete the request") from exc


class ShadowRequest(BaseModel):
    depth_map_b64: str
    sun_azimuth_deg: float = 180.0
    sun_elevation_deg: float = 45.0
    scale_factor: float = 1.0
    pixel_size_m: Optional[float] = Field(default=None, gt=0, le=100000)


@app.post("/volume/shadow")
async def compute_shadow(req: ShadowRequest, request: Request, user: User = Depends(get_current_user)):
    """Compute shadow map from height data and sun position."""
    try:
        from app.volume import compute_shadow_map

        await reserve_cloud_analysis(request, user)
        depth_img = _decode_bounded_raster_base64(req.depth_map_b64)
        depth_map = np.array(depth_img, dtype=np.float32)

        result = compute_shadow_map(
            depth_map,
            sun_azimuth_deg=req.sun_azimuth_deg,
            sun_elevation_deg=req.sun_elevation_deg,
            scale_factor=req.scale_factor,
            pixel_size_m=req.pixel_size_m if req.pixel_size_m is not None else 1.0,
        )
        shadow_mask = result.pop("shadow_mask")
        shadow_pixels = int(np.count_nonzero(shadow_mask))
        result["shadow_pixels"] = shadow_pixels
        result["illuminated_pixels"] = int(shadow_mask.size) - shadow_pixels
        result["horizontally_calibrated"] = req.pixel_size_m is not None
        result["coverage_percent"] = result["shadow_percentage"]
        pixel_area_m2 = req.pixel_size_m ** 2 if req.pixel_size_m is not None else None
        result["shadow_area_m2"] = round(shadow_pixels * pixel_area_m2, 2) if pixel_area_m2 is not None else None
        result["illuminated_area_m2"] = round(result["illuminated_pixels"] * pixel_area_m2, 2) if pixel_area_m2 is not None else None
        return JSONResponse(content=result)
    except HTTPException:
        raise
    except ValueError as exc:
        logger.exception("Invalid request data")
        raise HTTPException(400, "Invalid input data") from exc
    except Exception as exc:
        logger.exception("Request processing failed")
        raise HTTPException(500, "Unable to complete the request") from exc


# ── Uncertainty ──────────────────────────────────────────────────────────

@app.post("/uncertainty", dependencies=[Depends(get_current_user)])
async def compute_uncertainty(
    request: Request,
    image: UploadFile = File(...),
    user: User = Depends(get_current_user),
):
    """Compute per-pixel uncertainty/confidence map using multi-pass augmented inference."""
    try:
        from app.uncertainty import compute_uncertainty as _compute_uncertainty

        raw = await read_upload(image)
        await reserve_cloud_analysis(request, user)
        est = await asyncio.to_thread(get_estimator)
        img = _decode_image(raw)
        img = _resize_image(img, MAX_IMAGE_DIM)

        result = await limited_inference(_compute_uncertainty, img, est, num_passes=5)
        confidence = np.clip(np.asarray(result["confidence_map"], dtype=np.float32), 0.0, 1.0)

        # Return browser-ready visualizations and scalar metrics. The numerical
        # arrays from compute_uncertainty are intentionally kept server-side.
        confidence_gray = np.round(confidence * 255).astype(np.uint8)
        low = confidence < 0.5
        heatmap = np.empty((*confidence.shape, 3), dtype=np.uint8)
        heatmap[..., 0] = np.where(low, 245, np.round((1 - (confidence - 0.5) * 2) * 245))
        heatmap[..., 1] = np.where(low, np.round(confidence * 460), 210)
        heatmap[..., 2] = np.where(low, 30, 50)

        unreliable_mask = np.zeros((*confidence.shape, 4), dtype=np.uint8)
        unreliable_mask[confidence < 0.6] = [248, 81, 73, 180]
        stats = result["confidence_stats"]
        return JSONResponse(content={
            "confidenceMapBase64": _png_data_url(heatmap),
            "confidenceValuesBase64": _png_data_url(confidence_gray),
            "unreliableMaskBase64": _png_data_url(unreliable_mask),
            "stats": {
                "meanConfidence": round(float(stats["mean"]) * 100, 1),
                "minConfidence": round(float(stats["min"]) * 100, 1),
                "maxConfidence": round(float(stats["max"]) * 100, 1),
                "unreliableAreaPercent": round(float(np.mean(confidence < 0.6) * 100), 1),
            },
        })
    except HTTPException:
        raise
    except ValueError as exc:
        logger.exception("Invalid request data")
        raise HTTPException(400, "Invalid input data") from exc
    except Exception as exc:
        logger.exception("Request processing failed")
        raise HTTPException(500, "Unable to complete the request") from exc


# ── Validation ───────────────────────────────────────────────────────────

@app.post("/validate", dependencies=[Depends(get_current_user)])
async def validate_depth(
    request: Request,
    estimated: Optional[UploadFile] = File(None),
    ground_truth: Optional[UploadFile] = File(None),
    estimated_depth_base64: Optional[str] = Form(None),
    scale_factor: float = Form(1.0),
    model: str = Form("Depth Anything V2"),
    user: User = Depends(get_current_user),
):
    """Compare estimated depth against ground truth DEM/DSM."""
    try:
        from app.validation import compute_metrics, generate_error_heatmap, generate_scatter_data

        est_img = None
        if estimated is not None:
            est_raw = await read_upload(estimated)
            est_img = _decode_bounded_raster(est_raw)
        elif estimated_depth_base64:
            est_img = _decode_bounded_raster_base64(estimated_depth_base64)

        gt_img = None
        if ground_truth is not None:
            gt_raw = await read_upload(ground_truth)
            gt_img = _decode_bounded_raster(gt_raw)

        if est_img is None:
            raise ValueError("Estimated depth map is required")
        if gt_img is None:
            raise ValueError("Ground-truth reference raster is required")

        await reserve_cloud_analysis(request, user)

        # Resize GT to match estimated if needed
        if est_img.size != gt_img.size:
            gt_img = gt_img.resize(est_img.size, Image.LANCZOS)

        est_arr = np.array(est_img, dtype=np.float32)
        gt_arr = np.array(gt_img, dtype=np.float32)

        metrics = compute_metrics(est_arr, gt_arr)
        error_heatmap = generate_error_heatmap(est_arr, gt_arr)
        scatter = generate_scatter_data(est_arr, gt_arr)

        return JSONResponse(content={
            "metrics": metrics,
            "error_heatmap": error_heatmap,
            "scatter": scatter,
            "scatterPoints": scatter.get("points", []),
            "histogram": error_heatmap.get("error_histogram", []),
        })
    except HTTPException:
        raise
    except ValueError as exc:
        logger.exception("Invalid request data")
        raise HTTPException(400, "Invalid input data") from exc
    except Exception as exc:
        logger.exception("Request processing failed")
        raise HTTPException(500, "Unable to complete the request") from exc


# ── Video Processing ─────────────────────────────────────────────────────

@app.post("/estimate/video", dependencies=[Depends(get_current_user)])
async def estimate_video(
    request: Request,
    video: UploadFile = File(...),
    target_fps: float = Form(2.0, gt=0, le=30),
    max_frames: int = Form(10, ge=1, le=30),
    temporal_smoothing: float = Form(0.3, ge=0, le=1),
    user: User = Depends(get_current_user),
):
    """Process a video file frame-by-frame with temporal smoothing."""
    try:
        from app.video_processor import process_video

        raw = await read_upload(video, video=True)
        await reserve_cloud_analysis(request, user)
        est = await asyncio.to_thread(get_estimator)

        result = await limited_inference(
            process_video,
            raw, est,
            target_fps=target_fps,
            max_frames=max_frames,
            temporal_smoothing=temporal_smoothing,
        )
        return JSONResponse(content=result)
    except HTTPException:
        raise
    except ValueError as exc:
        logger.exception("Invalid request data")
        raise HTTPException(400, "Invalid input data") from exc
    except Exception as exc:
        logger.exception("Request processing failed")
        raise HTTPException(500, "Unable to complete the request") from exc


# ── Export Endpoints ─────────────────────────────────────────────────────

class ExportPlyRequest(BaseModel):
    positions: str
    colors: str
    filename: str = "point_cloud.ply"


@app.post("/export/ply", dependencies=[Depends(get_current_user)])
async def export_ply(req: ExportPlyRequest):
    """Convert base64 point cloud positions & colors to a binary PLY file."""
    try:
        pos_bytes = base64.b64decode(req.positions)
        col_bytes = base64.b64decode(req.colors)
        max_float_bytes = 55000 * 3 * np.dtype(np.float32).itemsize
        if len(pos_bytes) > max_float_bytes or len(col_bytes) > max_float_bytes:
            raise HTTPException(413, "Point cloud exceeds the configured vertex limit")
        if len(pos_bytes) % 12 or len(col_bytes) != len(pos_bytes):
            raise HTTPException(400, "Point cloud arrays have invalid dimensions")
        positions = np.frombuffer(pos_bytes, dtype=np.float32).reshape(-1, 3)
        colors = np.frombuffer(col_bytes, dtype=np.float32).reshape(-1, 3)
        if not np.isfinite(positions).all() or not np.isfinite(colors).all():
            raise HTTPException(400, "Point cloud values must be finite")
        ply_bytes = generate_ply_file(positions, colors)

        safe_filename = req.filename if req.filename.endswith(".ply") else f"{req.filename}.ply"
        return Response(
            content=ply_bytes,
            media_type="application/octet-stream",
            headers={"Content-Disposition": f'attachment; filename="{safe_filename}"'},
        )
    except HTTPException:
        raise
    except ValueError as exc:
        logger.exception("Invalid request data")
        raise HTTPException(400, "Invalid input data") from exc
    except Exception as exc:
        logger.exception("Request processing failed")
        raise HTTPException(500, "Unable to complete the request") from exc


class ExportReportRequest(BaseModel):
    filename: str = "height_report.json"
    metadata: dict = {}
    height_analysis: dict = {}
    scale_factor: float = 1.0


@app.post("/export/report", dependencies=[Depends(get_current_user)])
async def export_report(req: ExportReportRequest):
    """Generate a structured analysis report download."""
    report = {
        "report_title": "Depth Wizard Height & Topography Analysis Report",
        "generated_at": time.strftime("%Y-%m-%d %H:%M:%S UTC", time.gmtime()),
        "source_filename": req.filename,
        "calibrated_scale_m_per_unit": req.scale_factor,
        "metadata": req.metadata,
        "height_analysis": req.height_analysis,
    }
    content = json.dumps(report, indent=2).encode("utf-8")
    return Response(
        content=content,
        media_type="application/json",
        headers={"Content-Disposition": f'attachment; filename="{req.filename.replace(".png", "").replace(".jpg", "")}_report.json"'},
    )


class ExportPdfRequest(BaseModel):
    report_data: dict
    branding: str = "default"  # "default" or "isro"


@app.post("/export/pdf", dependencies=[Depends(get_current_user)])
async def export_pdf(req: ExportPdfRequest):
    """Generate a professional PDF report."""
    try:
        from app.report import generate_pdf_report

        pdf_bytes = await asyncio.to_thread(generate_pdf_report, req.report_data, req.branding)
        return Response(
            content=pdf_bytes,
            media_type="application/pdf",
            headers={"Content-Disposition": 'attachment; filename="depth_wizard_report.pdf"'},
        )
    except HTTPException:
        raise
    except ValueError as exc:
        logger.exception("Invalid request data")
        raise HTTPException(400, "Invalid input data") from exc
    except Exception as exc:
        logger.exception("Request processing failed")
        raise HTTPException(500, "Unable to complete the request") from exc


# ── Batch Processing ─────────────────────────────────────────────────────

@app.post("/batch", dependencies=[Depends(get_current_user)])
async def batch_process(images: List[UploadFile] = File(...), user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    """Process multiple images in batch mode."""
    try:
        bp = get_batch_processor()
        est = await asyncio.to_thread(get_estimator)

        if len(images) > MAX_BATCH_FILES:
            raise HTTPException(413, "Too many batch files")
        image_data = []
        total_bytes = 0
        for img_file in images:
            raw = await read_upload(img_file)
            total_bytes += len(raw)
            if total_bytes > BATCH_LIMIT:
                raise HTTPException(413, "Batch exceeds the configured size limit")
            image_data.append((img_file.filename or "unknown", raw))

        job_id = bp.create_job(image_data)

        db.add(BatchJobRecord(id=job_id, user_id=user.id, status="pending"))
        db.commit()
        track_task(asyncio.to_thread(run_persistent_batch, bp, job_id, est))

        return JSONResponse(content={
            "job_id": job_id,
            "status": "processing",
            "total_images": len(image_data),
        })
    except HTTPException:
        raise
    except ValueError as exc:
        logger.exception("Invalid request data")
        raise HTTPException(400, "Invalid input data") from exc
    except Exception as exc:
        logger.exception("Request processing failed")
        raise HTTPException(500, "Unable to complete the request") from exc


def run_persistent_batch(bp, job_id, est):
    def update_job(job):
        with SessionLocal.begin() as db:
            row = db.get(BatchJobRecord, job_id)
            if row:
                row.status = job.status
                row.progress = job.to_dict(include_images=False)
                row.updated_at = now()
                if job.status in {"done", "error"}:
                    row.completed_at = now()
    try:
        bp.process_job(job_id, est, analyze_height, progress_callback=update_job)
    except Exception:
        logger.exception("Batch processing failed")
        with SessionLocal.begin() as db:
            row = db.get(BatchJobRecord, job_id)
            row.status = "error"
            row.completed_at = now()
        job = bp.jobs.get(job_id)
        if job:
            job.status = "error"
            job.expires_at = time.time()
        bp._job_images.pop(job_id, None)

def owned_batch(job_id, user, db):
    row = db.scalar(select(BatchJobRecord).where(BatchJobRecord.id == job_id, BatchJobRecord.user_id == user.id))
    if row is None:
        raise HTTPException(404, "Job not found")
    return row

@app.get("/batch/{job_id}/status")
async def batch_status(job_id: str, user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    """Get batch job progress and status."""
    row = owned_batch(job_id, user, db)
    try:
        bp = get_batch_processor()
        if job_id not in bp.jobs:
            return {**row.progress, "job_id": row.id, "status": row.status, "artifacts_available": False}
        status = bp.get_job_status(job_id)
        if status is None:
            raise HTTPException(404, "Job not found")
        return JSONResponse(content=status)
    except HTTPException:
        raise
    except ValueError as exc:
        logger.exception("Invalid request data")
        raise HTTPException(400, "Invalid input data") from exc
    except Exception as exc:
        logger.exception("Request processing failed")
        raise HTTPException(500, "Unable to complete the request") from exc


@app.get("/batch/{job_id}/download")
async def batch_download(job_id: str, user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    """Download batch results as a ZIP file."""
    owned_batch(job_id, user, db)
    try:
        bp = get_batch_processor()
        if job_id not in bp.jobs:
            raise HTTPException(410, "Batch files expired or server restarted")
        if bp.jobs[job_id].status not in {"done", "error"}:
            raise HTTPException(409, "Batch is still processing")
        zip_bytes = bp.generate_zip(job_id)
        if zip_bytes is None:
            raise HTTPException(404, "Job not found or not complete")
        return Response(
            content=zip_bytes,
            media_type="application/zip",
            headers={"Content-Disposition": f'attachment; filename="depth_wizard_batch_{job_id[:8]}.zip"'},
        )
    except HTTPException:
        raise
    except ValueError as exc:
        logger.exception("Invalid request data")
        raise HTTPException(400, "Invalid input data") from exc
    except Exception as exc:
        logger.exception("Request processing failed")
        raise HTTPException(500, "Unable to complete the request") from exc


@app.get("/batch/{job_id}/summary")
async def batch_summary(job_id: str, user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    """Get aggregate summary for a completed batch job."""
    row = owned_batch(job_id, user, db)
    try:
        bp = get_batch_processor()
        if job_id not in bp.jobs:
            return {"job_id": row.id, "status": row.status, "artifacts_available": False}
        summary = bp.get_summary(job_id)
        if summary is None:
            raise HTTPException(404, "Job not found")
        return JSONResponse(content=summary)
    except HTTPException:
        raise
    except ValueError as exc:
        logger.exception("Invalid request data")
        raise HTTPException(400, "Invalid input data") from exc
    except Exception as exc:
        logger.exception("Request processing failed")
        raise HTTPException(500, "Unable to complete the request") from exc


# ── Single-Server Static Frontend Mounting ──────────────────────────────
FRONTEND_DIST = os.path.normpath(
    os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "..", "frontend", "dist")
)

if os.path.isdir(FRONTEND_DIST):
    logger.info("Mounting built frontend SPA from %s", FRONTEND_DIST)
    # Mount subdirectories (assets, icons)
    assets_dir = os.path.join(FRONTEND_DIST, "assets")
    if os.path.isdir(assets_dir):
        app.mount("/assets", StaticFiles(directory=assets_dir), name="assets")

    icons_dir = os.path.join(FRONTEND_DIST, "icons")
    if os.path.isdir(icons_dir):
        app.mount("/icons", StaticFiles(directory=icons_dir), name="icons")

    @app.get("/{full_path:path}")
    async def serve_spa_app(full_path: str, request: Request):
        # Prevent intercepting API routes
        if request.scope.get("api_request") or full_path.split("/")[0] in {"api", "auth", "analyses", "estimate", "export", "batch", "samples", "models", "health", "calibrate", "volume", "contour", "validate", "uncertainty", "benchmarks"}:
            raise HTTPException(404, "API endpoint not found")

        # If a static file directly in dist/ matches (e.g. manifest.json, sw.js, favicon.ico)
        direct_file = safe_path(FRONTEND_DIST, full_path)
        if full_path and os.path.isfile(direct_file):
            return FileResponse(direct_file)

        if Path(full_path).suffix:
            raise HTTPException(404, "Not found")

        # Fallback to index.html for React SPA
        index_file = os.path.join(FRONTEND_DIST, "index.html")
        if os.path.isfile(index_file):
            return FileResponse(index_file)

        return JSONResponse({"detail": "Frontend build index.html not found"}, status_code=404)
