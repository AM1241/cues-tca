# Migration & optimisation plan

Moving `cues-tca-editorial-agent` (FastAPI + SQLite + Docker, no auth, no UI) to
Supabase + Netlify, and fixing the things that make the current system expensive to operate.

Target: an editor opens a URL, logs in, sees the collected posts and their scores, adjusts
the editorial objective, presses a button, reviews the generated post, approves it, exports
it. No terminal, no Docker, no manually shuttling JSONL files to a provider.

## Why Supabase can carry all of this

The legacy pipeline is regex, string assembly and LLM HTTP calls. `requirements.runtime.txt`
is nine packages, none of them ML — `numpy`, `spacy` and `sentence-transformers` are listed
in `requirements.txt` but never imported at runtime. So nothing forces Python, and Deno
Edge Functions can run every stage.

The two constraints that do bite, and the answers:

| Constraint | Impact | Answer |
|---|---|---|
| Edge Function wall clock ~400s | Scoring 133 posts in one invocation would blow it | Work queue (`pgmq`) drained in chunks by a cron-triggered worker |
| Edge Function CPU time ~2s | Irrelevant — the work is awaiting `fetch`, not computing | — |
| No long-lived process | No APScheduler | `pg_cron` for nightly ingest and queue draining |
| No local filesystem | Batch JSONL and exports have nowhere to live | Supabase Storage |

At 133 posts, 4 sources and ~10 users, this sits inside the Supabase and Netlify free tiers;
the only real cost is LLM tokens.

## Architecture

```
Netlify (static)                     Supabase
┌──────────────────┐                 ┌─────────────────────────────────────┐
│ Vite React SPA   │  supabase-js    │ Auth (magic link) ── editors table  │
│  Sources         │ ───────────────>│ Postgres + RLS + pgvector           │
│  Posts & scores  │   anon key      │   sources, raw_posts,               │
│  Objective       │                 │   analyzed_posts,                   │
│  Generate        │  invoke()       │   anonymized_posts_current,         │
│  Review/Approve  │ ───────────────>│   editorial_assets, traceability    │
│  Export          │                 │ Edge Functions (Deno/TS)            │
└──────────────────┘                 │   ingest score anonymize            │
                                     │   cluster generate export           │
                                     │ pgmq queue + pg_cron                │
                                     │ Storage: batches, exports           │
                                     └─────────────────────────────────────┘
                                          │ RapidAPI LinkedIn, OpenAI
```

Rule: the browser never holds a provider key. All LLM and RapidAPI calls happen in Edge
Functions using secrets set with `supabase secrets set`.

## What changes, and why

Beyond the lift-and-shift, these are the actual improvements. Each maps to a phase below.

1. **The manual batch step disappears.** Today an operator runs `batch/build`, takes the
   JSONL to the provider by hand, and posts back a `results_path`. Replaced by a queue: new
   posts are enqueued on insert, a cron-driven worker drains them. Optionally the OpenAI
   Batch API is used for cost (50% cheaper, 24h) with cron polling the batch status — still
   zero human steps.
2. **Scoring returns per-theme scores again.** The live batch prompt asks for a bare integer,
   so `apply_scores` writes `{theme: 0.0}` for all themes — which starves clustering, which
   buckets posts by highest per-theme score. The richer prompt already exists in the dead
   `llm_batch_scoring_service.py`; port that one, with a JSON schema response format.
3. **Real clustering.** pgvector embeddings + cosine similarity instead of "assign to the
   theme with the highest score". Same embeddings also give semantic dedup, which the
   current URL-equality check misses.
4. **No silent fallback.** `_call_real_llm` swallows every exception and returns hardcoded
   editorial copy. Failures become explicit errors with a `llm_used: false` flag surfaced in
   the UI, never a canned post that reads like a real one.
5. **Structured LLM output.** Titles and hashtags are currently regex-scraped out of markdown.
   Use JSON schema output so the asset fields are typed at the source.
6. **Anonymisation gets an entity pass.** Today the replacement map is built from source
   names only — a company mentioned in the body but not the source name survives. Add an LLM
   entity-extraction step, keep the deterministic replacement and the `replacements` audit
   list.
7. **Review and export actually exist.** The columns are there; nothing writes them. Every
   stored asset is `status='draft'`. This is the missing half of the product.
8. **Auth and RLS.** There is currently no authentication and `allow_origins=["*"]`. On a
   public Netlify URL that is not acceptable.

## Phases

Each phase ends in something demonstrable. Don't start the next until the check passes.

### Phase 0 — Foundation

- `supabase init`, link a cloud project, `npm create vite@latest frontend -- --template react-ts`,
  Tailwind, `netlify.toml`, `.gitignore`, `git init` (the legacy repo was never under version control).
- Commit `CLAUDE.md`, `MIGRATION_PLAN.md`, `docs/`.
- **Check:** `supabase start` and `npm run dev` both come up clean.

### Phase 1 — Schema, auth, data migration

- Migration `0001_schema.sql`: port the nine tables with real types — `timestamptz` not naive
  datetimes, `uuid` PKs, `jsonb`, FK constraints, indexes on `raw_posts(source_id, published_at)`
  and `analyzed_posts(overall_relevance)`.
- Fix `raw_posts`: surrogate `uuid` PK plus a unique constraint on `(source_id, content_hash)`.
  The legacy key `f"{type}_{name}_{md5(text)}"` collides when one source posts identical text
  at two URLs. Add `updated_at` triggers.
