# Cloud Run deployment

## Gateway audit - 3 October 2026

The full pre-demo backend is serving 100% of traffic on
`depth-wizard-00006-dqj`. IAM and IAP are both enabled. Its canonical URL is
`https://depth-wizard-v2uqo4vytq-el.a.run.app`.

The separate `depth-wizard-gateway` service is public at
`https://depth-wizard-gateway-133290700595.asia-south1.run.app`.
Its runtime `PRIVATE_BACKEND_URL` uses the published backend URL
`https://depth-wizard-133290700595.asia-south1.run.app`. The alternate canonical
hostname rejected gateway calls at IAM before reaching IAP; switching to the
published URL enabled authenticated model and sample requests without widening
the backend's IAM policy.

The gateway service account has Token Creator only on itself, and IAP access
only to `depth-wizard`. Supabase's redirect allowlist includes both service
URLs with `/**`. Gateway public access uses Cloud Run's disabled invoker IAM
check; API access still requires a valid, non-anonymous Supabase session.

The live audit found HTTPS upload rejection after Cloud Run TLS termination.
Set `GATEWAY_PUBLIC_ORIGIN` to the public HTTPS gateway origin; the proxy checks
incoming Origin against this explicit configuration. Sample thumbnails now
fetch through the authenticated transport, and backend cookies cannot be
reused by the shared proxy client. The final lightweight repair image build
`e1d9ae97-1ab0-4e08-b090-5597ca20b7c4` completed successfully, and revision
`depth-wizard-gateway-00006-469` serves 100% of gateway traffic. No model-backend
image rebuild was needed.

Verified live: gateway health responds successfully; its public browser config
enables Google login and requires sign-in for analysis; an invalid user token
is rejected. Google login returns to the signed-in app. A real sample analysis
completed in 1.159 seconds, appeared in the signed-in user's Supabase history,
and reopened with its original image and depth result. Ten additional gateway checks passed with a mocked backend,
including guest rejection, separate user/IAP identity forwarding, stripping
cookies and spoofed IAP headers, rejecting cross-origin requests, and blocking
local authentication routes, HTTPS termination, and cookie isolation on
successive requests. The frontend build and all 12 frontend tests passed;
55 backend tests passed with one skipped. Local tests do not prove hosted
inference or cross-account isolation.

Remaining live work:

- Hosted deletion and isolation between two separate accounts were not tested.
- GitHub main still contains the offline demo commit. A backend deployment
  from main would restore demo-only behavior. The recovered source is on the
  `codex/finish-cloud-run-gateway` branch; keep the serving pre-demo backend
  revision pinned until the branch is reconciled with main and its trigger.

The gateway serves the frontend publicly. `/api/*` requires a verified, non-anonymous Supabase user
and forwards that user's token in `Authorization`, with the gateway's
short-lived IAP token in `Proxy-Authorization`. Supabase history and storage
continue using the user's session and owner-scoped policies. No private
Supabase key belongs in the browser or this gateway.

## Existing private backend

- Google Cloud project: `project-f78febd0-7836-4470-8e4`
- Cloud Run service: `depth-wizard`, region `asia-south1`
- Service URL: https://depth-wizard-133290700595.asia-south1.run.app
- Supabase organization: `251b645@juetguna.in's Org`
- Existing Supabase project: `depth-wizard` (`jricazzvfyqghbavsaqa`)

The existing `depth-wizard-main` Cloud Build trigger builds the Dockerfile on
pushes to main, pushes the image, and deploys it while preserving the existing
private IAM and Identity-Aware Proxy settings. IAP allows only the gateway
service identity. The builder has Cloud Run Developer on this service and
Service Account User on its existing runtime identity. A deployment using that
builder identity completed successfully.

## Model runtime capacity

Depth Anything V2 Small/Base and MiDaS Small fit the 2 GiB runtime. Depth
Anything V2 Large, MiDaS Large, and ZoeDepth need a larger memory limit. Model
weights download on first use and are cached for the lifetime of a container
instance. Switching models releases the previous model before loading the next
to limit peak memory. Metric3D is shown as unavailable until its runtime is
implemented; the procedural fallback is a synthetic heuristic, not an ML
depth model.

The backend does not install Transformers or `huggingface_hub`. ZoeDepth and
MiDaS use `timm==0.6.12` without timm's optional Hub dependencies. Depth
Anything V2 uses its vendored upstream PyTorch implementation. Its three
official checkpoint files are downloaded directly from the upstream model
URLs on first use; the backend still needs outbound access to those URLs.

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
remains the existing backend Cloud Run URL; the redirect allowlist includes
both the backend and gateway Cloud Run origins. Email confirmation is
disabled at the user's request: signup uses only email and password and returns
an immediate session. Email ownership is not verified. Google sign-in uses a
separate OAuth client registered with Supabase; set `SUPABASE_GOOGLE_ENABLED=true`
only after the Google provider is configured. OAuth client secrets belong only
in the Supabase provider settings.

Signed-in single-image analyses use Supabase history and storage. Guest,
batch, and video results are session-only. Container-local SQLite and upload
directories are not persistent cloud storage.

## Remaining live verification

Private backend protection, Google login, analysis, and save/reopen of the
owner's private history are verified. Hosted deletion and isolation between
two separate accounts were not exercised in this deployment audit.

Shadow areas use square metres only when the spacing of the depth raster is
provided. Otherwise the UI reports pixel counts and illustrative coverage.
Depth/DSM accuracy requires real reference data and is not established by
deployment or synthetic tests.
