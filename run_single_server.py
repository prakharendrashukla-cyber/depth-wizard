#!/usr/bin/env python3
"""Serve the built frontend and FastAPI on one port."""
import argparse
from pathlib import Path
import shutil
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request
import webbrowser


def open_when_ready(url):
    """Open only after the server answers, without blocking startup."""
    for _ in range(60):
        try:
            with urllib.request.urlopen(url + "/health", timeout=1) as response:
                if response.status == 200:
                    webbrowser.open(url)
                    return
        except (urllib.error.URLError, OSError):
            time.sleep(0.5)


def main():
    parser = argparse.ArgumentParser(description="Depth Wizard single-server runner")
    parser.add_argument("--port", type=int, default=8000)
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--open-browser", action="store_true")
    args = parser.parse_args()
    root = Path(__file__).resolve().parent
    frontend = root / "frontend"
    backend = root / "backend"
    if not (frontend / "dist" / "index.html").is_file():
        npm = shutil.which("npm.cmd") or shutil.which("npm")
        if npm is None:
            parser.exit(1, "Frontend build is missing. Install Node.js and run setup.bat.\n")
        print("Frontend build missing. Building production bundle...", flush=True)
        try:
            subprocess.run([npm, "run", "build"], cwd=frontend, check=True)
        except subprocess.CalledProcessError:
            parser.exit(1, "Frontend build failed. Run setup.bat and retry.\n")

    url = f"http://localhost:{args.port}"
    print(f"\nDepth Wizard - UI and API: {url}\nAPI documentation: {url}/docs\n", flush=True)
    sys.path.insert(0, str(backend))
    if args.open_browser:
        threading.Thread(target=open_when_ready, args=(url,), daemon=True).start()
    import uvicorn
    uvicorn.run("app.main:app", host=args.host, port=args.port, reload=False, app_dir=str(backend))


if __name__ == "__main__":
    main()
