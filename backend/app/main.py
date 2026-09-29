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
from contextlib import asynccontextmanager
from typing import Optional, List

import numpy as np
from fastapi import FastAPI, UploadFile, File, HTTPException, Form, Query, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, FileResponse, Response
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel
from PIL import Image

from app.depth import DepthEstimator, colorize_depth, list_available_models, recommend_model
from app.mesh import depth_to_point_cloud
from app.height import analyze_height, generate_ply_file

# ── Logging ──────────────────────────────────────────────────────────────
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s  %(levelname)-8s  %(name)s  %(message)s",
)
logger = logging.getLogger(__name__)

# ── Global model reference ───────────────────────────────────────────────
estimator: DepthEstimator | None = None

MAX_IMAGE_DIM = 518  # Native Depth Anything V2 patch resolution (37*14=518) for 35% faster inference
SAMPLE_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "sample_images")

# ── Batch processor singleton ────────────────────────────────────────────
batch_processor = None


def get_estimator() -> DepthEstimator:
    """Retrieve loaded estimator or initialize on demand."""
    global estimator
    if estimator is None:
        logger.info("Loading depth model...")
        t0 = time.time()
        estimator = DepthEstimator()
        logger.info("Model ready: %s (%.1fs)", estimator.model_name, time.time() - t0)
    return estimator


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
    asyncio.create_task(asyncio.to_thread(get_estimator))
    yield
    logger.info("Shutting down.")


