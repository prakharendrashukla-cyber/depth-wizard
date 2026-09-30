# Depth Wizard

Depth Wizard is a hackathon prototype for single-image depth estimation, height analysis, and browser-based 3D point-cloud exploration. It uses FastAPI, React/Vite, Three.js, and SQLite.

By default, local mode requires an account and saves each successful single-image analysis to SQLite history. Local authentication uses Argon2 password hashes and a seven-day JWT in an HttpOnly, SameSite=Lax cookie. For optional Supabase login, guest mode and private cloud history, follow [the Supabase guide](docs/SUPABASE.md).

## Windows setup

Use **Python 3.12** and **Node.js 22 LTS**. The pinned Python dependencies were selected for Python 3.12. A GPU is optional. Installation and the first neural-model load require internet access.

1. Run `setup.bat`. It creates a project-local `.venv`, installs pinned Python dependencies and the frontend lockfile, builds the frontend, and copies `.env.example` to `.env` if needed. It stops if any step fails.
2. Run `start.bat`. One server serves the UI and API at **http://localhost:8000** and opens the browser after the server responds.
3. Select **Create an account**, enter a name, email, and password of at least eight characters. Registration signs you in. No email service is required.
4. Upload an image. Open **My Analyses** to reopen or delete saved results, including after a refresh. Use **Logout** in the header to end the browser session.
5. Keep the launcher window open; press Ctrl+C to stop.

`setup.bat --no-pause` supports unattended setup. Rerun setup after pulling changes to update dependencies and rebuild the UI.

For a lightweight demonstration without downloading weights, set `DEPTH_MODEL=procedural-fallback` in `.env`. This mode produces illustrative heuristic depth, not measured elevations.

## Manual and development commands

From the repository root in PowerShell:

```powershell
py -3.12 -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r backend/requirements.txt
Copy-Item .env.example .env  # Only if .env does not already exist
cd frontend
npm ci
npm run build
cd ..
.\.venv\Scripts\python.exe run_single_server.py --host 127.0.0.1 --port 8000
```

For frontend hot reload, run these in separate terminals:

```powershell
.\.venv\Scripts\python.exe -m uvicorn app.main:app --app-dir backend --host 127.0.0.1 --port 8000
```

```powershell
cd frontend
npm run dev
```

Browse to http://localhost:5173 in development. Vite proxies `/api` to the backend. The production service worker is not registered in development. The unified server also accepts `/api/*`; API responses are excluded from service-worker caching.

`run.py` remains an alias for the single-server runner. If the production bundle is missing, the runner tries `npm run build`; install dependencies first.

## Configuration

The backend loads `.env` from the repository root, regardless of the working directory. Environment variables override the file.

| Variable | Default / behavior |
| --- | --- |
| `APP_ENV` | `development`; `production` requires a configured secret |
| `SECRET_KEY` | Required in production, at least 32 characters; development stores a generated key in `backend/data/.development_secret` |
| `DATABASE_URL` | SQLite at the absolute path `backend/data/depthwizard.db` |
| `UPLOAD_DIR` | `backend/data/uploads`; image and result files grouped by user ID |
| `ALLOWED_ORIGINS` | `http://localhost:5173,http://localhost:8000`; comma-separated explicit origins |
| `MAX_IMAGE_MB` | `20` |
| `MAX_VIDEO_MB` | `100` |
| `MAX_BATCH_FILES` | `20` |
| `MAX_BATCH_MB` | `100` combined batch upload |
| `BATCH_TTL_SECONDS` | `3600`; completed in-memory batch artifacts expire |
| `DEPTH_MODEL` | Automatic model selection; use `procedural-fallback` for a no-weight demo |
| `ADMIN_EMAIL`, `ADMIN_PASSWORD` | Optional initial administrator; both must be supplied |

Generate a production secret with:

```powershell
.\.venv\Scripts\python.exe -c "import secrets; print(secrets.token_urlsafe(48))"
```

An initial administrator is created only if its email does not already exist. Startup does not change an existing user's role or password. This prototype has no separate admin dashboard.

SQLite tables are created on startup using SQLAlchemy 2.0. A future PostgreSQL deployment can use a SQLAlchemy PostgreSQL URL after installing its driver and migrating any existing data; that deployment is not tested here. Back up the database and upload directory together while the server is stopped.

