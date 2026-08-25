# Session handoff — CUES Editorial Cloud

Last updated: 2026-08-25 (session 11 — production audit: CORS blocker found and
fixed, `score-worker` v7 provenance resolved, stale Netlify deploy identified).
Read this first, then `MIGRATION_PLAN.md`. This file is the single "where are
we" pointer between working sessions.

> Keep writing state here. Claude Code deletes local session transcripts after
> `cleanupPeriodDays` (default 30), and the session 1–10 transcripts were lost
> that way on 2026-08-25. This file and the git history are the only durable
> record.

## Plain-language state (read this first)

**Session 11 ran no pipeline stages and changed no application code.** It was an
audit of what is actually deployed versus what is in this repo. Cloud data is
exactly what session 10 left behind. Three things came out of it that were not
previously known, and one production blocker was fixed.

| Piece | Status |
|---|---|
| `ingest` | live since Phase 2, unchanged |
| `score-worker` | cloud `v7` **provenance resolved this session** — it is this repo's code plus one deliberate internal-only guard (see below). "Score now" still 403s, now for a known and correct reason. |
| `anonymize-worker` | unchanged since session 10; all 51 eligible posts anonymised |
| `cluster` | unchanged; 1 run, 4 labeled clusters |
| `generate` | unchanged; 1 request, 1 result |
| Edge Function CORS | **fixed this session** — the production origin was rejected at preflight on all five functions |
| Frontend (repo) | all six stages bound, Generate action + history present at `8bcc9c1` |
| Frontend (deployed) | **stale — serving a pre-`814ebfc` build.** `/generate` is still the "Not built yet" placeholder in production. |

## What happened this session (11)

1. **CORS was the real production blocker, not the `score-worker` 403.**
   Every Edge Function rejected `https://cues-tca.netlify.app` at preflight —
   HTTP 403, no `Access-Control-Allow-Origin` — while accepting
   `http://localhost:5173`. The `ALLOWED_ORIGINS` secret existed but did not
   contain the production origin: step C.2 of `docs/NETLIFY_DEPLOYMENT.md` was
   never completed. Consequence: **every action button in production was dead**
   — Collect, Score, Anonymise, Run clustering, Generate. Reads were unaffected
   (PostgREST/RLS, not Edge Functions), so the app looked healthy.

   Fixed by setting the secret to a superset that preserves local dev:

   ```
   ALLOWED_ORIGINS="http://localhost:5173,http://127.0.0.1:5173,https://cues-tca.netlify.app"
   ```

   No redeploy needed — `_shared/cors.ts` reads it per request. Verified: all
   ten function×origin preflight combinations now return 204 with the correct
   `Access-Control-Allow-Origin`.

   **Deploy previews still will not work.** `isAllowedOrigin` uses an exact
   `Array.includes()`, so the `https://*--<site>.netlify.app` wildcard that
   `NETLIFY_DEPLOYMENT.md` suggests works for Supabase Auth redirect URLs but
   not for CORS. Functional previews need prefix matching in `cors.ts`.

2. **`score-worker` v7 provenance is resolved — stop treating it as unknown.**
   The deployed eszip bundles of all five functions were downloaded via the
   Management API (`GET /v1/projects/{ref}/functions/{slug}/body`), unpacked
   with `@deno/eszip`, and compared against this repo after type-erasure
   through the same compiler. (The deployed code is transpiled and reformatted,
   so a raw text diff is meaningless — it reports every single file as
   different, including functions we know were deployed from here.)

   Across all 41 deployed modules there is **exactly one semantic difference**,
   in `score-worker/index.ts`:

   ```js
   // cloud v7 — present
   const actor = await authenticate(req, body);
   if (actor.kind !== "internal") {
     throw new RequestError(403, "score-worker is driven by the queue, not by a user request.");
   }

   // this repo — absent
   await authenticate(req, body);
   ```

   Everything else differs only in bundler emit (dropped redundant parens, a
   class-field initializer moved into the constructor). Cloud v7 is this repo's
   `score-worker` plus a deliberate internal-only invocation guard. Confirmed
   end to end in production after the CORS fix — clicking "Score now" now
   reaches the function and returns
   `{"ok":false,"error":"score-worker is driven by the queue, not by a user request."}`.

   **The remaining decision is a design one, not archaeology:** either drop the
   guard so allowlisted admins can drain the queue from the UI, or keep it and
   route "Score now" through the internal-secret path. Do not re-enqueue the 47
   unscored posts until this is settled.