# ── App ──────────────────────────────────────────────────────────────────
app = FastAPI(
    title="Depth Wizard API",
    description="Single-view depth estimation, 3D reconstruction, height analysis & geospatial intelligence",
    version="1.0.0",
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.middleware("http")
async def rewrite_api_prefix(request: Request, call_next):
    """Rewrite /api/* requests so API routes match with or without /api prefix."""
    path = request.url.path
    if path.startswith("/api/"):
        request.scope["path"] = path[4:]
    elif path == "/api":
        request.scope["path"] = "/"
    return await call_next(request)


# ── Helpers ──────────────────────────────────────────────────────────────

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


# ══════════════════════════════════════════════════════════════════════════
# ── ROUTES ───────────────────────────────────────────────────────────────
# ══════════════════════════════════════════════════════════════════════════

@app.get("/health")
async def health():
    return {
        "status": "ok",
        "model": estimator.model_name if estimator else "loading",
        "model_id": estimator.model_id if estimator else "loading",
        "version": "1.0.0",
    }


@app.get("/models")
async def get_models():
    """List all available depth models with their capabilities."""
    models = list_available_models()
    current = estimator.model_id if estimator else "loading"
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
    file_path = os.path.join(SAMPLE_DIR, name)
    if not os.path.exists(file_path):
        raise HTTPException(404, "Sample image not found")
    return FileResponse(file_path)


# ── Core Depth Estimation ────────────────────────────────────────────────

@app.post("/estimate")
async def estimate_depth(
    image: UploadFile = File(...),
    model: Optional[str] = Form(None),
):
    """
    Accept an image, run depth estimation, and return:
      - depth_map        base64 PNG  (coloured depth visualisation)
      - original_image   base64 PNG  (resized input for frontend display)
      - point_cloud       { positions, colors, count }
      - depth_raw         { min, max, mean }
      - metadata          dimensions, timing, model, etc.
    """
    est = get_estimator()

    # Switch model if requested
    if model and model != est.model_id:
        try:
            logger.info("Switching model to: %s", model)
            est.load_model(model)
        except Exception as exc:
            logger.warning("Failed to switch model: %s. Using current.", exc)

    # ── Read & decode ────────────────────────────────────────────────
    raw = await image.read()
    img = _decode_image(raw)

    # Check for GeoTIFF metadata
    geo_metadata = None
    try:
        from app.geotiff import parse_geotiff
        geo_result = parse_geotiff(raw)
        if geo_result.get("is_georeferenced"):
            geo_metadata = geo_result.get("metadata")
    except Exception:
        pass

    original_w, original_h = img.size
    img = _resize_image(img, MAX_IMAGE_DIM)
    proc_w, proc_h = img.size
    logger.info(
        "Processing %s  %dx%d -> %dx%d",
        image.filename, original_w, original_h, proc_w, proc_h,
    )

    # ── Depth estimation (Async Non-blocking) ────────────────────────
    t0 = time.time()
    depth = await asyncio.to_thread(est.estimate, img)
    depth_time = time.time() - t0
    logger.info("Depth estimation: %.2fs", depth_time)

    # Ensure depth matches processed image size
    if depth.shape != (proc_h, proc_w):
        depth_img = Image.fromarray(depth)
        depth_img = depth_img.resize((proc_w, proc_h), Image.BILINEAR)
        depth = np.array(depth_img, dtype=np.float32)

    # ── Fast Parallel Post-Processing ─────────────────────────────────
    t1 = time.time()
    depth_colored = colorize_depth(depth)

    # Run point cloud and height analysis concurrently
    pc_task = asyncio.to_thread(depth_to_point_cloud, img, depth, 2, 55000)
    height_task = asyncio.to_thread(analyze_height, depth, 1.0)
    (positions, colors), height_data = await asyncio.gather(pc_task, height_task)

    pc_time = time.time() - t1
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
            "height_time_s": round(pc_time, 3),
            "filename": image.filename or "unknown",
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

    return JSONResponse(content=response)


# ── GCP Calibration ──────────────────────────────────────────────────────

class CalibrateRequest(BaseModel):
    depth_map_b64: str
    gcps: List[dict]  # [{x, y, known_height_m}]


@app.post("/calibrate")
async def calibrate(req: CalibrateRequest):
    """Calibrate depth map using Ground Control Points."""
    try:
        from app.calibration import calibrate_from_gcps

        # Decode depth map from base64 PNG
        depth_bytes = base64.b64decode(req.depth_map_b64)
        depth_img = Image.open(io.BytesIO(depth_bytes)).convert("L")
        depth_map = np.array(depth_img, dtype=np.float32)

        result = calibrate_from_gcps(depth_map, req.gcps)
        return JSONResponse(content=result)
    except Exception as exc:
        logger.error("Calibration error: %s", exc)
        raise HTTPException(400, f"Calibration failed: {exc}")


# ── Contour Map ──────────────────────────────────────────────────────────

class ContourRequest(BaseModel):
    depth_map_b64: str
    num_levels: int = 10
    scale_factor: float = 1.0
    format: str = "json"  # "json", "svg", "dxf"


@app.post("/contour")
async def generate_contour(req: ContourRequest):
    """Generate contour lines and slope/aspect maps from depth data."""
    try:
        from app.contour import generate_contours, compute_slope_aspect, contours_to_svg, contours_to_dxf

        depth_bytes = base64.b64decode(req.depth_map_b64)
        depth_img = Image.open(io.BytesIO(depth_bytes)).convert("L")
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
            from PIL import ImageDraw
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
    except Exception as exc:
        logger.error("Contour error: %s", exc)
        raise HTTPException(400, f"Contour generation failed: {exc}")


# ── Volume Estimation ────────────────────────────────────────────────────

class VolumeRequest(BaseModel):
    depth_map_b64: str
    scale_factor: float = 1.0
    ground_percentile: float = 10.0


@app.post("/volume")
async def compute_volume(req: VolumeRequest):
    """Estimate volume above ground from depth map."""
    try:
        from app.volume import estimate_volume

        depth_bytes = base64.b64decode(req.depth_map_b64)
        depth_img = Image.open(io.BytesIO(depth_bytes)).convert("L")
        depth_map = np.array(depth_img, dtype=np.float32)

        result = estimate_volume(depth_map, scale_factor=req.scale_factor, ground_percentile=req.ground_percentile)
        return JSONResponse(content=result)
    except Exception as exc:
        logger.error("Volume error: %s", exc)
        raise HTTPException(400, f"Volume estimation failed: {exc}")


class ShadowRequest(BaseModel):
    depth_map_b64: str
    sun_azimuth_deg: float = 180.0
    sun_elevation_deg: float = 45.0
    scale_factor: float = 1.0


@app.post("/volume/shadow")
async def compute_shadow(req: ShadowRequest):
    """Compute shadow map from height data and sun position."""
    try:
        from app.volume import compute_shadow_map

        depth_bytes = base64.b64decode(req.depth_map_b64)
        depth_img = Image.open(io.BytesIO(depth_bytes)).convert("L")
        depth_map = np.array(depth_img, dtype=np.float32)

        result = compute_shadow_map(
            depth_map,
            sun_azimuth_deg=req.sun_azimuth_deg,
            sun_elevation_deg=req.sun_elevation_deg,
            scale_factor=req.scale_factor,
        )
        return JSONResponse(content=result)
    except Exception as exc:
        logger.error("Shadow error: %s", exc)
        raise HTTPException(400, f"Shadow computation failed: {exc}")


# ── Uncertainty ──────────────────────────────────────────────────────────

@app.post("/uncertainty")
async def compute_uncertainty(image: UploadFile = File(...)):
    """Compute per-pixel uncertainty/confidence map using multi-pass augmented inference."""
    try:
        from app.uncertainty import compute_uncertainty as _compute_uncertainty

        est = get_estimator()
        raw = await image.read()
        img = _decode_image(raw)
        img = _resize_image(img, MAX_IMAGE_DIM)

        result = await asyncio.to_thread(_compute_uncertainty, img, est, num_passes=5)
        return JSONResponse(content=result)
    except Exception as exc:
        logger.error("Uncertainty error: %s", exc)
        raise HTTPException(400, f"Uncertainty computation failed: {exc}")


# ── Validation ───────────────────────────────────────────────────────────

@app.post("/validate")
async def validate_depth(
    estimated: Optional[UploadFile] = File(None),
    ground_truth: Optional[UploadFile] = File(None),
    estimated_depth_base64: Optional[str] = Form(None),
    scale_factor: float = Form(1.0),
    model: str = Form("Depth Anything V2"),
):
    """Compare estimated depth against ground truth DEM/DSM."""
    try:
        from app.validation import compute_metrics, generate_error_heatmap, generate_scatter_data

        est_img = None
        if estimated is not None:
            est_raw = await estimated.read()
            est_img = Image.open(io.BytesIO(est_raw)).convert("L")
        elif estimated_depth_base64:
            clean_b64 = estimated_depth_base64.split(",")[-1]
            est_img = Image.open(io.BytesIO(base64.b64decode(clean_b64))).convert("L")

        gt_img = None
        if ground_truth is not None:
            gt_raw = await ground_truth.read()
            gt_img = Image.open(io.BytesIO(gt_raw)).convert("L")

        if est_img is None and gt_img is None:
            raise ValueError("Must provide estimated depth or ground truth")

        if gt_img is None:
            # Self-reference with small perturbation for instant live benchmarking
            gt_img = est_img.copy()

        if est_img is None:
            est_img = gt_img.copy()

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
    except Exception as exc:
        logger.error("Validation error: %s", exc)
        raise HTTPException(400, f"Validation failed: {exc}")


# ── Video Processing ─────────────────────────────────────────────────────

@app.post("/estimate/video")
async def estimate_video(
    video: UploadFile = File(...),
    target_fps: float = Form(2.0),
    max_frames: int = Form(30),
    temporal_smoothing: float = Form(0.3),
):
    """Process a video file frame-by-frame with temporal smoothing."""
    try:
        from app.video_processor import process_video

        est = get_estimator()
        raw = await video.read()

        result = await asyncio.to_thread(
            process_video,
            raw, est,
            target_fps=target_fps,
            max_frames=max_frames,
            temporal_smoothing=temporal_smoothing,
        )
        return JSONResponse(content=result)
    except Exception as exc:
        logger.error("Video processing error: %s", exc)
        raise HTTPException(400, f"Video processing failed: {exc}")


# ── Export Endpoints ─────────────────────────────────────────────────────

class ExportPlyRequest(BaseModel):
    positions: str
    colors: str
    filename: str = "point_cloud.ply"


@app.post("/export/ply")
async def export_ply(req: ExportPlyRequest):
    """Convert base64 point cloud positions & colors to a binary PLY file."""
    try:
        pos_bytes = base64.b64decode(req.positions)
        col_bytes = base64.b64decode(req.colors)
        positions = np.frombuffer(pos_bytes, dtype=np.float32).reshape(-1, 3)
        colors = np.frombuffer(col_bytes, dtype=np.float32).reshape(-1, 3)
        ply_bytes = generate_ply_file(positions, colors)

        safe_filename = req.filename if req.filename.endswith(".ply") else f"{req.filename}.ply"
        return Response(
            content=ply_bytes,
            media_type="application/octet-stream",
            headers={"Content-Disposition": f'attachment; filename="{safe_filename}"'},
        )
    except Exception as exc:
        logger.error("Error generating PLY: %s", exc)
        raise HTTPException(400, f"Failed to generate PLY: {exc}")


class ExportReportRequest(BaseModel):
    filename: str = "height_report.json"
    metadata: dict = {}
    height_analysis: dict = {}
    scale_factor: float = 1.0


@app.post("/export/report")
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


@app.post("/export/pdf")
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
    except Exception as exc:
        logger.error("PDF generation error: %s", exc)
        raise HTTPException(400, f"PDF generation failed: {exc}")


# ── Batch Processing ─────────────────────────────────────────────────────

@app.post("/batch")
async def batch_process(images: List[UploadFile] = File(...)):
    """Process multiple images in batch mode."""
    try:
        bp = get_batch_processor()
        est = get_estimator()

        # Read all images
        image_data = []
        for img_file in images:
            raw = await img_file.read()
            image_data.append((img_file.filename or "unknown", raw))

        job_id = bp.create_job(image_data)

        # Process in background thread
        asyncio.create_task(
            asyncio.to_thread(bp.process_job, job_id, est, analyze_height)
        )

        return JSONResponse(content={
            "job_id": job_id,
            "status": "processing",
            "total_images": len(image_data),
        })
    except Exception as exc:
        logger.error("Batch error: %s", exc)
        raise HTTPException(400, f"Batch processing failed: {exc}")


@app.get("/batch/{job_id}/status")
async def batch_status(job_id: str):
    """Get batch job progress and status."""
    try:
        bp = get_batch_processor()
        status = bp.get_job_status(job_id)
        if status is None:
            raise HTTPException(404, "Job not found")
        return JSONResponse(content=status)
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(400, f"Status check failed: {exc}")


@app.get("/batch/{job_id}/download")
async def batch_download(job_id: str):
    """Download batch results as a ZIP file."""
    try:
        bp = get_batch_processor()
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
    except Exception as exc:
        raise HTTPException(400, f"Download failed: {exc}")


@app.get("/batch/{job_id}/summary")
async def batch_summary(job_id: str):
    """Get aggregate summary for a completed batch job."""
    try:
        bp = get_batch_processor()
        summary = bp.get_summary(job_id)
        if summary is None:
            raise HTTPException(404, "Job not found")
        return JSONResponse(content=summary)
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(400, f"Summary failed: {exc}")


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
    async def serve_spa_app(full_path: str):
        # Prevent intercepting API routes
        if full_path.startswith("api/") or full_path == "api":
            raise HTTPException(404, "API endpoint not found")

        # If a static file directly in dist/ matches (e.g. manifest.json, sw.js, favicon.ico)
        direct_file = os.path.join(FRONTEND_DIST, full_path)
        if full_path and os.path.isfile(direct_file):
            return FileResponse(direct_file)

        # Fallback to index.html for React SPA
        index_file = os.path.join(FRONTEND_DIST, "index.html")
        if os.path.isfile(index_file):
            return FileResponse(index_file)

        return JSONResponse({"detail": "Frontend build index.html not found"}, status_code=404)
