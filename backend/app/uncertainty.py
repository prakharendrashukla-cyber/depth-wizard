"""
Uncertainty / Confidence Estimation for Depth Wizard.

Computes per-pixel confidence scores using multiple augmented inference passes.
Also detects unreliable regions (sky, reflective surfaces, uniform areas).
"""
import io
import base64
import logging
from typing import Dict, Optional, Tuple, Any, List
import numpy as np
from PIL import Image, ImageFilter, ImageEnhance

logger = logging.getLogger(__name__)

# ── Uncertainty Color Gradient (Green = Confident, Red = Uncertain) ───────
_UNCERTAINTY_POINTS = np.array([
    [0.00,  34, 197,  94],   # Emerald Green (#22c55e) — High Confidence
    [0.25, 132, 204,  22],   # Lime Green    (#84cc16)
    [0.50, 234, 179,   8],   # Amber/Yellow  (#eab308) — Moderate
    [0.75, 249, 115,  22],   # Orange        (#f97316)
    [1.00, 239,  68,  68],   # Crimson Red   (#ef4444) — High Uncertainty
], dtype=np.float32)


def _pil_to_base64(img: Image.Image, fmt: str = "PNG") -> str:
    """Convert a PIL Image to a base64-encoded string."""
    buf = io.BytesIO()
    img.save(buf, format=fmt)
    return base64.b64encode(buf.getvalue()).decode("utf-8")


def _ndarray_to_base64(arr: np.ndarray) -> str:
    """Convert a numpy array buffer to a base64-encoded string."""
    return base64.b64encode(arr.tobytes()).decode("utf-8")


def colorize_uncertainty(uncertainty_map: np.ndarray) -> Image.Image:
    """
    Apply a green-to-red color gradient to an uncertainty / variance map.

    Green represents high confidence (low uncertainty), while Red represents
    high uncertainty (large variance across augmented passes).

    Args:
        uncertainty_map: 2D numpy array (H, W) of variance / uncertainty values.

    Returns:
        PIL RGB Image visualizing per-pixel uncertainty.
    """
    u = uncertainty_map.astype(np.float32)
    u_min, u_max = float(u.min()), float(u.max())

    if u_max - u_min > 1e-6:
        u_norm = (u - u_min) / (u_max - u_min)
    else:
        u_norm = np.zeros_like(u)

    u_norm = np.clip(u_norm, 0.0, 1.0)

    ts = _UNCERTAINTY_POINTS[:, 0]
    r = np.interp(u_norm, ts, _UNCERTAINTY_POINTS[:, 1])
    g = np.interp(u_norm, ts, _UNCERTAINTY_POINTS[:, 2])
    b = np.interp(u_norm, ts, _UNCERTAINTY_POINTS[:, 3])

    rgb = np.stack([r, g, b], axis=-1).astype(np.uint8)
    return Image.fromarray(rgb, mode="RGB")


