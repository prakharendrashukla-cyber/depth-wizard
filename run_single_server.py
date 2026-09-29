#!/usr/bin/env python3
"""
Depth Wizard — Unified Single Server Runner
Runs both Frontend React SPA and Backend FastAPI on a SINGLE Port!

Usage:
    py run_single_server.py [--port 8000] [--host 0.0.0.0]
"""

import os
import sys
import argparse
import subprocess

def main():
    parser = argparse.ArgumentParser(description="Depth Wizard Unified Single-Server Runner")
    parser.add_argument("--port", type=int, default=8000, help="Port to bind server (default: 8000)")
    parser.add_argument("--host", type=str, default="0.0.0.0", help="Host address (default: 0.0.0.0)")
    args = parser.parse_args()

    root_dir = os.path.dirname(os.path.abspath(__file__))
    frontend_dist = os.path.join(root_dir, "frontend", "dist")
    backend_dir = os.path.join(root_dir, "backend")

    # If frontend dist doesn't exist, build it
    if not os.path.isdir(frontend_dist) or not os.path.isfile(os.path.join(frontend_dist, "index.html")):
        print("📦 Frontend build missing. Building production bundle...")
        subprocess.run(["npm", "run", "build"], cwd=os.path.join(root_dir, "frontend"), shell=True, check=True)

    print(f"\n=======================================================")
    print(f"🧙‍♂️ Depth Wizard — Unified Single-Server")
    print(f"=======================================================")
    print(f"🌐 Full Web App (UI + API): http://localhost:{args.port}/")
    print(f"📄 API Documentation:       http://localhost:{args.port}/docs")
    print(f"📡 Backend & Frontend are serving from the same port!")
    print(f"=======================================================\n")

    # Add backend directory to sys.path so app.main can be imported
    if backend_dir not in sys.path:
        sys.path.insert(0, backend_dir)

    import uvicorn
    uvicorn.run("app.main:app", host=args.host, port=args.port, reload=False, app_dir=backend_dir)

if __name__ == "__main__":
    main()
