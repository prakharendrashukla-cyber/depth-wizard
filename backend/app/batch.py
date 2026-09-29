"""
Batch Processing Engine for Depth Wizard.

Processes multiple images sequentially with progress tracking.
Returns individual results + aggregated summary statistics and packages
outputs into downloadable ZIP archives containing colorized depth maps and metrics JSONs.
"""

import io
import os
import time
import zipfile
import base64
import json
import uuid
import logging
import threading
from app.config import BATCH_TTL
from typing import Dict, List, Optional, Callable, Tuple, Any

from PIL import Image
import numpy as np

from app.depth import colorize_depth
from app.height import analyze_height

logger = logging.getLogger(__name__)

MAX_BATCH_IMAGE_DIM = 640


def _pil_to_png_bytes(img: Image.Image) -> bytes:
    """Convert a PIL image to PNG binary bytes."""
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    return buf.getvalue()


def _resize_image_preserve_aspect(img: Image.Image, max_dim: int = MAX_BATCH_IMAGE_DIM) -> Image.Image:
    """Resize image so its longest edge <= max_dim, preserving aspect ratio."""
    w, h = img.size
    if max(w, h) <= max_dim:
        return img
    scale = max_dim / max(w, h)
    new_w = max(1, int(w * scale))
    new_h = max(1, int(h * scale))
    return img.resize((new_w, new_h), Image.LANCZOS)


class BatchJob:
    """
    Data model representing an asynchronous or synchronous batch processing job.
    """

    def __init__(self, job_id: str, total_images: int):
        self.expires_at = float("inf")
        self.job_id: str = job_id
        self.status: str = "pending"  # 'pending', 'processing', 'done', 'error'
        self.total_images: int = total_images
        self.processed_count: int = 0
        self.results: List[Dict[str, Any]] = []
        self.created_at: str = time.strftime("%Y-%m-%d %H:%M:%S UTC", time.gmtime())
        self.completed_at: Optional[str] = None
        self.progress_pct: float = 0.0
        self.error_message: Optional[str] = None
        self.model_name: str = "unknown"

    def update_progress(self) -> None:
        """Recalculate percentage progress from processed_count and total_images."""
        if self.total_images > 0:
            self.progress_pct = round((self.processed_count / self.total_images) * 100.0, 1)
        else:
            self.progress_pct = 100.0

    def to_dict(self, include_images: bool = True) -> Dict[str, Any]:
        """
        Serialize job state to a clean JSON-compatible dictionary.
        
        Args:
            include_images: Whether to include heavy base64 depth map strings in the output.
        """
        serializable_results = []
        for r in self.results:
            item = dict(r)
            # Exclude raw internal binary buffers from dictionary serialization
            item.pop("_depth_map_png_bytes", None)
            if not include_images:
                item.pop("depth_map_b64", None)
            serializable_results.append(item)

        return {
            "job_id": self.job_id,
            "status": self.status,
            "total_images": self.total_images,
            "processed_count": self.processed_count,
            "progress_pct": self.progress_pct,
            "created_at": self.created_at,
            "completed_at": self.completed_at,
            "error_message": self.error_message,
            "model_name": self.model_name,
            "results": serializable_results,
        }