- Drop `clusters` and `analyzed_posts_backup_before_mock_llm`. Clustering is stateless; the
  backup table was a one-off.
- Migration `0002_auth_rls.sql`: `editors` table keyed to `auth.users`, RLS on every table
  (`authenticated` + present in `editors`), service-role-only write paths for pipeline tables.
- One-shot script to load the legacy dump: 133 posts, 4 sources, 30 anonymised, 15 assets,
  89 traceability links. Migrate `configurations` as a single row.
- **Check:** row counts match `docs/legacy-system.md`; an anon-key client is denied on every
  table; a logged-in allowlisted user can read posts.

### Phase 2 — Ingest

- Edge Function `ingest`: calls RapidAPI LinkedIn directly per configured source, upserts
  into `raw_posts` on the new unique constraint, honours `lookback_days`. This deletes the
  `subprocess` → sibling-repo → HTTP-back-to-itself loop entirely.
- Move `connector_config.json` into the `sources` table; add `rapidapi_identifier` and
  `lookback_days` columns.
- `pg_cron` nightly trigger; manual "Collect now" from the UI.
- **Check:** a run against a live source inserts new rows and inserts nothing on a second run.

### Phase 3 — Scoring

- `pgmq` queue `scoring_jobs`; trigger enqueues on `raw_posts` insert.
- Edge Function `score-worker`: drains N jobs per invocation, one LLM call per post, JSON
  schema response with `overall_relevance`, per-theme `relevance_scores`, `reason_for_score`.
  Port the prompt from the dead `llm_batch_scoring_service.py`, not the live integer-only one.
- `pg_cron` drains the queue every few minutes. Retry with backoff; a job that fails three
  times lands in a dead-letter table visible in the UI.
- Optional: `score-batch-submit` / `score-batch-poll` using the OpenAI Batch API for bulk
  re-scoring runs, polled by cron. Same prompt, same writer.
- **Check:** re-scoring all 133 posts completes unattended and every row has non-zero
  per-theme scores.

### Phase 4 — Anonymise & cluster

- Edge Function `anonymize`: LLM entity extraction, then the legacy deterministic replacement
  (port `anonymization_service.py` closely — the public-body preservation list and the
  `replacements` audit trail are correct and worth keeping). Upsert into
  `anonymized_posts_current`, preserving overwrite-only semantics and the config snapshot.
- Enable `pgvector`; embed each anonymised post; cluster by cosine similarity; label clusters
  with one LLM call each. Replace `objective_clustering_service.py` wholesale.
- **Check:** clusters are semantically coherent on the real 133 posts and no longer collapse
  into the single "Objective Context" fallback.

### Phase 5 — Generation

- Edge Function `generate`: port the prompt builder and the four output formats
  (`post`, `carousel`, `post+carousel`, `newsletter`) close to verbatim — this is the best
  code in the legacy system. Read from `anonymized_posts_current` for the requested window.
- Structured JSON output for title / body / slides / hashtags. Write `editorial_assets` +
  `traceability_links` in one transaction.
- No simulated fallback. On LLM failure, fail the request and surface it.
- **Check:** output quality matches or beats the stored legacy assets on the same window.

### Phase 6 — Frontend

Routes: **Sources** (CRUD, enable/disable, collect now) · **Posts** (table with scores,
reasons, filters) · **Objective** (themes, voice, threshold, aliases — the config row) ·
**Generate** (period, format, instructions; live job status) · **Review** (asset with its
traceability panel, edit, approve, reject, request regeneration) · **Export**.

- `supabase-js` with the anon key; generated types from `supabase gen types typescript`.
- Magic-link login, allowlist enforced by RLS.
- Realtime subscription on job status so long pipeline runs report progress.
- **Check:** the full pipeline is drivable end to end without a terminal.

### Phase 7 — Review, export, deploy

- Review is the last unbuilt stage: write `status`, `approved_by`, `approval_timestamp`,
  `approval_notes`, `feedback_provided`; regeneration re-runs `generate` with the feedback
  appended to the prompt and links the new asset to the old one.
- Export: markdown and JSON client-side; DOCX via Edge Function into Storage with a signed URL.
  Traceability export ships the source-post mapping alongside.
- Netlify: connect the GitHub repo, `VITE_SUPABASE_URL` / `VITE_SUPABASE_ANON_KEY` in build
  env, SPA redirect rule. Deploy previews on PRs.
- **Check:** an editor completes collect → score → generate → approve → export on the
  production URL.

## Sequencing note

Phases 1–5 can be built and verified against the local stack before anything is deployed.
Phase 6 needs Phase 1 (types and RLS) but not Phases 3–5 — it can start in parallel against
the migrated data.

## Before starting

- **Rotate the OpenAI key.** The legacy `.env` holds a live one. Set the new key with
  `supabase secrets set`, never in the frontend or Netlify env.
- Take the legacy dump (`docs/legacy-system.md` has the command) and keep the old Docker
  container running until Phase 7 passes.

## Open questions

- RapidAPI: which endpoint/provider does `../linkedin_rapidapi_scraper` actually call? Needed
  for Phase 2 — that repo has to be read before the ingest function can be written.
- Do the 15 stored `editorial_assets` need to survive, given some are likely simulated
  fallback output rather than real generations? Migrating them with an `is_legacy` flag is
  the safe default.
- Multi-tenant later, or CUES-only forever? Affects whether `sources` and `configurations`
  get an `org_id` in Phase 1. Adding it now is cheap; retrofitting is not.
