"""
Depth estimation module — Multi-Model Support.

Supports model selection among:
1. Depth Anything V2 Small / Base / Large (HuggingFace Transformers)
2. MiDaS Small / Large (torch.hub)
3. ZoeDepth (metric depth, HuggingFace)
4. Metric3D (HuggingFace)
5. Procedural fallback (brightness + gradient heuristic — no ML needed)

Includes auto-model recommendation based on input type.
"""

import logging
import os
import threading
from pathlib import Path
from typing import Dict, List, Optional

import numpy as np
from PIL import Image, ImageFilter

logger = logging.getLogger(__name__)

# Configure PyTorch CPU optimizations
try:
    import torch
    # Utilize full physical CPU cores for fast SIMD/AVX inference
    cpu_cores = os.cpu_count() or 4
    torch.set_num_threads(max(1, min(8, cpu_cores)))
    if hasattr(torch.backends, "mkldnn"):
        torch.backends.mkldnn.enabled = True
except ImportError:
    pass

# ── Inferno-like colormap for depth visualization ────────────────────────
_INFERNO_POINTS = np.array([
    [0.00,   0,   0,   4],
    [0.15,  40,  11,  84],
    [0.30, 101,  21, 110],
    [0.45, 159,  42,  99],
    [0.60, 212,  72,  66],
    [0.75, 245, 125,  21],
    [0.90, 250, 193,  39],
    [1.00, 252, 255, 164],
], dtype=np.float32)


# ── Available model registry ─────────────────────────────────────────────
MODEL_REGISTRY = {
    "depth-anything-v2-small": {
        "name": "Depth Anything V2 Small",
        "hf_id": "depth-anything/Depth-Anything-V2-Small-hf",
        "type": "depth-anything",
        "speed": "fast",
        "accuracy": 3,
        "params": "24.8M",
        "best_for": "General-purpose, fast inference. Good for real-time applications.",
    },
    "depth-anything-v2-base": {
        "name": "Depth Anything V2 Base",
        "hf_id": "depth-anything/Depth-Anything-V2-Base-hf",
        "type": "depth-anything",
        "speed": "medium",
        "accuracy": 4,
        "params": "97.5M",
        "best_for": "Balanced speed/accuracy. Good for most use cases.",
    },
    "depth-anything-v2-large": {
        "name": "Depth Anything V2 Large",
        "hf_id": "depth-anything/Depth-Anything-V2-Large-hf",
        "type": "depth-anything",
        "speed": "slow",
        "accuracy": 5,
        "params": "335M",
        "best_for": "Highest accuracy. Best for detailed analysis and publications.",
    },
    "midas-small": {
        "name": "MiDaS v3.1 Small",
        "hf_id": None,
        "type": "midas",
        "variant": "MiDaS_small",
        "speed": "fast",
        "accuracy": 2,
        "params": "21M",
        "best_for": "Lightweight fallback. Works on CPU without large downloads.",
    },
    "midas-large": {
        "name": "MiDaS v3.1 DPT Large",
        "hf_id": None,
        "type": "midas",
        "variant": "DPT_Large",
        "speed": "slow",
        "accuracy": 4,
        "params": "344M",
        "best_for": "High-quality depth. Good indoor/outdoor generalization.",
    },
    "zoedepth": {
        "name": "ZoeDepth (Metric)",
        "hf_id": "Intel/zoedepth-nyu-kitti",
        "type": "zoedepth",
        "speed": "medium",
        "accuracy": 4,
        "params": "105M",
        "best_for": "Metric (absolute) depth. Trained on NYU+KITTI for real-world scale.",
    },
    "metric3d": {
        "name": "Metric3D v2 Small",
        "hf_id": "JUGGHM/Metric3D-v2-Small",
        "type": "unsupported",
        "speed": "medium",
        "accuracy": 4,
        "params": "85M",
        "best_for": "Not implemented by the installed Transformers model stack.",
    },
    "procedural-fallback": {
        "name": "Procedural Fallback",
        "hf_id": None,
        "type": "procedural",
        "speed": "instant",
        "accuracy": 1,
        "params": "0",
        "best_for": "No-dependency demo mode. Uses brightness + gradient heuristics.",
    },
}


def colorize_depth(depth: np.ndarray) -> Image.Image:
    """Apply an inferno-like colormap to a depth map → PIL RGB Image."""
    d = depth.astype(np.float32)
    d_min, d_max = d.min(), d.max()
    if d_max - d_min > 1e-6:
        d = (d - d_min) / (d_max - d_min)
    else:
        d = np.zeros_like(d)

    ts = _INFERNO_POINTS[:, 0]
    r = np.interp(d, ts, _INFERNO_POINTS[:, 1])
    g = np.interp(d, ts, _INFERNO_POINTS[:, 2])
    b = np.interp(d, ts, _INFERNO_POINTS[:, 3])
    rgb = np.stack([r, g, b], axis=-1).astype(np.uint8)
    return Image.fromarray(rgb)


