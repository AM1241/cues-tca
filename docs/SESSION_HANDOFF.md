# Session handoff — CUES Editorial Cloud

Last updated: 2026-07-24 (session 10 — merge to main, first real Phase 4/5
executions, Generate binding). Read this first, then `MIGRATION_PLAN.md`.
This file is the single "where are we" pointer between working sessions.

## Plain-language state (read this first)

**The full pipeline — ingest → score → anonymise → cluster → generate — has
now run end to end against cloud with real data and real OpenAI calls.** All
implementation branches are merged; `main` and `phase6-frontend-binding`
point at the same commit, and Netlify deploys from `phase6-frontend-binding`
(see `docs/NETLIFY_DEPLOYMENT.md`).

| Piece | Status |
|---|---|
| `ingest` | live since Phase 2, unchanged |
| `score-worker` | cloud `v7` works but **could not be diffed against this repo** (deployed from a colleague's checkout). Repo version NOT deployed — blocked on confirming v7's provenance with its author. "Score now" in the UI 403s until resolved. |
| `anonymize-worker` | **redeployed this session** with the source-name-variants fix (see below); all 51 eligible posts anonymised through it |
| `cluster` | first real run this session: 51/51 embedded, 4 labeled clusters, 0 failures |
| `generate` | first real run this session: 1 cluster, post + carousel, `status=completed` |
| Frontend | all six stages bound; Generate action on Clusters view + read-only history on `/generate`. Deployed via Netlify from `phase6-frontend-binding`. |

## What happened this session (10)

1. **Merged everything to `main`**: `phase6-frontend-binding` (fast-forward)
   + `phase5-generation` (clean merge — the predicted `config.toml` conflict
   auto-resolved) + the colleague's Netlify prep commit (`5bcd509`).
   `main` == `phase6-frontend-binding`; both pushed.
2. **Widened the anonymise run** from 2 to all 51 eligible posts, in bounded
   batches (10/25/14), zero failures — and the watching paid off:
   - **Leak found**: "GBfoods" survived anonymisation. Root cause is an
     inter-stage contract bug: stage 1 only replaced the exact catalogue
     label ("STAR / GBfoods Italy LinkedIn", which never appears in body
     text) while stage 2's prompt tells the model *not* to report the
     source's own name — so short forms fell through both stages.
   - **Fix deployed**: stage 1 now expands the label into the name forms
     posts actually use (strip " LinkedIn", split on "/", strip trailing
     country), each guarded per-variant by `isPublicBody`. MASAF, ISMEA,
     CREA, INAIL, AGEA, UNESCO, Agenzia ICE, Camera dei Deputati added to
     the exact-name preservation list (the model had been replacing them,
     MASAF inconsistently). 15/15 offline tests + the 12-step DB-backed
     handler suite pass; commit `081f986`.
   - **All 51 posts re-anonymised** under the fixed worker (requeue via
     `anonymize_job_state` reset + fresh `pgmq.send`, mirroring backfill).
     Verified: no company-name survivals, MASAF consistently preserved
     (`generalized_source_name = 'MASAF LinkedIn'`), no listed institution
     replaced anywhere.
3. **The "30 legacy rows" question resolved itself**: backfill eligibility is
   `current_result_id IS NULL`, which the legacy-loaded rows satisfied, so
   the widened run replaced them in place with real pipeline output.
   `anonymized_posts_current` = 51 rows, all pipeline-produced, zero legacy
   remnants, zero still-eligible.
4. **First real clustering run** (period 2025-07-01 → 2026-07-24): 51
   eligible, 51 embedded, 4 Italian-labeled clusters (2–3 posts each), 41
   unclustered, no label failures.
5. **First real generation**: 1 cluster ("Più controlli, più sicurezza…"),
   post + carousel, `gpt-5.4-nano`, `generate_v1`, request `completed`,
   result row carries the full traceability snapshot (3 posts).
6. **Generate bound in the frontend** (commit `814ebfc`): action on the
   Clusters view, read-only history on `/generate` (replaces the
   placeholder). Typecheck, build, and oxlint clean.

## Known issues / decisions for next session

- **Corpus-wide encoding corruption (pre-existing, upstream of Phase 4):**
  non-ASCII characters (accents, curly quotes) are literal `?` in
  `raw_posts.post_text` — verified at the byte level (`ascii()=63`) on the
  RAW rows, so ingest or the RapidAPI provider mangled them. Anonymise
  faithfully preserves the corruption; cluster labels are clean because
  they're LLM-written. Worth fixing at ingest and re-collecting, or
  accepting for editorial copy (generate outputs read fine regardless).
- **Stage-2 over-replacement (safe direction, quality cost):** the entity
  extractor replaces regions (Lombardia, Veneto), generic phrases ("Made in
  Italy", "GDO"), people (Al Bano, Ministro Lollobrigida), and event names
  with "another food-sector organization". No leak risk, but it degrades
  the text `generate` reads. Tightening the prompt or the merge guard is a
  candidate follow-up, not urgent.
- **`score-worker` deploy still blocked** on v7 provenance (see table).
  The 47 unscored posts stay unscored until that's resolved — re-enqueueing
  them is pointless before a trusted worker is deployed.
- **Secret hygiene:** `frontend/.env.local` holds a Supabase PAT
  (`SUPABASE_ACCESS_TOKEN`) and the DB password — gitignored, but rotate
  the PAT and move it out of the frontend directory. Flagged in
  `docs/PHASE6_FRONTEND_BINDING.md` too.
- A temporary admin editor (`temp-anonymize-widen@cues-internal.test`) was
  created for this session's function calls and **deleted afterwards**
  (auth user + `editors` row; `created_by` on the generation request is
  null by FK `on delete set null`). The real allowlist is 1 editor.

## Cloud vs local — exact state (verified end of session 10)

| | Cloud (`bxaovkzemfyxrxbcqask`) | Local stack |
|---|---|---|
| Migrations | 0001–0016 | 0001–0016 (`supabase db reset` re-run this session; local had drifted to pre-0014 and was reset) |
| Data | 180 raw_posts · 133 analyzed · 51 anonymized (all pipeline-produced) · 1 clustering run (4 clusters) · 1 generation request (completed) + 1 result | empty (reset) |
| Functions | ingest, score-worker v7 (unverified provenance), anonymize-worker (**fixed version**), cluster, generate — all ACTIVE | — |
| Branches | `main` == `phase6-frontend-binding` == Netlify deploy branch | — |

## How to continue

1. Resolve `score-worker` v7 provenance with its author → deploy repo
   version → re-enqueue the 47 unscored posts → "Score now" works.
2. Decide on the encoding corruption (fix ingest + re-collect vs. accept).
3. Optional: tighten stage-2 over-replacement.
4. Phase 7 per `MIGRATION_PLAN.md`: review workflow over generation results
   (approve/edit/regenerate), DOCX export, production smoke on the Netlify
   URL (`docs/NETLIFY_DEPLOYMENT.md` §C checklist).