def detect_unreliable_regions(
    image: Image.Image,
    depth: np.ndarray,
) -> np.ndarray:
    """
    Heuristic detection of problematic regions for monocular depth estimation.

    Detects:
        1. Sky regions: Very bright, low-texture areas in the upper portion of the image.
        2. Reflective / Specular surfaces: Local saturation & brightness spikes.
        3. Uniform / Textureless regions: Featureless areas with near-zero image gradients.
        4. Occlusion boundaries: High depth gradient / edge discontinuities.

    Args:
        image: Original RGB PIL Image.
        depth: 2D numpy array (H, W) of depth values.

    Returns:
        Boolean numpy array of shape (H, W) where True marks unreliable pixels.
    """
    h, w = depth.shape

    # Match image dimensions to depth map if needed
    if image.size != (w, h):
        image_matched = image.resize((w, h), Image.BILINEAR)
    else:
        image_matched = image

    # ── 1. Image Grayscale & Texture Gradients ────────────────────────
    gray = np.array(image_matched.convert("L"), dtype=np.float32)
    gy, gx = np.gradient(gray)
    img_grad_mag = np.sqrt(gx**2 + gy**2)

    # ── 2. Depth Discontinuities / Edge Gradients ─────────────────────
    d_f32 = depth.astype(np.float32)
    d_min, d_max = float(d_f32.min()), float(d_f32.max())
    if d_max - d_min > 1e-6:
        d_norm = (d_f32 - d_min) / (d_max - d_min)
    else:
        d_norm = np.zeros_like(d_f32)

    dy, dx = np.gradient(d_norm)
    depth_grad_mag = np.sqrt(dx**2 + dy**2)

    # ── 3. Heuristic Masks ───────────────────────────────────────────
    # a. Sky: Top 45% of image, high brightness (>200), low texture (<12.0)
    y_coords = np.arange(h)[:, None]
    sky_mask = (y_coords < int(h * 0.45)) & (gray > 200.0) & (img_grad_mag < 12.0)

    # b. Specular / Pure White Highlights (>248)
    specular_mask = gray > 248.0

    # c. Uniform / Textureless Regions (Flat walls, fog, featureless ground)
    textureless_mask = img_grad_mag < 5.0

    # d. Occlusion boundaries (Top 5% highest depth gradient changes)
    depth_edge_threshold = float(np.percentile(depth_grad_mag, 95))
    boundary_mask = depth_grad_mag > max(0.15, depth_edge_threshold)

    # Combine masks
    unreliable_mask = sky_mask | specular_mask | textureless_mask | boundary_mask
    return unreliable_mask


