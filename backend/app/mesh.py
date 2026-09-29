"""
Depth map → 3D point cloud conversion.

Uses a simple pinhole camera model to back-project pixels into 3D space.
Pure numpy — no heavy dependencies.
"""

import numpy as np
from PIL import Image


def depth_to_point_cloud(
    image: Image.Image,
    depth: np.ndarray,
    step: int = 2,
    max_points: int = 55_000,
) -> tuple[np.ndarray, np.ndarray]:
    """
    Convert an RGB image + depth map into a coloured 3D point cloud.

    Args:
        image:      Original RGB PIL Image (must match depth dimensions).
        depth:      (H, W) float32 depth map (higher = closer).
        step:       Pixel sampling stride (2 = every other pixel).
        max_points: Safety cap on total points (optimized for fast 60fps rendering).

    Returns:
        positions:  (N, 3) float32  — x, y, z for each point
        colors:     (N, 3) float32  — r, g, b in [0, 1]
    """
    h, w = depth.shape
    img_array = np.array(image.resize((w, h)))  # Ensure sizes match

    # ── Auto-adjust step to stay under max_points ────────────────────
    estimated_points = (h // step) * (w // step)
    while estimated_points > max_points and step < 8:
        step += 1
        estimated_points = (h // step) * (w // step)

    # ── Pixel coordinate grids (downsampled) ─────────────────────────
    u_coords = np.arange(0, w, step)
    v_coords = np.arange(0, h, step)
    u, v = np.meshgrid(u_coords, v_coords)  # both shape (rows, cols)

    # ── Sample depth + colour ────────────────────────────────────────
    d = depth[v, u].astype(np.float32)

    # Normalise depth to [0, 1]
    d_min, d_max = d.min(), d.max()
    if d_max - d_min > 1e-6:
        d_norm = (d - d_min) / (d_max - d_min)
    else:
        d_norm = np.zeros_like(d)

    # Convert depth to metric-like Z values.
    # Depth models output "disparity" (higher = closer),
    # so invert to get distance.  Add ε to avoid divide-by-zero.
    z = 1.0 / (d_norm + 0.05)
    # Re-normalise z to a nice viewing range [0.5, 10]
    z_min, z_max = z.min(), z.max()
    if z_max - z_min > 1e-6:
        z = 0.5 + (z - z_min) / (z_max - z_min) * 9.5
    else:
        z = np.full_like(z, 5.0)

    # ── Pinhole back-projection ──────────────────────────────────────
    # Estimate focal length from image width (≈ normal lens FOV ~60°)
    fx = w * 0.8
    fy = fx
    cx, cy = w / 2.0, h / 2.0

    x = (u.astype(np.float32) - cx) * z / fx
    y = (v.astype(np.float32) - cy) * z / fy

    # ── Sample colours ───────────────────────────────────────────────
    colors = img_array[v, u].astype(np.float32) / 255.0

    # ── Flatten & assemble ───────────────────────────────────────────
    # Three.js convention: Y-up, looking down -Z
    positions = np.stack(
        [x, -y, -z],  # flip Y (screen→world) and Z (into screen)
        axis=-1,
    ).reshape(-1, 3).astype(np.float32)

    colors = colors.reshape(-1, 3).astype(np.float32)

    # Remove any NaN / Inf points
    valid = np.isfinite(positions).all(axis=1)
    positions = positions[valid]
    colors = colors[valid]

    return positions, colors