Use HTTPS on any hostname other than localhost: session cookies are Secure for remote hosts. Login and registration share a limit of ten attempts per minute per client IP. The in-memory limiter and batch worker are intended for a single-process prototype.

## Sharing a demo

Start the app with `start.bat`, then run `share_online.bat`. It downloads the Windows x64 cloudflared executable from the official Cloudflare GitHub release into the ignored `tools/` directory when missing, then tunnels port 8000. Use the displayed HTTPS address; visitors must register or log in. Closing the tunnel stops public access.

`create_clean_zip.bat` creates a source archive in the repository root, excluding environments, credentials, uploads, database files, downloaded tools, and model weights.

## Tests

From the repository root:

```powershell
.\.venv\Scripts\python.exe -m pytest -q
.\.venv\Scripts\python.exe -m ruff check backend/app backend/tests run.py run_single_server.py scripts --select F
cd frontend
npm test
npm run build
```

The default tests use a temporary database and procedural depth. They cover registration/login/logout, ownership, upload and path safeguards, failed model switches, persistence, point-cloud payloads, and deterministic numerical examples. They do not prove real-world DSM accuracy.

An optional test exercises the actual Depth Anything V2 Small model:

```powershell
$env:RUN_NEURAL_TESTS = "1"
.\.venv\Scripts\python.exe -m pytest -q -m neural
Remove-Item Env:RUN_NEURAL_TESTS
```

This may download weights and take longer. The default test run skips it. The production build retains the existing size warning for the lazy-loaded Three.js viewer.

## API

Interactive API documentation: http://localhost:8000/docs. Routes work with or without the `/api` prefix.

| Routes | Purpose |
| --- | --- |
| `POST /auth/register`, `POST /auth/login`, `POST /auth/logout`, `GET /auth/me` | Cookie session management |
| `GET /health`, `GET /models`, `GET /samples`, `GET /benchmarks` | Public health and demo metadata |
| `POST /estimate`, `POST /estimate/video` | Authenticated depth processing |
| `GET /analyses?page=1&page_size=20` | Current user's paginated history |
| `GET /analyses/{id}`, `DELETE /analyses/{id}` | Reopen or delete an owned result; other users get 404 |
| `POST /calibrate`, `POST /contour`, `POST /volume`, `POST /volume/shadow` | Authenticated analysis |
| `POST /uncertainty`, `POST /validate` | Authenticated diagnostics |
| `POST /export/ply`, `POST /export/report`, `POST /export/pdf` | Authenticated exports |
| `POST /batch`, `GET /batch/{id}/status`, `GET /batch/{id}/summary`, `GET /batch/{id}/download` | Owner-only batch processing and results |

Batch job metadata survives restart, but batch ZIP artifacts live in memory. Interrupted jobs are marked accordingly on startup; expired or restarted downloads return 410. Single-image history files persist until deletion.

## Repository

- `backend/app/`: API, authentication, database, and depth/analysis modules.
- `backend/tests/`: pytest tests, migrated from the original ad-hoc scripts.
- `backend/data/`: ignored private database, secret, and saved analyses.
- `frontend/src/`: authenticated application, shared API wrapper, history, and lazy-loaded analysis views.
- `docs/`: original presentation sources and HTML; existing PowerPoint files are retained locally here and ignored as generated binaries.
- `scripts/`: source-archive helper.
- `tools/`: ignored downloaded cloudflared executable.

## Prototype limitations

The viewer displays a point cloud with orbit controls and an automated flythrough. Metric elevation accuracy requires reference data and validation. GeoTIFF metadata alone does not determine absolute vertical scale; this work does not complete a validated DSM GeoTIFF export pipeline or textured first-person terrain navigation.

The existing validation dashboard and presentation assets contain illustrative or synthetic benchmark claims. They are retained as prototype materials, not evidence of measured accuracy. The batch upload UI now reports actual processing errors rather than fabricating fallback results.

Neural-model compatibility, GPU performance, and real-world accuracy must be evaluated separately with suitable reference imagery.
## Optional Supabase cloud history

See [the complete Supabase setup and demo guide](docs/SUPABASE.md) for optional login,
guest mode, private saved analyses, rerunnable SQL, free-plan limits, backups and tests.
Configuration templates are `frontend/.env.supabase.example` and `.env.example`;
the SQL Editor script is `supabase/setup.sql`. Cloud credentials are not required
for guest-only development. Existing local Auth/SQLite mode remains the default.