class BatchProcessor:
    """
    Batch processor for sequential multi-image depth estimation and relief analysis.
    Manages job lifecycle, per-image progress, statistics aggregation, and ZIP packaging.
    """

    def __init__(self):
        self._lock = threading.RLock()
        self.jobs: Dict[str, BatchJob] = {}
        self._job_images: Dict[str, List[Tuple[str, bytes]]] = {}

    def cleanup(self):
        with self._lock:
            for job_id, job in list(self.jobs.items()):
                if job.expires_at <= time.time():
                    self.jobs.pop(job_id, None)
                    self._job_images.pop(job_id, None)

    def create_job(self, images: List[Tuple[str, bytes]]) -> str:
        """
        Create a new batch processing job from a list of (filename, image_bytes) tuples.

        Args:
            images: List of (filename, raw_bytes) tuples.

        Returns:
            str: Unique UUID string identifier for the job.
        """
        if not images:
            raise ValueError("Cannot create a batch job with an empty image list.")

        self.cleanup()
        job_id = str(uuid.uuid4())
        job = BatchJob(job_id=job_id, total_images=len(images))
        self.jobs[job_id] = job
        self._job_images[job_id] = list(images)

        logger.info("Created batch job %s with %d images.", job_id, len(images))
        return job_id

    def process_job(
        self,
        job_id: str,
        depth_estimator: Any,
        analyze_height_fn: Optional[Callable[..., dict]] = None,
        scale_factor: float = 1.0,
        progress_callback: Optional[Callable[[BatchJob], None]] = None,
    ) -> None:
        """
        Process all images in the job sequentially.

        Args:
            job_id: The ID of the job to process.
            depth_estimator: Object with `estimate(PIL.Image) -> np.ndarray` method and `model_name` attr.
            analyze_height_fn: Optional custom height analysis function (defaults to app.height.analyze_height).
            scale_factor: Calibration multiplier in meters per relative unit.
            progress_callback: Optional callback invoked after each image is processed.
        """
        if job_id not in self.jobs:
            from fastapi import HTTPException
            raise HTTPException(404, "Job not found")

        job = self.jobs[job_id]
        images = self._job_images.get(job_id, [])

        if not images:
            job.status = "done"
            job.completed_at = time.strftime("%Y-%m-%d %H:%M:%S UTC", time.gmtime())
            return

        if analyze_height_fn is None:
            analyze_height_fn = analyze_height

        job.status = "processing"
        job.model_name = getattr(depth_estimator, "model_name", "depth-estimator")
        logger.info("Starting processing for batch job %s (%d images) with model %s", job_id, len(images), job.model_name)

        successful_count = 0

        for idx, (filename, img_bytes) in enumerate(images):
            t_start = time.time()
            logger.info("Job %s: Processing [%d/%d] %s", job_id, idx + 1, len(images), filename)

            try:
                # Decode image
                pil_img = Image.open(io.BytesIO(img_bytes)).convert("RGB")
                orig_w, orig_h = pil_img.size

                # Resize for consistent batch performance
                proc_img = _resize_image_preserve_aspect(pil_img, MAX_BATCH_IMAGE_DIM)
                proc_w, proc_h = proc_img.size

                # Depth estimation
                t_est_0 = time.time()
                depth = depth_estimator.estimate(proc_img)
                est_time = time.time() - t_est_0

                # Ensure dimensions match
                if depth.shape != (proc_h, proc_w):
                    depth_pil = Image.fromarray(depth).resize((proc_w, proc_h), Image.LANCZOS)
                    depth = np.array(depth_pil, dtype=np.float32)

                # Colorize depth map
                depth_colored = colorize_depth(depth)
                png_bytes = _pil_to_png_bytes(depth_colored)
                b64_depth = base64.b64encode(png_bytes).decode("ascii")

                # Height & relief analysis
                t_ht_0 = time.time()
                height_data = analyze_height_fn(depth, scale_factor=scale_factor)
                ht_time = time.time() - t_ht_0

                total_img_time = time.time() - t_start

                depth_stats = {
                    "min": float(depth.min()),
                    "max": float(depth.max()),
                    "mean": float(depth.mean()),
                    "std": float(depth.std()),
                }

                result_entry = {
                    "index": idx,
                    "filename": filename,
                    "status": "success",
                    "metadata": {
                        "original_width": orig_w,
                        "original_height": orig_h,
                        "processed_width": proc_w,
                        "processed_height": proc_h,
                        "depth_time_s": round(est_time, 3),
                        "height_time_s": round(ht_time, 3),
                        "total_time_s": round(total_img_time, 3),
                        "model": job.model_name,
                    },
                    "depth_stats": depth_stats,
                    "height_analysis": height_data,
                    "depth_map_b64": b64_depth,
                    "_depth_map_png_bytes": png_bytes,
                }
                job.results.append(result_entry)
                successful_count += 1

            except Exception as exc:
                logger.error("Job %s: Failed processing image %s: %s", job_id, filename, exc, exc_info=True)
                job.results.append({
                    "index": idx,
                    "filename": filename,
                    "status": "error",
                    "error_message": "Unable to process this image",
                    "metadata": {
                        "total_time_s": round(time.time() - t_start, 3),
                    }
                })

            job.processed_count = idx + 1
            job.update_progress()

            if progress_callback is not None:
                try:
                    progress_callback(job)
                except Exception as cb_exc:
                    logger.warning("Progress callback error: %s", cb_exc)

        # Finalize job status
        if successful_count > 0:
            job.status = "done"
        else:
            job.status = "error"
            job.error_message = "All images in the batch failed to process."

        job.completed_at = time.strftime("%Y-%m-%d %H:%M:%S UTC", time.gmtime())
        job.expires_at = time.time() + BATCH_TTL
        self._job_images.pop(job_id, None)
        if progress_callback:
            progress_callback(job)
        logger.info("Batch job %s finished with status '%s' (%d/%d succeeded).", job_id, job.status, successful_count, len(images))

    def get_job_status(self, job_id: str) -> Dict[str, Any]:
        """
        Get the current status, progress, and results of a batch job.

        Args:
            job_id: The job identifier.

        Returns:
            Dictionary containing job status and summary.
        """
        if job_id not in self.jobs:
            from fastapi import HTTPException
            raise HTTPException(404, "Job not found")

        job = self.jobs[job_id]
        status_dict = job.to_dict(include_images=True)
        
        if job.status == "done":
            status_dict["summary"] = self.get_summary(job_id)

        return status_dict

    def get_summary(self, job_id: str) -> Dict[str, Any]:
        """
        Compute aggregated statistics across all successfully processed images in the batch.

        Args:
            job_id: The job identifier.

        Returns:
            Dictionary containing aggregate relief, heights, area, timing, and model info.
        """
        if job_id not in self.jobs:
            from fastapi import HTTPException
            raise HTTPException(404, "Job not found")

        job = self.jobs[job_id]
        successful = [r for r in job.results if r.get("status") == "success"]
        failed = [r for r in job.results if r.get("status") == "error"]

        if not successful:
            return {
                "job_id": job_id,
                "total_images": job.total_images,
                "successful_images": 0,
                "failed_images": len(failed),
                "avg_relief": 0.0,
                "min_height": 0.0,
                "max_height": 0.0,
                "avg_mean_height": 0.0,
                "total_area_analyzed_pixels": 0,
                "total_processing_time_s": 0.0,
                "avg_time_per_image_s": 0.0,
                "model_name": job.model_name,
            }

        relief_values = []
        mean_height_values = []
        min_depth_values = []
        max_depth_values = []
        total_pixels = 0
        total_time = 0.0

        for r in successful:
            h_data = r.get("height_analysis", {})
            cal_m = h_data.get("calibrated_metrics", {})
            rel_m = h_data.get("relative_metrics", {})
            meta = r.get("metadata", {})
            
            # Relief
            relief = cal_m.get("max_height_m", rel_m.get("relative_relief", 0.0))
            relief_values.append(relief)

            # Mean height
            mean_h = cal_m.get("mean_height_m", rel_m.get("mean_elevation", 0.0))
            mean_height_values.append(mean_h)

            # Min / Max depth bounds
            raw_s = h_data.get("raw_stats", r.get("depth_stats", {}))
            min_depth_values.append(raw_s.get("min_depth", 0.0))
            max_depth_values.append(raw_s.get("max_depth", 0.0))

            # Area
            pw = meta.get("processed_width", 0)
            ph = meta.get("processed_height", 0)
            total_pixels += (pw * ph)

            # Time
            total_time += meta.get("total_time_s", 0.0)

        avg_relief = float(np.mean(relief_values)) if relief_values else 0.0
        avg_mean_height = float(np.mean(mean_height_values)) if mean_height_values else 0.0
        min_height = float(np.min(min_depth_values)) if min_depth_values else 0.0
        max_height = float(np.max(max_depth_values)) if max_depth_values else 0.0
        avg_time = float(total_time / len(successful)) if successful else 0.0

        return {
            "job_id": job_id,
            "total_images": job.total_images,
            "successful_images": len(successful),
            "failed_images": len(failed),
            "avg_relief": round(avg_relief, 3),
            "min_height": round(min_height, 3),
            "max_height": round(max_height, 3),
            "avg_mean_height": round(avg_mean_height, 3),
            "total_area_analyzed_pixels": total_pixels,
            "total_processing_time_s": round(total_time, 3),
            "avg_time_per_image_s": round(avg_time, 3),
            "model_name": job.model_name,
            "created_at": job.created_at,
            "completed_at": job.completed_at,
        }

    def generate_zip(self, job_id: str) -> bytes:
        """
        Package all processed batch results into an in-memory ZIP file.

        ZIP Contents:
          - depth_maps/{filename}_depth.png (Colorized depth map PNG)
          - metrics/{filename}_metrics.json (Per-image elevation and depth metrics)
          - summary.json (Aggregated statistics across the batch)
          - README.txt (Human-readable manifest and batch execution report)

        Args:
            job_id: The job identifier.

        Returns:
            bytes: Binary ZIP data.
        """
        if job_id not in self.jobs:
            from fastapi import HTTPException
            raise HTTPException(404, "Job not found")

        job = self.jobs[job_id]
        summary = self.get_summary(job_id)

        zip_buf = io.BytesIO()

        with zipfile.ZipFile(zip_buf, mode="w", compression=zipfile.ZIP_DEFLATED) as zf:
            # 1. Per-image depth maps and metrics
            for res in job.results:
                if res.get("status") != "success":
                    continue

                raw_filename = res.get("filename", "image")
                base_name = os.path.splitext(os.path.basename(raw_filename))[0]

                # Colorized depth PNG
                png_bytes = res.get("_depth_map_png_bytes")
                if not png_bytes and res.get("depth_map_b64"):
                    try:
                        png_bytes = base64.b64decode(res["depth_map_b64"])
                    except Exception as e:
                        logger.warning("Could not decode depth b64 for %s: %s", raw_filename, e)

                if png_bytes:
                    zf.writestr(f"depth_maps/{base_name}_depth.png", png_bytes)

                # Metrics JSON
                metrics_dict = {
                    "filename": raw_filename,
                    "metadata": res.get("metadata", {}),
                    "depth_stats": res.get("depth_stats", {}),
                    "height_analysis": res.get("height_analysis", {}),
                }
                metrics_json = json.dumps(metrics_dict, indent=2)
                zf.writestr(f"metrics/{base_name}_metrics.json", metrics_json)

            # 2. Batch Summary JSON
            zf.writestr("summary.json", json.dumps(summary, indent=2))

            # 3. Readme / Manifest Text
            readme_lines = [
                "================================================================================",
                "DEPTH WIZARD — BATCH PROCESSING ARCHIVE",
                "================================================================================",
                f"Job ID             : {job.job_id}",
                f"Model Architecture : {job.model_name}",
                f"Status             : {job.status.upper()}",
                f"Created At         : {job.created_at}",
                f"Completed At       : {job.completed_at}",
                f"Total Images       : {job.total_images}",
                f"Successful Images  : {summary.get('successful_images', 0)}",
                f"Failed Images      : {summary.get('failed_images', 0)}",
                "",
                "AGGREGATE TOPOGRAPHICAL STATISTICS:",
                f"  • Average Relief Span : {summary.get('avg_relief', 0.0)} m",
                f"  • Min Height Bound    : {summary.get('min_height', 0.0)}",
                f"  • Max Height Bound    : {summary.get('max_height', 0.0)}",
                f"  • Average Mean Height : {summary.get('avg_mean_height', 0.0)} m",
                f"  • Total Area Analyzed : {summary.get('total_area_analyzed_pixels', 0):,} pixels",
                f"  • Total Runtime       : {summary.get('total_processing_time_s', 0.0)} s",
                f"  • Average Per Image   : {summary.get('avg_time_per_image_s', 0.0)} s",
                "",
                "DIRECTORY STRUCTURE:",
                "  ├── depth_maps/       → Colorized inferno depth maps (PNG)",
                "  ├── metrics/          → Quantitative metrics & transects per image (JSON)",
                "  ├── summary.json      → Aggregate batch statistics",
                "  └── README.txt        → This archive manifest",
                "================================================================================",
            ]
            zf.writestr("README.txt", "\n".join(readme_lines))

        return zip_buf.getvalue()
