"""
GCP Calibration Engine for Depth Wizard.

Accepts ground control points (pixel coords + known real-world heights),
fits a linear/affine calibration model mapping relative depth → absolute meters.
Returns calibrated scale factor, R², RMSE, and residuals per point.
"""

import logging
from typing import Any, Dict, List, Optional, Tuple

import numpy as np

logger = logging.getLogger(__name__)


def calibrate_from_gcps(
    depth_map: np.ndarray,
    gcps: List[Dict[str, Any]],
) -> Dict[str, Any]:
    """
    Fit a calibration model from ground control points (GCPs).

    Each GCP provides a pixel location (x, y) and a known real-world height in meters.
    We sample the depth at each pixel, normalize the depth map to [0, 1],
    then fit the linear relationship:
        height_m = scale_factor * normalized_depth + offset

    Args:
        depth_map: 2D numpy array (H, W) of relative depth values.
        gcps: List of dicts, each containing:
            - "x": float or int, pixel x coordinate (column, 0 <= x < W)
            - "y": float or int, pixel y coordinate (row, 0 <= y < H)
            - "known_height_m" (or "height_m", "height", "z"): float, real-world height in meters

    Returns:
        Dictionary containing:
            - scale_factor: float, fitted multiplier (meters per normalized depth unit)
            - offset: float, fitted baseline offset in meters
            - r_squared: float, coefficient of determination R² (1.0 = perfect fit)
            - rmse: float, root mean square error in meters
            - mae: float, mean absolute error in meters
            - residuals: list of dicts with per-point fit details:
                - gcp_index: int
                - x: float
                - y: float
                - normalized_depth: float
                - actual: float
                - predicted: float
                - error: float (predicted - actual)
                - abs_error: float (|predicted - actual|)
            - confidence: str ("high" if R² > 0.95, "medium" if R² > 0.8, else "low")
            - sample_count: int, number of valid GCPs processed
            - status: str ("success" or "warning" / "insufficient_data")
    """
    if depth_map is None or not isinstance(depth_map, np.ndarray) or depth_map.ndim != 2:
        raise ValueError("depth_map must be a 2D numpy array.")

    h, w = depth_map.shape
    d = depth_map.astype(np.float64)

    # Normalize depth map to [0, 1]
    d_min = float(np.nanmin(d))
    d_max = float(np.nanmax(d))
    span = d_max - d_min
    if span > 1e-7:
        norm_depth = (d - d_min) / span
    else:
        norm_depth = np.zeros_like(d)

    # Filter and extract valid GCP samples
    valid_samples: List[Tuple[int, float, float, float, float]] = []
    # (gcp_index, x, y, sampled_norm_depth, known_height)

    for idx, gcp in enumerate(gcps):
        if not isinstance(gcp, dict):
            continue

        # Extract x and y pixel coordinates
        if "x" not in gcp or "y" not in gcp:
            logger.warning("GCP at index %d missing 'x' or 'y' coordinates, skipping.", idx)
            continue

        x_raw = float(gcp["x"])
        y_raw = float(gcp["y"])

        # Extract known height with fallback keys
        known_height: Optional[float] = None
        for key in ("known_height_m", "height_m", "known_height", "height", "z", "altitude"):
            if key in gcp and gcp[key] is not None:
                try:
                    known_height = float(gcp[key])
                    break
                except (ValueError, TypeError):
                    pass

        if known_height is None:
            logger.warning("GCP at index %d missing known height value, skipping.", idx)
            continue

        # Clamp pixel coordinates to image bounds
        x_px = int(np.clip(round(x_raw), 0, w - 1))
        y_px = int(np.clip(round(y_raw), 0, h - 1))

        # Sample normalized depth at point
        sampled_depth = float(norm_depth[y_px, x_px])

        if np.isnan(sampled_depth) or np.isinf(sampled_depth):
            logger.warning("GCP at index %d sampled NaN/Inf depth value, skipping.", idx)
            continue

        valid_samples.append((idx, x_raw, y_raw, sampled_depth, known_height))

    n_points = len(valid_samples)

    # Handle edge cases for insufficient points
    if n_points == 0:
        logger.warning("No valid GCPs provided for calibration. Returning default unit calibration.")
        return {
            "scale_factor": 1.0,
            "offset": 0.0,
            "r_squared": 0.0,
            "rmse": 0.0,
            "mae": 0.0,
            "residuals": [],
            "confidence": "low",
            "sample_count": 0,
            "status": "insufficient_data",
        }

    depth_values = np.array([s[3] for s in valid_samples], dtype=np.float64)
    actual_heights = np.array([s[4] for s in valid_samples], dtype=np.float64)

    if n_points == 1:
        # Single GCP: anchor baseline to the known point assuming unit scale
        d_val = depth_values[0]
        h_val = actual_heights[0]
        scale_factor = 1.0
        offset = float(h_val - scale_factor * d_val)
        y_pred = scale_factor * depth_values + offset

        residuals = [
            {
                "gcp_index": valid_samples[0][0],
                "x": valid_samples[0][1],
                "y": valid_samples[0][2],
                "normalized_depth": round(float(depth_values[0]), 4),
                "actual": round(float(actual_heights[0]), 4),
                "predicted": round(float(y_pred[0]), 4),
                "error": 0.0,
                "abs_error": 0.0,
            }
        ]

        return {
            "scale_factor": round(scale_factor, 4),
            "offset": round(offset, 4),
            "r_squared": 1.0,
            "rmse": 0.0,
            "mae": 0.0,
            "residuals": residuals,
            "confidence": "low",  # 1 point is inherently low statistical confidence
            "sample_count": 1,
            "status": "single_point_anchor",
        }

    # 2 or more GCPs: Fit linear model height = scale * norm_depth + offset
    # Design matrix A = [norm_depth, 1]
    depth_variance = float(np.var(depth_values))

    if depth_variance < 1e-9:
        # All GCPs have identical depth readings; cannot determine slope
        scale_factor = 0.0
        offset = float(np.mean(actual_heights))
        y_pred = np.full_like(actual_heights, offset)
    else:
        A = np.column_stack([depth_values, np.ones(n_points, dtype=np.float64)])
        params, _, _, _ = np.linalg.lstsq(A, actual_heights, rcond=None)
        scale_factor = float(params[0])
        offset = float(params[1])
        y_pred = scale_factor * depth_values + offset

    # Compute error metrics
    errors = y_pred - actual_heights
    abs_errors = np.abs(errors)
    rmse = float(np.sqrt(np.mean(errors ** 2)))
    mae = float(np.mean(abs_errors))

    # Compute R² (coefficient of determination)
    ss_tot = float(np.sum((actual_heights - np.mean(actual_heights)) ** 2))
    ss_res = float(np.sum(errors ** 2))

    if ss_tot > 1e-12:
        r2 = 1.0 - (ss_res / ss_tot)
    else:
        # If all actual heights are the same and prediction is exact
        r2 = 1.0 if ss_res < 1e-12 else 0.0

    # Bound R² for clean numerical reporting
    r_squared = float(np.clip(r2, -1.0, 1.0))

    # Classify confidence based on R² and point count
    if n_points >= 2 and r_squared > 0.95:
        confidence = "high"
    elif r_squared > 0.80:
        confidence = "medium"
    else:
        confidence = "low"

    # Per-point residual breakdown
    residuals = []
    for i, sample in enumerate(valid_samples):
        gcp_idx, x_pos, y_pos, norm_d, act_h = sample
        pred_h = float(y_pred[i])
        err = float(pred_h - act_h)
        residuals.append(
            {
                "gcp_index": gcp_idx,
                "x": x_pos,
                "y": y_pos,
                "normalized_depth": round(norm_d, 4),
                "actual": round(act_h, 4),
                "predicted": round(pred_h, 4),
                "error": round(err, 4),
                "abs_error": round(abs(err), 4),
            }
        )

    logger.info(
        "GCP Calibration completed: N=%d, scale=%.4f, offset=%.4f, R²=%.4f, RMSE=%.4fm, confidence=%s",
        n_points,
        scale_factor,
        offset,
        r_squared,
        rmse,
        confidence,
    )

    return {
        "scale_factor": round(scale_factor, 4),
        "offset": round(offset, 4),
        "r_squared": round(r_squared, 4),
        "rmse": round(rmse, 4),
        "mae": round(mae, 4),
        "residuals": residuals,
        "confidence": confidence,
        "sample_count": n_points,
        "status": "success",
    }