def _model_dependencies_installed(model_type: str) -> bool:
    try:
        import torch  # noqa: F401
        if model_type in ("depth-anything", "zoedepth", "metric3d"):
            import transformers  # noqa: F401
    except ImportError:
        return False
    return True


def _model_weights_cached(model_id: str, info: Dict) -> bool:
    """Return whether model weights are present locally, without contacting a hub."""
    model_type = info["type"]
    if model_type == "procedural":
        return True
    if model_type in ("depth-anything", "zoedepth", "metric3d"):
        try:
            from huggingface_hub import snapshot_download
            snapshot = Path(snapshot_download(info["hf_id"], local_files_only=True))
        except Exception:
            return False
        if not (snapshot / "config.json").is_file():
            return False
        if not any((snapshot / name).is_file() for name in (
            "preprocessor_config.json", "processor_config.json"
        )):
            return False

        if any((snapshot / name).is_file() for name in ("model.safetensors", "pytorch_model.bin")):
            return True
        for index_name in ("model.safetensors.index.json", "pytorch_model.bin.index.json"):
            index_path = snapshot / index_name
            if index_path.is_file():
                try:
                    import json
                    shards = set(json.loads(index_path.read_text(encoding="utf-8"))["weight_map"].values())
                    if shards and all((snapshot / shard).is_file() for shard in shards):
                        return True
                except (OSError, ValueError, KeyError, TypeError):
                    continue
        return False
    if model_type == "midas":
        try:
            import torch
            hub_dir = Path(torch.hub.get_dir())
        except ImportError:
            return False
        repo_dirs = (hub_dir / "intel-isl_MiDaS_master", hub_dir / "intel-isl_MiDaS_main")
        checkpoint = "midas_v21_small_256.pt" if model_id == "midas-small" else "dpt_large_384.pt"
        return any((repo / "hubconf.py").is_file() for repo in repo_dirs) and (
            hub_dir / "checkpoints" / checkpoint
        ).is_file()
    return False


def list_available_models(current_model: Optional[str] = None) -> List[Dict]:
    """List implemented models and report local weight availability separately."""
    results = []
    for model_id, info in MODEL_REGISTRY.items():
        supported = info["type"] in {"depth-anything", "midas", "zoedepth", "procedural"}
        ready = info["type"] == "procedural" or (
            supported and _model_dependencies_installed(info["type"])
        )
        cached = _model_weights_cached(model_id, info) if supported else False
        if model_id == current_model and supported:
            ready = cached = True
        unavailable_reason = None
        if not supported:
            unavailable_reason = "Metric3D is not implemented by the installed Transformers model stack."
        elif not ready:
            unavailable_reason = "Required backend ML dependencies are not installed."
        entry = {
            **info,
            "id": model_id,
            "available": ready,
            "weights_cached": cached,
            "unavailable_reason": unavailable_reason,
        }
        results.append(entry)

    return results


def recommend_model(image: Image.Image) -> str:
    """
    Auto-select the best model based on input image characteristics.
    Uses simple heuristics to classify: indoor / outdoor / aerial / planetary.
    """
    w, h = image.size
    img_np = np.array(image.convert("RGB"), dtype=np.float32)

    # Compute simple features
    mean_brightness = img_np.mean()
    aspect_ratio = w / max(h, 1)

    # Very dark images (lunar/planetary) → use largest available model
    if mean_brightness < 60:
        return "depth-anything-v2-large"

    # Very high resolution → use smaller model for speed
    if w * h > 2_000_000:
        return "depth-anything-v2-small"

    # Square-ish images (indoor?) → ZoeDepth if available
    if 0.8 < aspect_ratio < 1.3:
        return "zoedepth"

    # Default → base model
    return "depth-anything-v2-base"


# ── Depth Estimator ──────────────────────────────────────────────────────

