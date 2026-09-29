"""
Video / Multi-Frame Processing for Depth Wizard.

Accepts video files, extracts frames at configurable FPS,
runs depth estimation per frame with temporal smoothing.
Uses OpenCV for frame extraction.
"""
import io
import os
import base64
import logging
import tempfile
from typing import List, Dict, Optional, Callable, Any, Tuple
import numpy as np
from PIL import Image

try:
    import cv2
    HAS_OPENCV = True
except ImportError:
    cv2 = None
    HAS_OPENCV = False

logger = logging.getLogger(__name__)


def _pil_to_base64(img: Image.Image, fmt: str = "PNG") -> str:
    """Convert a PIL Image to a base64-encoded PNG string."""
    buf = io.BytesIO()
    img.save(buf, format=fmt)
    return base64.b64encode(buf.getvalue()).decode("utf-8")


def _ndarray_to_base64(arr: np.ndarray) -> str:
    """Convert a numpy array buffer to a base64-encoded string."""
    return base64.b64encode(arr.tobytes()).decode("utf-8")


def extract_frames(
    video_bytes: bytes,
    target_fps: float = 2.0,
    max_frames: int = 30,
) -> List[Image.Image]:
    """
    Extract frames from video bytes at a target frame rate.

    Uses OpenCV VideoCapture on a temporary file to decode video frames.

    Args:
        video_bytes: Raw binary video data (e.g. MP4, AVI, MOV).
        target_fps: Desired sampling rate in frames per second (default 2.0).
        max_frames: Upper cap on the total number of frames to extract (default 30).

    Returns:
        List of PIL RGB Images extracted from the video.

    Raises:
        ImportError: If opencv-python is not installed.
        ValueError: If video bytes are empty or cannot be opened.
    """
    if not HAS_OPENCV:
        error_msg = (
            "OpenCV (cv2) is not installed. Please install 'opencv-python' "
            "to enable video frame extraction and processing."
        )
        logger.error(error_msg)
        raise ImportError(error_msg)

    if not video_bytes:
        raise ValueError("Video data is empty.")

    # Write video bytes to a temporary file
    temp_fd, temp_path = tempfile.mkstemp(suffix=".mp4")
    try:
        with os.fdopen(temp_fd, "wb") as f:
            f.write(video_bytes)

        cap = cv2.VideoCapture(temp_path)
        if not cap.isOpened():
            raise ValueError("Could not open video file with OpenCV. Invalid or unsupported format.")

        source_fps = cap.get(cv2.CAP_PROP_FPS)
        if source_fps <= 0.0 or np.isnan(source_fps):
            logger.warning("Invalid or undetectable FPS (%.2f); defaulting to 30.0 FPS.", source_fps)
            source_fps = 30.0

        total_source_frames = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
        logger.info(
            "Video opened successfully: %.2f source FPS, ~%d total frames. Target FPS: %.2f (max %d frames).",
            source_fps, total_source_frames, target_fps, max_frames
        )

        # Calculate stride interval between frames
        if target_fps > 0:
            frame_interval = max(1, int(round(source_fps / target_fps)))
        else:
            frame_interval = 1

        frames: List[Image.Image] = []
        frame_idx = 0

        while cap.isOpened() and len(frames) < max_frames:
            ret, frame = cap.read()
            if not ret:
                break

            if frame_idx % frame_interval == 0:
                # Convert BGR (OpenCV) to RGB (PIL)
                frame_rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
                frames.append(Image.fromarray(frame_rgb))

            frame_idx += 1

        cap.release()
        logger.info("Extracted %d frames from video (sampled every %d frames).", len(frames), frame_interval)
        return frames

    finally:
        if os.path.exists(temp_path):
            try:
                os.remove(temp_path)
            except Exception as exc:
                logger.warning("Could not delete temporary video file %s: %s", temp_path, exc)