def apply_calibration(
    depth_map: np.ndarray,
    scale_factor: float,
    offset: float = 0.0,
    normalize: bool = True,
) -> np.ndarray:
    """
    Apply calibration parameters to convert relative depth to absolute height in meters.

    Args:
        depth_map: 2D numpy array (H, W) of depth values.
        scale_factor: Fitted multiplier (meters per normalized depth unit).
        offset: Baseline offset in meters (default 0.0).
        normalize: If True (default), normalizes depth_map to [0, 1] before scaling.
            If False, applies scale_factor and offset directly to raw depth values.

    Returns:
        2D numpy array of float32 absolute heights in meters.
    """
    if depth_map is None or not isinstance(depth_map, np.ndarray) or depth_map.ndim != 2:
        raise ValueError("depth_map must be a 2D numpy array.")

    d = depth_map.astype(np.float32)

    if normalize:
        d_min = float(np.nanmin(d))
        d_max = float(np.nanmax(d))
        span = d_max - d_min
        if span > 1e-7:
            norm_d = (d - d_min) / span
        else:
            norm_d = np.zeros_like(d)
        calibrated_height = norm_d * float(scale_factor) + float(offset)
    else:
        calibrated_height = d * float(scale_factor) + float(offset)

    return calibrated_height.astype(np.float32)
