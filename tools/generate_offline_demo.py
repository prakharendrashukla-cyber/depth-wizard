"""Generate the labelled fallback from the real local model and a bundled sample."""
import json
from pathlib import Path
import httpx

root = Path(__file__).resolve().parents[1]
sample = root / "backend/sample_images/isro_crater_terrain.png"
with httpx.Client(timeout=120) as client:
    response = client.post("http://127.0.0.1:8001/estimate", files={"image": (sample.name, sample.read_bytes(), "image/png")})
    response.raise_for_status()
result = response.json()
result.pop("analysis_id", None)
result["demo_notice"] = "Precomputed Depth Anything V2 output on a bundled illustrative crater image. Not ground-truth height."
destination = root / "frontend/public/demo/crater-analysis.json"
destination.parent.mkdir(parents=True, exist_ok=True)
destination.write_text(json.dumps(result, separators=(",", ":")), encoding="utf-8")
print(f"Saved {destination.stat().st_size} bytes; model={result['model_id']}")