def process_video(
    video_bytes: bytes,
    depth_estimator: Any,
    target_fps: float = 2.0,
    max_frames: int = 30,
    temporal_smoothing: float = 0.3,
) -> Dict[str, Any]:
    """
    Process a video file, estimating depth maps across frames with temporal EMA smoothing.

    Args:
        video_bytes: Raw binary video file bytes.
        depth_estimator: An object with an `.estimate(image)` method or a callable `(image) -> np.ndarray`.
        target_fps: Rate of frame extraction in frames per second.
        max_frames: Maximum number of frames to process.
        temporal_smoothing: Exponential moving average smoothing factor alpha in [0.0, 1.0].
                            0.0 = no smoothing (raw frame depth),
                            0.3 = 70% current frame + 30% previous frame.

    Returns:
        Dictionary containing:
            - status: "success" or "error"
            - frames: list of frame result dictionaries
            - total_frames: number of processed frames
            - fps: target extraction FPS
            - temporal_smoothing: applied smoothing coefficient
            - temporal_coherence_score: float metric in [0.0, 1.0] indicating inter-frame stability
            - aggregated_point_cloud: dict with base64 positions, colors, and count
            - error: error message if status == "error"
    """
    from app.depth import colorize_depth
    from app.mesh import depth_to_point_cloud

    if not HAS_OPENCV:
        return {
            "status": "error",
            "error": "OpenCV (cv2) is not installed. Please install opencv-python to use video processing.",
            "frames": [],
            "total_frames": 0,
            "fps": target_fps,
            "temporal_smoothing": temporal_smoothing,
            "temporal_coherence_score": 0.0,
            "aggregated_point_cloud": None,
        }

    try:
        frames = extract_frames(video_bytes, target_fps=target_fps, max_frames=max_frames)
    except Exception as exc:
        logger.error("Failed to extract frames from video: %s", exc)
        return {
            "status": "error",
            "error": f"Failed to extract video frames: {str(exc)}",
            "frames": [],
            "total_frames": 0,
            "fps": target_fps,
            "temporal_smoothing": temporal_smoothing,
            "temporal_coherence_score": 0.0,
            "aggregated_point_cloud": None,
        }

    if not frames:
        return {
            "status": "error",
            "error": "No frames could be extracted from the video stream.",
            "frames": [],
            "total_frames": 0,
            "fps": target_fps,
            "temporal_smoothing": temporal_smoothing,
            "temporal_coherence_score": 0.0,
            "aggregated_point_cloud": None,
        }

    alpha = float(np.clip(temporal_smoothing, 0.0, 0.95))
    frame_results = []
    smoothed_depth_maps: List[np.ndarray] = []
    coherence_scores: List[float] = []
    prev_smoothed: Optional[np.ndarray] = None

    for idx, frame_img in enumerate(frames):
        # Estimate depth
        try:
            if hasattr(depth_estimator, "estimate"):
                raw_depth = depth_estimator.estimate(frame_img)
            elif callable(depth_estimator):
                raw_depth = depth_estimator(frame_img)
            else:
                raise TypeError("depth_estimator must have an 'estimate' method or be callable.")
        except Exception as exc:
            logger.error("Error running depth estimation on frame %d: %s", idx, exc)
            return {
                "status": "error",
                "error": f"Depth estimation failed on frame {idx}: {str(exc)}",
                "frames": frame_results,
                "total_frames": len(frame_results),
                "fps": target_fps,
                "temporal_smoothing": temporal_smoothing,
                "temporal_coherence_score": 0.0,
                "aggregated_point_cloud": None,
            }

        current_depth = np.asarray(raw_depth, dtype=np.float32)

        # Apply Exponential Moving Average (EMA) temporal smoothing
        if prev_smoothed is not None and alpha > 0.0:
            # Ensure spatial dimensions match
            if prev_smoothed.shape != current_depth.shape:
                prev_pil = Image.fromarray(prev_smoothed)
                prev_pil = prev_pil.resize((current_depth.shape[1], current_depth.shape[0]), Image.BILINEAR)
                prev_aligned = np.array(prev_pil, dtype=np.float32)
            else:
                prev_aligned = prev_smoothed

            smoothed_depth = (1.0 - alpha) * current_depth + alpha * prev_aligned

            # Compute inter-frame relative normalized difference for temporal coherence
            diff = np.abs(smoothed_depth - prev_aligned)
            denom = np.abs(smoothed_depth) + np.abs(prev_aligned) + 1e-6
            rel_diff = float(np.mean(diff / denom))
            frame_coherence = float(np.clip(1.0 - rel_diff, 0.0, 1.0))
            coherence_scores.append(frame_coherence)
        else:
            smoothed_depth = current_depth.copy()
            coherence_scores.append(1.0)

        prev_smoothed = smoothed_depth
        smoothed_depth_maps.append(smoothed_depth)

        # Colorize smoothed depth map and serialize
        colored_depth = colorize_depth(smoothed_depth)
        depth_b64 = _pil_to_base64(colored_depth)
        orig_b64 = _pil_to_base64(frame_img)

        depth_stats = {
            "min": round(float(smoothed_depth.min()), 4),
            "max": round(float(smoothed_depth.max()), 4),
            "mean": round(float(smoothed_depth.mean()), 4),
            "std": round(float(smoothed_depth.std()), 4),
        }

        frame_results.append({
            "frame_index": idx,
            "timestamp_s": round(idx / max(target_fps, 0.001), 2),
            "depth_map_base64": depth_b64,
            "original_image_base64": orig_b64,
            "depth_stats": depth_stats,
        })

    # Overall temporal coherence metric
    avg_coherence = float(np.mean(coherence_scores)) if coherence_scores else 1.0

    # Build aggregated multi-frame point cloud
    # Sample up to 4 representative keyframes evenly distributed across the sequence
    num_frames = len(frames)
    key_frame_indices = np.unique(np.linspace(0, num_frames - 1, min(num_frames, 4), dtype=int))

    all_positions = []
    all_colors = []
    pts_per_frame = max(1000, 100_000 // len(key_frame_indices))

    for k_idx in key_frame_indices:
        pos, col = depth_to_point_cloud(
            frames[k_idx],
            smoothed_depth_maps[k_idx],
            step=3,
            max_points=pts_per_frame,
        )
        all_positions.append(pos)
        all_colors.append(col)

    if all_positions:
        aggregated_positions = np.concatenate(all_positions, axis=0).astype(np.float32)
        aggregated_colors = np.concatenate(all_colors, axis=0).astype(np.float32)
    else:
        aggregated_positions = np.empty((0, 3), dtype=np.float32)
        aggregated_colors = np.empty((0, 3), dtype=np.float32)

    aggregated_pc = {
        "positions": _ndarray_to_base64(aggregated_positions),
        "colors": _ndarray_to_base64(aggregated_colors),
        "count": int(len(aggregated_positions)),
    }

    return {
        "status": "success",
        "total_frames": len(frame_results),
        "fps": target_fps,
        "temporal_smoothing": temporal_smoothing,
        "temporal_coherence_score": round(avg_coherence, 4),
        "frames": frame_results,
        "aggregated_point_cloud": aggregated_pc,
    }
