import sys
import os
import traceback

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

try:
    print("Testing torch...")
    import torch
    print(f"Torch version: {torch.__version__}, CUDA available: {torch.cuda.is_available()}")
except Exception as e:
    print(f"Torch failed: {e}")
    traceback.print_exc()

try:
    print("\nTesting transformers...")
    from transformers import pipeline
    print("Transformers pipeline imported successfully.")
except Exception as e:
    print(f"Transformers failed: {e}")
    traceback.print_exc()

try:
    print("\nTesting DepthEstimator initialization...")
    from app.depth import DepthEstimator
    est = DepthEstimator()
    print(f"Estimator loaded successfully! Model name: {est.model_name}")
except Exception as e:
    print(f"DepthEstimator failed: {e}")
    traceback.print_exc()
