# Netlify frontend preview

Import `prakharendrashukla-cyber/depth-wizard` from GitHub in Netlify. The root
`netlify.toml` selects `frontend`, Node 22, `npm test && npm run build`, and `dist`.
Netlify installs dependencies from the committed npm lockfile before the build.
Enable Deploy Previews for pull requests to get a URL for each proposed change.

The initial deployment is a frontend/demo preview. Choose **Try without login**,
then **Open offline demo (precomputed)**. The bundled result supports heatmap,
3D exploration and client-side charts. New inference and server-side analysis
or exports require the Python backend. Demo measurements remain illustrative.

## Connect live services later

Set these public build variables in Netlify, then rebuild:

- `VITE_API_BASE`: the public HTTPS FastAPI URL including `/api`, for example
  `https://your-api.example.com/api`. Netlify does not host the Python model.
- `VITE_SUPABASE_URL` and `VITE_SUPABASE_PUBLISHABLE_KEY`: optional, to enable
  cloud sign-in and saved history. Never expose a service-role key or secret.

The backend must use `AUTH_PROVIDER=supabase`, with `ALLOW_GUEST=true` for guest
inference. Add the exact frontend origin to backend `ALLOWED_ORIGINS`. Follow
[the cloud setup guide](SUPABASE.md) for the database, storage and Auth redirects.
Use a durable backend host for ongoing availability; a laptop tunnel ends when
the laptop or tunnel stops.

Requests to the preview's unconfigured `/api/*` return an explicit JSON 404.
This prevents the SPA fallback returning HTML as if an API call succeeded.
After `VITE_API_BASE` is set, the browser calls that external backend directly.

## Validation

Run `npm ci`, `npm test`, and `npm run build` in `frontend`. For a local build
matching Netlify, set `VITE_AUTH_PROVIDER=supabase` in the build environment.
On the deployed preview verify guest entry, the precomputed result, the 3D view,
and refresh on a nested URL. Verify real inference separately after connecting
the backend; a successful frontend deployment does not establish model uptime.
