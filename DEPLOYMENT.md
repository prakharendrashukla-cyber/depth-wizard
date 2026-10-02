# Current private deployment

- Google Cloud project: `project-f78febd0-7836-4470-8e4`
- Cloud Run service: `depth-wizard`, region `asia-south1`
- Service URL: https://depth-wizard-133290700595.asia-south1.run.app
- Supabase organization: `251b645@juetguna.in's Org`
- Existing Supabase project: `depth-wizard` (`jricazzvfyqghbavsaqa`)

The existing `depth-wizard-main` Cloud Build trigger builds the Dockerfile on
pushes to main, pushes the image, and deploys it while preserving the existing
private IAM and Identity-Aware Proxy settings. IAP allows only
`prakharendrashukla@gmail.com`. The builder has Cloud Run Developer on this
service and Service Account User on its existing runtime identity. A deployment
using that builder identity completed successfully.

## Runtime connection

The trigger sets `APP_ENV=production`, `AUTH_PROVIDER=supabase`,
`SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY`, and `ALLOWED_ORIGINS` to the service
origin. `/app-config.js` exposes only the auth provider, public project URL,
and publishable key plus the public Google-login feature flag to the bundled frontend. Keep privileged credentials out
of these settings and out of the browser. The existing Secret Manager session
secret remains attached to the service.

`supabase/setup.sql` was applied as `depth_wizard_private_history` to the
existing Supabase project. It provides owner-scoped profiles and analyses,
RLS policies, and the private `depth-wizard` storage bucket. The Auth site URL
and redirect allowlist point to the Cloud Run URL. Email confirmation is
disabled at the user's request: signup uses only email and password and returns
an immediate session. Email ownership is not verified. Google sign-in uses a
separate OAuth client registered with Supabase; set `SUPABASE_GOOGLE_ENABLED=true`
only after the Google provider is configured. OAuth client secrets belong only
in the Supabase provider settings.

Signed-in single-image analyses use Supabase history and storage. Guest,
batch, and video results are session-only. Container-local SQLite and upload
directories are not persistent cloud storage.

## Remaining live verification

Private browser access and real Depth Anything V2 Small processing are verified.
Finish signup/login, Google sign-in, save/reopen/delete of history, and isolation
between two accounts. Local checks and an empty
Security Advisor are not proof that these hosted flows have completed.

Shadow areas use square metres only when the spacing of the depth raster is
provided. Otherwise the UI reports pixel counts and illustrative coverage.
Depth/DSM accuracy requires real reference data and is not established by
deployment or synthetic tests.
