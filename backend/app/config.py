import os
from pathlib import Path
from dotenv import load_dotenv
BACKEND_DIR = Path(__file__).resolve().parent.parent
load_dotenv(BACKEND_DIR.parent / ".env")
ALLOWED_ORIGINS = [s.strip() for s in os.getenv("ALLOWED_ORIGINS", "http://localhost:5173,http://localhost:8000").split(",") if s.strip() and s.strip() != "*"]
IMAGE_LIMIT = int(os.getenv("MAX_IMAGE_MB", "20")) * 1024 * 1024
VIDEO_LIMIT = int(os.getenv("MAX_VIDEO_MB", "100")) * 1024 * 1024
BATCH_LIMIT = int(os.getenv("MAX_BATCH_MB", "100")) * 1024 * 1024
MAX_BATCH_FILES = int(os.getenv("MAX_BATCH_FILES", "20"))
BATCH_TTL = int(os.getenv("BATCH_TTL_SECONDS", "3600"))
MAX_IMAGE_PIXELS = int(os.getenv("MAX_IMAGE_PIXELS", "25000000"))
if not 1_000_000 <= MAX_IMAGE_PIXELS <= 100_000_000:
    raise RuntimeError("MAX_IMAGE_PIXELS must be between 1 million and 100 million")
