"""Package source without credentials, user data, environments, or model weights."""
from pathlib import Path
import os
import zipfile

ROOT = Path(__file__).resolve().parents[1]
EXCLUDE_DIRS = {"node_modules", "__pycache__", ".git", "dist", "build", ".vite",
                ".venv", "venv", "env", ".scratch", ".pytest_cache", ".ruff_cache",
                "data", "uploads", "weights", "tools", ".aws", ".codex", ".agents"}
EXCLUDE_EXTS = {".pyc", ".log", ".exe", ".download", ".zip", ".db", ".sqlite",
                ".sqlite3", ".pt", ".pth", ".onnx", ".bin"}


def create_archive(root=ROOT):
    destination = root / "depth-wizard-clean.zip"
    count = 0
    with zipfile.ZipFile(destination, "w", zipfile.ZIP_DEFLATED) as archive:
        for directory, dirs, files in os.walk(root, followlinks=False):
            dirs[:] = [d for d in dirs if d not in EXCLUDE_DIRS
                       and not (Path(directory) / d).is_symlink()]
            for name in files:
                path = Path(directory) / name
                if path.is_symlink() or path.suffix.lower() in EXCLUDE_EXTS:
                    continue
                if name.startswith(".env") and name != ".env.example":
                    continue
                archive.write(path, Path("depth-wizard") / path.relative_to(root))
                count += 1
    return destination, count


if __name__ == "__main__":
    destination, count = create_archive()
    print(f"Created {destination} ({count} files)")