class DepthEstimator:
    """
    Loads a depth model and exposes a single
    `estimate(image) → np.ndarray` interface.

    Supports dynamic model switching via `load_model(model_id)`.
    """

    def __init__(self, model_id: Optional[str] = None):
        self._lock = threading.RLock()
        self.model = None
        self.model_name = "none"
        self.model_id = "none"
        self._transform = None  # MiDaS only
        self._device = None
        self.processor = None  # HF processor

        if model_id:
            self.load_model(model_id)
        else:
            self._load_best_available()

    # ── Model loading ────────────────────────────────────────────────

    def _load_best_available(self):
        """Load the best available model in priority order."""
        priority = [
            "depth-anything-v2-small",
            "midas-small",
            "procedural-fallback",
        ]
        for mid in priority:
            try:
                self.load_model(mid)
                return
            except Exception as exc:
                logger.warning("Could not load %s: %s", mid, exc)
                continue

        logger.warning("No ML depth model available — using procedural fallback.")
        self.model_name = "procedural-fallback"
        self.model_id = "procedural-fallback"

    def load_model(self, model_id: str):
        with self._lock:
            candidate = object.__new__(DepthEstimator)
            candidate.model = candidate.processor = candidate._transform = candidate._device = None
            candidate._load_model(model_id)
            self.__dict__.update(candidate.__dict__)

    def _load_model(self, model_id: str):
        """Load a specific model by its registry ID."""
        if model_id not in MODEL_REGISTRY:
            raise ValueError(f"Unknown model: {model_id}. Available: {list(MODEL_REGISTRY.keys())}")

        info = MODEL_REGISTRY[model_id]
        model_type = info["type"]

        # Clear previous model to free memory
        self._clear_model()

        if model_type == "depth-anything":
            self._load_depth_anything(info["hf_id"], model_id)
        elif model_type == "midas":
            self._load_midas(info.get("variant", "MiDaS_small"), model_id)
        elif model_type == "zoedepth":
            self._load_zoedepth(info["hf_id"], model_id)
        elif model_type == "procedural":
            self.model_name = "procedural-fallback"
            self.model_id = model_id
            logger.info("Using procedural fallback (no ML)")
        elif model_type == "unsupported":
            raise NotImplementedError(f"The {model_id} model architecture is not implemented")
        else:
            raise ValueError(f"Unknown model type: {model_type}")

    def _clear_model(self):
        """Free the current model from memory."""
        if self.model is not None:
            del self.model
            self.model = None
        if self.processor is not None:
            del self.processor
            self.processor = None
        self._transform = None
        try:
            import torch
            if torch.cuda.is_available():
                torch.cuda.empty_cache()
        except ImportError:
            pass

    def _load_depth_anything(self, hf_id: str, model_id: str):
        import torch
        from transformers import AutoImageProcessor, AutoModelForDepthEstimation

        device = "cuda" if torch.cuda.is_available() else "cpu"

        try:
            self.processor = AutoImageProcessor.from_pretrained(hf_id, local_files_only=True)
            self.model = AutoModelForDepthEstimation.from_pretrained(hf_id, local_files_only=True).to(device)
        except Exception:
            # Fetch only the model that the caller explicitly selected.
            self.processor = AutoImageProcessor.from_pretrained(hf_id)
            self.model = AutoModelForDepthEstimation.from_pretrained(hf_id).to(device)

        self.model.eval()
        self.model_name = MODEL_REGISTRY[model_id]["name"]
        self.model_id = model_id
        self._device = device
        logger.info("Loaded %s on %s", self.model_name, device)

    def _load_midas(self, variant: str, model_id: str):
        import torch

        device = "cuda" if torch.cuda.is_available() else "cpu"
        model = torch.hub.load("intel-isl/MiDaS", variant, trust_repo=True)
        model.eval().to(device)

        transforms = torch.hub.load("intel-isl/MiDaS", "transforms", trust_repo=True)
        if variant == "DPT_Large":
            self._transform = transforms.dpt_transform
        else:
            self._transform = transforms.small_transform

        self.model = model
        self.model_name = MODEL_REGISTRY[model_id]["name"]
        self.model_id = model_id
        self._device = device
        logger.info("Loaded %s on %s", self.model_name, device)

    def _load_zoedepth(self, hf_id: str, model_id: str):
        """Load ZoeDepth metric depth model from HuggingFace."""
        try:
            import torch
            from transformers import AutoImageProcessor, AutoModelForDepthEstimation

            device = "cuda" if torch.cuda.is_available() else "cpu"

            try:
                self.processor = AutoImageProcessor.from_pretrained(hf_id, local_files_only=True)
                self.model = AutoModelForDepthEstimation.from_pretrained(hf_id, local_files_only=True).to(device)
            except Exception:
                self.processor = AutoImageProcessor.from_pretrained(hf_id)
                self.model = AutoModelForDepthEstimation.from_pretrained(hf_id).to(device)

            self.model.eval()
            self.model_name = MODEL_REGISTRY[model_id]["name"]
            self.model_id = model_id
            self._device = device
            logger.info("Loaded %s on %s", self.model_name, device)
        except Exception as exc:
            raise RuntimeError(f"Failed to load ZoeDepth: {exc}") from exc

    # ── Inference ────────────────────────────────────────────────────

    def estimate(self, image: Image.Image) -> np.ndarray:
        with self._lock:
            return self._estimate(image)

    def _estimate(self, image: Image.Image) -> np.ndarray:
        """
        Run depth estimation on a PIL Image.
        Returns a float32 array of shape (H, W) with relative depth values
        (higher value = closer to camera).
        """
        info = MODEL_REGISTRY.get(self.model_id)
        if info is None:
            raise RuntimeError(f"Estimator has unknown model id: {self.model_id}")
        model_type = info["type"]

        if model_type == "depth-anything":
            return self._run_depth_anything(image)
        elif model_type == "midas":
            return self._run_midas(image)
        elif model_type == "zoedepth":
            return self._run_hf_depth(image)
        elif model_type == "procedural":
            return self._run_procedural(image)
        raise RuntimeError(f"Model type is not implemented: {model_type}")

    def _run_depth_anything(self, image: Image.Image) -> np.ndarray:
        import torch
        w, h = image.size
        inputs = self.processor(images=image, return_tensors="pt").to(self._device)
        with torch.inference_mode():
            outputs = self.model(**inputs)
            predicted_depth = outputs.predicted_depth

            prediction = torch.nn.functional.interpolate(
                predicted_depth.unsqueeze(1),
                size=(h, w),
                mode="bilinear",
                align_corners=False,
            ).squeeze()

        return prediction.detach().cpu().numpy().astype(np.float32)

    def _run_midas(self, image: Image.Image) -> np.ndarray:
        import torch

        img_np = np.array(image)
        input_batch = self._transform(img_np).to(self._device)

        with torch.inference_mode():
            prediction = self.model(input_batch)
            prediction = torch.nn.functional.interpolate(
                prediction.unsqueeze(1),
                size=img_np.shape[:2],
                mode="bilinear",
                align_corners=False,
            ).squeeze()

        return prediction.detach().cpu().numpy().astype(np.float32)

    def _run_hf_depth(self, image: Image.Image) -> np.ndarray:
        """Generic HuggingFace depth model runner (ZoeDepth, Metric3D)."""
        import torch
        w, h = image.size
        inputs = self.processor(images=image, return_tensors="pt").to(self._device)
        with torch.inference_mode():
            outputs = self.model(**inputs)
            predicted_depth = outputs.predicted_depth

            if predicted_depth.dim() == 2:
                prediction = predicted_depth
            elif predicted_depth.dim() == 3:
                prediction = predicted_depth.squeeze(0)
            else:
                prediction = torch.nn.functional.interpolate(
                    predicted_depth.unsqueeze(1) if predicted_depth.dim() == 3 else predicted_depth,
                    size=(h, w),
                    mode="bilinear",
                    align_corners=False,
                ).squeeze()

            if prediction.shape[0] != h or prediction.shape[1] != w:
                prediction = torch.nn.functional.interpolate(
                    prediction.unsqueeze(0).unsqueeze(0),
                    size=(h, w),
                    mode="bilinear",
                    align_corners=False,
                ).squeeze()

        return prediction.detach().cpu().numpy().astype(np.float32)

    @staticmethod
    def _run_procedural(image: Image.Image) -> np.ndarray:
        """
        Heuristic depth from image brightness + a vertical gradient.
        Not accurate, but creates a plausible 3D effect for demo purposes.
        """
        w, h = image.size

        # Brightness channel (rough proxy: brighter ≈ farther for outdoor)
        gray = np.array(image.convert("L"), dtype=np.float32)
        # Smooth to simulate depth continuity
        gray_pil = Image.fromarray(gray.astype(np.uint8))
        gray_pil = gray_pil.filter(ImageFilter.GaussianBlur(radius=15))
        brightness = np.array(gray_pil, dtype=np.float32)

        # Vertical gradient (bottom = close, top = far)
        vert = np.linspace(0, 1, h).reshape(-1, 1)
        vert = np.broadcast_to(vert, (h, w)).astype(np.float32)

        # Combine: ground-plane assumption + inverted brightness
        depth = (1.0 - vert) * 0.7 + (1.0 - brightness / 255.0) * 0.3

        # Normalize to 0..1
        d_min, d_max = depth.min(), depth.max()
        if d_max - d_min > 1e-6:
            depth = (depth - d_min) / (d_max - d_min)

        return depth * 255.0  # Scale to match ML model output range