def compute_uncertainty(
    image: Image.Image,
    depth_estimator: Any,
    num_passes: int = 5,
) -> Dict[str, Any]:
    """
    Compute per-pixel depth uncertainty and confidence using Test-Time Augmentation (TTA).

    Executes multiple augmented inference passes:
        - Pass 0: Original input
        - Pass 1: Horizontal mirror flip (depth prediction is inverted back)
        - Pass 2: Brightness boost (+10%)
        - Pass 3: Brightness dim (-10%)
        - Pass 4: Center crop 95% (zoomed & rescaled)
        - Pass 5+: Additional subtle photometric and scale variations

    Args:
        image: RGB PIL Image.
        depth_estimator: Object with an `.estimate(image)` method or callable `(image) -> np.ndarray`.
        num_passes: Number of augmented inference passes to run (default 5, min 2).

    Returns:
        Dictionary containing:
            - uncertainty_map: (H, W) float32 variance array
            - confidence_map: (H, W) float32 confidence array in [0, 1]
            - mean_confidence: overall average confidence float
            - unreliable_regions: (H, W) bool mask of problematic areas
            - unreliable_percentage: percentage of pixels detected as unreliable
            - uncertainty_map_base64: colorized uncertainty map as base64 PNG
            - confidence_stats: dict with min, max, mean, std
    """
    orig_w, orig_h = image.size
    num_passes = max(2, num_passes)

    # Define augmentation generators
    augmentations = []

    # Pass 0: Base image
    augmentations.append(("identity", lambda img: img, False))

    # Pass 1: Horizontal Flip
    augmentations.append(("hflip", lambda img: img.transpose(Image.FLIP_LEFT_RIGHT), True))

    # Pass 2: Brightness +10%
    augmentations.append(("bright_plus", lambda img: ImageEnhance.Brightness(img).enhance(1.10), False))

    # Pass 3: Brightness -10%
    augmentations.append(("bright_minus", lambda img: ImageEnhance.Brightness(img).enhance(0.90), False))

    # Pass 4: Center Crop 95%
    def _crop_95(img: Image.Image) -> Image.Image:
        w, h = img.size
        cw, ch = int(w * 0.95), int(h * 0.95)
        left, top = (w - cw) // 2, (h - ch) // 2
        cropped = img.crop((left, top, left + cw, top + ch))
        return cropped.resize((w, h), Image.LANCZOS)

    augmentations.append(("crop_95", _crop_95, False))

    # Pass 5: Contrast +10%
    def _contrast_plus(img: Image.Image) -> Image.Image:
        return ImageEnhance.Contrast(img).enhance(1.10)

    augmentations.append(("contrast_plus", _contrast_plus, False))

    # Pass 6: Center Crop 90%
    def _crop_90(img: Image.Image) -> Image.Image:
        w, h = img.size
        cw, ch = int(w * 0.90), int(h * 0.90)
        left, top = (w - cw) // 2, (h - ch) // 2
        cropped = img.crop((left, top, left + cw, top + ch))
        return cropped.resize((w, h), Image.LANCZOS)

    augmentations.append(("crop_90", _crop_90, False))

    # Execute passes
    predicted_depths: List[np.ndarray] = []

    for pass_idx in range(num_passes):
        aug_name, aug_fn, is_flipped = augmentations[pass_idx % len(augmentations)]
        aug_img = aug_fn(image)

        # Run depth estimator
        if hasattr(depth_estimator, "estimate"):
            d = depth_estimator.estimate(aug_img)
        elif callable(depth_estimator):
            d = depth_estimator(aug_img)
        else:
            raise TypeError("depth_estimator must have an 'estimate' method or be callable.")

        d_arr = np.asarray(d, dtype=np.float32)

        # Unflip horizontal mirror if needed
        if is_flipped:
            d_arr = np.fliplr(d_arr)

        # Ensure consistent shape with original image
        if d_arr.shape != (orig_h, orig_w):
            d_pil = Image.fromarray(d_arr)
            d_pil = d_pil.resize((orig_w, orig_h), Image.LANCZOS)
            d_arr = np.array(d_pil, dtype=np.float32)

        # Normalize relative depth to [0, 1] per pass to standardize scales
        d_min, d_max = float(d_arr.min()), float(d_arr.max())
        if d_max - d_min > 1e-6:
            d_norm = (d_arr - d_min) / (d_max - d_min)
        else:
            d_norm = np.zeros_like(d_arr)

        predicted_depths.append(d_norm)

    # ── Per-pixel Variance & Confidence Computation ──────────────────
    depth_stack = np.stack(predicted_depths, axis=0)  # Shape (num_passes, H, W)
    variance_map = np.var(depth_stack, axis=0).astype(np.float32)  # Shape (H, W)
    mean_depth = np.mean(depth_stack, axis=0).astype(np.float32)

    # Normalized variance in [0, 1]
    v_min, v_max = float(variance_map.min()), float(variance_map.max())
    if v_max - v_min > 1e-6:
        norm_var = (variance_map - v_min) / (v_max - v_min)
    else:
        norm_var = np.zeros_like(variance_map)

    # Confidence map: inverse of normalized variance
    confidence_map = np.clip(1.0 - norm_var, 0.0, 1.0).astype(np.float32)
    mean_confidence = float(np.mean(confidence_map))

    # ── Unreliable Regions Detection ─────────────────────────────────
    unreliable_regions = detect_unreliable_regions(image, mean_depth)
    unreliable_percentage = float(np.mean(unreliable_regions) * 100.0)

    # ── Colorized Visualization ──────────────────────────────────────
    colored_uncertainty = colorize_uncertainty(variance_map)
    uncertainty_base64 = _pil_to_base64(colored_uncertainty)

    confidence_stats = {
        "min": round(float(confidence_map.min()), 4),
        "max": round(float(confidence_map.max()), 4),
        "mean": round(float(confidence_map.mean()), 4),
        "std": round(float(confidence_map.std()), 4),
    }

    return {
        "uncertainty_map": variance_map,
        "confidence_map": confidence_map,
        "mean_confidence": round(mean_confidence, 4),
        "unreliable_regions": unreliable_regions,
        "unreliable_percentage": round(unreliable_percentage, 2),
        "uncertainty_map_base64": uncertainty_base64,
        "confidence_stats": confidence_stats,
    }
