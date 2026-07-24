# Netlify deployment — CUES Editorial Cloud frontend

Short, operational. Deployment candidate: **`phase6-frontend-binding`**
(the current Phase 6 branch). Repository config lives in the root
`netlify.toml` — the Netlify dashboard should not need any settings beyond
what's below.

## A. Netlify dashboard setup (manual, one-time)

1. **New site from Git** → select the `cues-tca` GitHub repository
   (`AM1241/cues-tca`).
2. **Branch to deploy**: `phase6-frontend-binding`.
3. Netlify reads `netlify.toml` from the repo root automatically. Confirm it
   picked up:
   - **Base directory**: `frontend`
   - **Build command**: `npm ci && npm run build`
   - **Publish directory**: `frontend/dist` (shown as `dist` relative to the
     base directory)
4. **Environment variables** (Site settings → Environment variables) — add
   exactly these two, with real cloud values:
   - `VITE_SUPABASE_URL`
   - `VITE_SUPABASE_PUBLISHABLE_KEY`
5. **Deploy site** — trigger the first deploy.
6. Copy the resulting production URL (e.g. `https://<site-name>.netlify.app`,
   or your custom domain once attached). You'll need it for step C.

Do not add any other environment variable. See "What must NOT be in Netlify"
below.

## B. What must NOT be in Netlify

None of these belong in Netlify's frontend environment variables, or
anywhere reachable by the browser bundle. They are Supabase Edge Function
secrets only (`supabase secrets set`), unrelated to this static-site deploy:

- `SUPABASE_SERVICE_ROLE_KEY`
- `SUPABASE_DB_PASSWORD`
- `SUPABASE_ACCESS_TOKEN`
- `OPENAI_API_KEY`
- `INGEST_INTERNAL_SECRET`
- `RAPIDAPI_KEY`

## C. Post-deploy Supabase steps (manual, after you have the production URL)

1. **Supabase Dashboard → Authentication → URL Configuration**:
   - Set **Site URL** to the Netlify production URL.
   - Add the same URL (and any Netlify deploy-preview pattern you use, e.g.
     `https://*--<site-name>.netlify.app`) to **Redirect URLs**.
2. **Edge Function CORS**: add the Netlify production origin (scheme + host,
   no trailing slash, e.g. `https://<site-name>.netlify.app`) to
   `ALLOWED_ORIGINS` if it is not already present, then redeploy is not
   required — `ALLOWED_ORIGINS` is read from the secret at request time by
   `supabase/functions/_shared/cors.ts`:
   ```
   supabase secrets set ALLOWED_ORIGINS="<existing-origins>,https://<site-name>.netlify.app"
   ```
3. Do **not** put any Supabase service-role key or other backend secret in
   Netlify — see section B.
4. **Smoke test on the live Netlify URL**:
   - [ ] Login (email + password) succeeds.
   - [ ] Logout returns to the login screen.
   - [ ] A direct browser refresh on a nested route (e.g. `/clusters` or
         `/review`) loads the app, not a Netlify 404 — proves the SPA
         redirect in `netlify.toml` is active.
   - [ ] Clusters/generation data loads for an allowlisted editor (a read
         against Supabase tables — no new backend deploy required).
   - [ ] One authenticated write action that doesn't require a new backend
         deployment (e.g. toggling a source's enabled state, or updating the
         `configurations` objective) succeeds and persists.

## Repository configuration reference

`netlify.toml` (root):

```toml
[build]
  base = "frontend"
  command = "npm ci && npm run build"
  publish = "dist"

[build.environment]
  NODE_VERSION = "22"

[[redirects]]
  from = "/*"
  to = "/index.html"
  status = 200
```

`frontend/.env.example` documents the only two variables the deployed
frontend reads (`frontend/src/lib/supabase.ts`):

```
VITE_SUPABASE_URL=
VITE_SUPABASE_PUBLISHABLE_KEY=
```
