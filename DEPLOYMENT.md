# Current private deployment

- Google Cloud project: `project-f78febd0-7836-4470-8e4`
- Cloud Run service: `depth-wizard`, region `asia-south1`
- Service URL: https://depth-wizard-133290700595.asia-south1.run.app
- Supabase organization: `251b645@juetguna.in's Org`
- Existing Supabase project: `depth-wizard` (`jricazzvfyqghbavsaqa`)

The existing `depth-wizard-main` Cloud Build trigger builds the Dockerfile on
pushes to main, pushes the image, and deploys it with
`--no-allow-unauthenticated`. Keep this restriction until public access is
explicitly approved. Ordinary browser navigation receives 403 with Cloud Run
IAM authentication; private browser access requires an authenticated proxy or
Identity-Aware Proxy configured for approved users.

## Runtime connection

The trigger sets `APP_ENV=production`, `AUTH_PROVIDER=supabase`,
`SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY`, and `ALLOWED_ORIGINS` to the service
origin. `/app-config.js` exposes only the auth provider, public project URL,
and publishable key to the bundled frontend. Keep privileged credentials out
of these settings and out of the browser. The existing Secret Manager session
secret remains attached to the service.

`supabase/setup.sql` was applied as `depth_wizard_private_history` to the
existing Supabase project. It provides owner-scoped profiles and analyses,
RLS policies, and the private `depth-wizard` storage bucket. The Auth site URL
and redirect allowlist point to the Cloud Run URL. Email confirmation remains
enabled.

Signed-in single-image analyses use Supabase history and storage. Guest,
batch, and video results are session-only. Container-local SQLite and upload
directories are not persistent cloud storage.

## Remaining live verification

After the new image is healthy and private browser access is available, verify
email confirmation/login, single-image processing, save/reopen/delete of
history, and isolation between two accounts. Local checks and an empty
Security Advisor are not proof that these hosted flows have completed.

Shadow areas use square metres only when the spacing of the depth raster is
provided. Otherwise the UI reports pixel counts and illustrative coverage.
Depth/DSM accuracy requires real reference data and is not established by
deployment or synthetic tests.
