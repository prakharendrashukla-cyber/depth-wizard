# Depth Wizard deployment and public-readiness

## Existing service

Public-readiness work stays in the existing Depth Wizard repository, Cloud Run
service, and Supabase project. Do not create a replacement service or project.

- Google Cloud project: `project-f78febd0-7836-4470-8e4`
- Cloud Run service: `depth-wizard`, region `asia-south1`
- Existing service URL: https://depth-wizard-133290700595.asia-south1.run.app
- Existing Supabase project: `depth-wizard` (`jricazzvfyqghbavsaqa`)

The currently deployed revision still requires Cloud Run IAM and IAP. This
branch does not change IAP, invoker IAM, traffic, or the running revision. The
user has authorized public access with `GO PUBLIC`; keep the existing access
gate in place until the hardened revision and its Supabase migration are
deployed. Before changing access, record the current revision and prepare a
rollback to the last known-good revision.

The existing `depth-wizard-main` Cloud Build trigger is configured in Google
Cloud, outside this repository. Audit its build substitutions, environment
variables, runtime service account, IAM bindings, and deployment flags in the
Cloud Console before relying on a future push to `main`. This repository cannot
prove those external settings. In particular, bind
`SUPABASE_SERVICE_ROLE_KEY` from Secret Manager to the existing Cloud Run
service; never place it in source, browser configuration, or a `VITE_` variable.

During the read-only Chrome review, the `depth-wizard` service showed
`PUBLIC_DEMO_ONLY=true` and no `SUPABASE_SERVICE_ROLE_KEY` Secret Manager
binding; its current secret binding is only the local session-signing secret.
The browser tab already open to a full Depth Wizard UI uses a hostname with a
`gateway` prefix, while the service detail page reports the `depth-wizard`
hostname. Confirm whether that is an alias or a separate service before
deploying or changing access. Do not use the gateway URL as proof that this
named service is publicly reachable.

The deployed service currently has a one-instance maximum, concurrency one,
min instances zero, and a 300-second request timeout. Recheck these values and
the runtime service account before enabling public analysis. Keep inference
concurrency at one and keep Cloud Run concurrency and max instances low until
cost and latency have been observed.

## Existing Supabase project

`supabase/setup.sql` created the current owner-scoped `profiles` and `analyses`
tables and private `depth-wizard` Storage bucket. It is an applied migration;
do not edit or rerun it as a substitute for the new additive migration.
`supabase/migrations/20261003164056_public_analysis_safety.sql` adds private
quota and retention tables, atomic quota RPCs, and Storage accounting triggers.
It is not applied to the live project by this branch. Validate it against the
existing schema and run the private integration checks before applying it to
the existing project through the approved migration workflow.

The existing Supabase Auth CAPTCHA setting was observed off during this review.
The user requires both CAPTCHA and email confirmation to remain off. The current
project settings show CAPTCHA disabled, email confirmation disabled, and new
signups enabled. Do not configure a CAPTCHA provider or require CAPTCHA tokens.

For the public release, use the existing Cloud Run service URL as the Auth Site
URL and redirect origin:
`https://depth-wizard-133290700595.asia-south1.run.app`. The current Supabase
project already has this Site URL and a matching `/**` redirect allowlist entry.

## Public Cloud Run runtime settings

Apply these values to the existing `depth-wizard` service after the hardened
revision is deployed. Keep the service-role key in a Secret Manager binding; do
not paste its value into an environment-variable field or source file.

```text
PUBLIC_DEMO_ONLY=false
ENABLE_BATCH_ANALYSIS=false
ENABLE_VIDEO_ANALYSIS=false
MAX_USER_DAILY_ANALYSES=5
MAX_IP_ANALYSES_PER_MINUTE=5
MAX_GLOBAL_DAILY_ANALYSES=50
MAX_USER_STORAGE_MB=20
UPLOAD_RETENTION_DAYS=30
INFERENCE_CONCURRENCY=1
TRUSTED_PROXY_HOPS=1
ALLOWED_ORIGINS=https://depth-wizard-133290700595.asia-south1.run.app
Cloud Run request concurrency=4
Cloud Run max instances=2
```

The current Secret Manager inventory contains `depth-wizard-session-secret`
only. Create `SUPABASE_SERVICE_ROLE_KEY` from the existing Supabase project's
server-side service-role key, then bind it to the existing Cloud Run service.
Never print or log that secret. If the project configuration changes the
Cloud Run forwarding chain, re-check `TRUSTED_PROXY_HOPS` before launch.

## Public-ready application behavior

- Guests can open the existing precomputed browser demo. Cloud analysis
  endpoints require a verified Supabase JWT; missing, anonymous, expired, and
  invalid tokens are rejected.
- Image inference and raster compute routes reserve an atomic per-user daily,
  per-IP per-minute, and global daily quota in Supabase before processing. If
  the service-role key or database RPC is unavailable, compute fails closed.
- The requested public limits are 5 runs per user per UTC day, 5 runs per
  trusted IP per minute, 50 runs globally per UTC day, 20 MiB of saved files
  per user, and 30-day saved-analysis retention. Set them on the existing
  Cloud Run service as listed above.
- Uploads are limited by byte size and decoded pixel count. Model inference is
  admitted through a single-process semaphore. Batch and video processing are
  off by default; batch remains off in Supabase mode because its existing job
  status store is container-local SQLite.
- History remains in the existing private Supabase bucket with owner-scoped RLS.
  Saved source images use the server's resized image result, so uploaded EXIF
  and GPS metadata are not copied into retained files. Users can delete one
  analysis or delete their account and associated files.
- Retention cleanup runs opportunistically from the existing Cloud Run process
  and uses a database claim to run at most once per day across instances. Since
  the service scales to zero, verify the first-request cleanup behavior and
  monitor it; if strict wall-clock deletion is required, configure an approved
  scheduled invocation of the existing service before claiming a hard deletion
  deadline.
- Production OpenAPI pages are disabled. Health responses avoid exposing model
  identifiers or runtime details. CORS stays on the configured origin allowlist.
- Relative monocular depth is not a calibrated DSM. Physical height and area
  claims require reference measurements and horizontal calibration.

## Required private checks before release

1. Review the additive SQL migration against the live schema without applying
   it. Exercise migration, storage insert/update/delete, concurrent quota
   reservation, over-quota storage, account deletion, and retention in an
   isolated database that includes Supabase Auth and Storage schemas.
2. Run backend security tests and frontend tests/build. Cover missing, expired,
   forged, and anonymous tokens; unauthenticated large bodies; pixel bombs;
   storage owner isolation; quota race behavior; and account deletion.
3. Verify that no service-role key or JWT signing key is in
   browser assets, source control, logs, or Cloud Build output.
4. Audit the external Cloud Build trigger and runtime service account before
   considering a deployment. Keep production access private while testing.
5. The user has authorized public access. Keep IAP and IAM required until the
   hardened revision is deployed and the migration, secret binding, limits,
   health response, and protected routes are verified.

## Rollback behavior

`PUBLIC_DEMO_ONLY=true` remains the existing application kill switch: it serves
the precomputed read-only demo and disables cloud analysis and signed-in account
controls, including account deletion, until full mode is restored. To roll back a public-access change,
restore the previous IAP and IAM settings first, then route traffic to the last
known good revision. Print and review the exact rollback command before any
future public-access change.