3. **The Netlify deploy is one commit behind, and has been since 2026-07-24.**
   The served bundle contains no reference to `cluster_generation_requests`,
   `cluster_generation_results`, `carousel`, or the generation-history view,
   and it *does* contain the string `"Not built yet — Phase 6."`. That is the
   state before `814ebfc` ("bind Generate to cluster selection and add history
   view"). Confirmed in the live UI: `/generate` renders the placeholder and no
   Generate action exists on the Clusters view.

   `origin/main` and `origin/phase6-frontend-binding` are both at `8bcc9c1`,
   equal to local HEAD — **nothing is unpushed.** The build did not run, failed,
   or is wired to something other than the expected branch. Netlify's deploy log
   is the next place to look. Note that with `base = "frontend"` in
   `netlify.toml`, Netlify can skip builds for commits touching no files under
   `frontend/`, which would explain why the docs-only tip commit `8bcc9c1`
   produced no deploy.

4. **Generated content cannot be reviewed or exported — the two halves are not
   connected.** `Review.tsx` and `Export.tsx` read `editorial_assets`;
   `generate` writes `cluster_generation_results`. All 15 `editorial_assets`
   rows are legacy (created 2026-06-26 → 2026-07-01, all `draft`, none
   approved), and `cluster_generation_results` has no `status`, `approved_by`,
   or `approval_notes` columns at all. The review workflow currently operates
   entirely on dead legacy data. This is the substance of Phase 7.

5. **Anonymisation leak in the Clusters view (display-only).**
   `anonymized_posts_current` has no title column — the anonymiser only
   processes `post_text` — but `Clusters.tsx:623` renders `raw_posts.post_title`
   *in preference to* the anonymised text. Exactly one of the 180 raw posts
   carries a title, and it is `"GBfoods Sustainability Initiative"`, so the
   source company name is displayed verbatim in the very list an editor uses to
   inspect anonymisation. The `anonymized_text` column itself is clean (0 of 51
   contain the name) and `generate` reads only `anonymized_posts_current`, so
   nothing leaks into generated copy. Any future titled post bypasses
   anonymisation in this view.

6. **Smaller observations from the live walkthrough** (all seven routes, signed
   in as the single allowlisted editor):
   - `/export` opens empty: the default status filter is `approved` and every
     asset is `draft`.
   - Every row on `/posts` shows the reason *"Simulated LLM semantic scoring
     (source-aware, context-based)"* — the 133 legacy analyses. No post
     currently visible to an editor carries a real LLM score.
   - The corpus encoding corruption is visible on every screen (`qualit?`,
     `L?Italia`, `????`), including the editor's own `full_name` in
     `public.editors`.
   - Stage-2 over-replacement produces ungrammatical Italian, e.g. *"Si è
     riunita oggi al MASAF la another food-sector organization"*.
   - `routes/Placeholder.tsx` is now unreferenced — `App.tsx` imports every
     route directly.

## Known issues / decisions for next session

- **`score-worker` guard** — design decision, see item 2. Blocks the 47
  unscored posts.
- **Netlify rebuild** — see item 3. Until it runs, production has no Generate.
- **Phase 7 bridge** — migration `0017` adding review columns to
  `cluster_generation_results`, plus rewiring `Review.tsx` / `Export.tsx`.
  Regeneration-with-feedback and DOCX export are still unbuilt.
- **Title anonymisation** — either anonymise titles in the worker, or stop
  preferring the raw title in `Clusters.tsx`. The second is a one-line fix.
- **Encoding corruption** — still unaddressed at ingest, still cosmetic-only for
  generated copy.
- **Secret hygiene** — `frontend/.env.local` still holds the Supabase PAT and
  the DB password. Gitignored, but it does not belong in the frontend
  directory. `SUPABASE_ACCESS_TOKEN` is better set as a user environment
  variable, which is also where the Supabase MCP server reads it from.

## Cloud vs local — exact state (verified 2026-08-25)

| | Cloud (`bxaovkzemfyxrxbcqask`) | Local stack |
|---|---|---|
| Migrations | 0001–0016 — identical set to `supabase/migrations/` | as of session 10 |
| Data | 180 raw_posts · 133 analyzed (47 raw unscored) · 51 anonymized (0 still eligible) · 51 embedded · 4 clusters / 10 assignments · 1 cluster generation request + 1 result · 15 legacy editorial_assets, all draft | — |
| Functions | ingest v8, score-worker v7, anonymize-worker v6, cluster v3, generate v1 — all ACTIVE, all verified against this repo | — |
| Secrets | `ALLOWED_ORIGINS` updated this session; others unchanged | — |
| Config | `min_relevance_score` 50 · `cluster_similarity_threshold` 0.75 · `min_cluster_size` 2 · 6 themes | — |
| Branches | `main` == `phase6-frontend-binding` == `8bcc9c1`, pushed | — |
| Netlify | serving a pre-`814ebfc` build | — |

## Verifying deployed functions against this repo

Worth repeating whenever a deployment's provenance is in doubt:

1. `GET https://api.supabase.com/v1/projects/{ref}/functions/{slug}/body` with
   the PAT returns an ESZIP2 archive.
2. Unpack it with `@deno/eszip`: `Parser.createInstance()` → `parseBytes()` →
   `load()` → `getModuleSource(spec)` for each `functions/…` specifier.
3. Compare against the repo only after running **both** sides through
   `ts.transpileModule` (type erasure, comments stripped) and stripping
   whitespace. Trailing commas and redundant parens still differ after that —
   normalise `,}` `,)` `,]` before concluding anything.

## How to continue

1. Get the Netlify build running; confirm the live bundle stops containing
   `"Not built yet"` and starts containing `cluster_generation_results`.
2. Settle the `score-worker` guard, then drain the 47 unscored posts.
3. Phase 7 per `MIGRATION_PLAN.md`: the review/export bridge first — it is the
   thing standing between "the pipeline runs" and "an editor can ship copy".
4. Re-run the production smoke checklist in `docs/NETLIFY_DEPLOYMENT.md` §C,
   which is now unblocked for the first time.
