# Verification performed on 2026-09-30

- Backend: `pytest backend/tests -q` — **47 passed, 1 skipped**. The skipped test requires an explicit neural-test flag. Cloud tests use real locally generated RSA signatures, expired/wrong claims, invalid signatures, legacy Auth-server verification stubs, guest rate limiting, denied origins and no local persistence for guest inference.
- Frontend: `npm test` — **7 passed**. Includes binary PLY encoding, oversize rejection before pruning, retaining rows after failed Storage deletion, printable-HTML escaping, and PostgreSQL RLS/schema checks using PGlite.
- SQL: setup executed twice in embedded PostgreSQL. Two users were tested for row/file metadata isolation, immutable owner IDs, field validation, the 20-analysis cap and file-before-row deletion. Hosted Supabase Auth and Storage APIs were not involved in these tests.
- Production: `VITE_AUTH_PROVIDER=supabase npm run build` — passed. The existing Three.js viewer chunk still exceeds Vite's 500 kB warning threshold.
- Python static checks: Ruff undefined-name/import checks passed.
- Dependency installation after updating jsPDF to 4.2.1 reported **0 known npm vulnerabilities**. This is not a comprehensive application security audit.
- Chrome: optional login, reset form, guest entry and guest state after refresh checked. A bundled crater image was processed by the real **Depth Anything V2 Small** model; the resulting depth map, 3D viewer, metrics and export controls appeared. The precomputed fallback and cinematic flythrough were also checked.
- The bundled offline result was generated from the real model using `tools/generate_offline_demo.py`; the UI identifies it as precomputed, and its terrain image is illustrative.

Pending after project configuration: hosted signup/login/logout/refresh, email delivery and reset, Google, real Storage uploads/signed downloads/deletion, live two-account test (`frontend/scripts/test-supabase-live.mjs`), dashboard advisors, and backup/restore rehearsal. No Supabase project, paid resource, judge account, remote schema or GitHub schedule has been created by this work.

For this visible development run, Vite is at `http://127.0.0.1:5173` and its API proxy points to the new cloud-mode backend on port **8001**. The pre-existing local server on port **8000** was left running. Both new processes use development settings; see the setup guide before exposing a public tunnel.
