# Completion checks - 2026-09-30

Continued from phase 4 commit `63a1252` and completed phase 5.

- Installed all pinned Python requirements in a new Python 3.12 virtual environment; `pip check` passed.
- Ran `setup.bat --no-pause` end to end in the working project: Python install, `npm ci`, and production build passed.
- Ran the normal `python -m pytest -q` command: **35 passed, 1 skipped**, with no warnings. The isolated environment produced the same result.
- Ran Ruff's `F` checks on the backend, tests, launchers, and archive helper: passed.
- Ran frontend API tests: **2 passed**.
- Production build passed. The existing lazy-loaded Three.js viewer still produces Vite's chunk-size warning (about 858 kB minified).
- Started `run_single_server.py` using Windows cp1252 console encoding and a separate test database. Verified public health, static frontend, unknown API 404, registration, cookie login, image analysis, history/reopen/delete, and logout through live HTTP requests.
- In the in-app browser, verified logged-out login screen, login, bundled sample analysis, refresh, history reopening, logout, and logged-out refresh. No browser console errors were recorded.
- Repaired an existing mixed NumPy installation in the working `.venv`; Torch-to-NumPy conversion now works. Old package files were preserved under ignored `.scratch/numpy-repair-backup/`.

Not verified: a separate fresh Git clone on another machine; real neural-model inference (the opt-in test is skipped); GPU behavior; Cloudflare download/tunnel; real-world DSM accuracy. Browser and API processing checks used the explicitly selected procedural demo model.

The original presentations remain local in `docs/`; scientific claims in those assets were not revised or validated by this cleanup.
