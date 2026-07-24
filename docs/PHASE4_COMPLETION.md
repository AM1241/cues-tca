# Phase 4 completion — anonymisation & reproducible clustering

**Status: implemented, deployed and smoke-verified. Real-content validation is
deferred to the first controlled execution.** This is an intentional product
decision, not an unfinished-work marker — see "Deliberately deferred" below.
Do not treat the deferred real-data acceptance as a blocker to Phase 5.

## What shipped

- **Implementation commit:** `76a9a53` (`feat(phase4): implement anonymisation
  and reproducible clustering`) on `phase4-requirements`.
- **Cloud migrations applied:** `0014_anonymize_schema.sql`,
  `0015_clustering.sql` — confirmed via `supabase migration list` (local ==
  remote for both).
- **`anonymize-worker` Edge Function:** deployed, `ACTIVE`, version 1,
  `verify_jwt=false` (internal-secret auth only — see
  `supabase/functions/_shared/auth.ts`).
- **`cluster` Edge Function:** deployed, `ACTIVE`, version 1,
  `verify_jwt=false` (dual auth: internal secret or an admin editor JWT).

Schema highlights (full detail in the migration files themselves):

- `anonymize_results` — append-only, immutability-trigger-enforced, same
  pattern as `scoring_results`.
- `anonymize_results(id, raw_post_id)` composite unique constraint, with
  composite foreign keys from `post_embeddings` and `clustering_run_posts`
  enforcing that a `raw_post_id` can never be paired with another post's
  `anonymize_result_id` — a database-level guarantee, not just an
  application-level assumption.
- `complete_clustering_run` computes every centroid using only
  `post_embeddings` rows matching the run's own immutable `embedding_model` —
  embeddings from a different model are never averaged in — and hard-fails if
  any assigned post lacks exactly one embedding under that model.
- `clustering_run_posts.embedding_status` (`pending|embedded|failed`) plus
  `embedding_error_message` gives a persistent, queryable per-post audit trail
  of embedding outcomes, independent of the HTTP response that triggered them.
- `record_clustering_run_input` rejects duplicate/conflicting input instead of
  silently ignoring it (`ON CONFLICT DO NOTHING` was removed).

## Local verification (all performed before cloud rollout)

- Deno offline test suites: **64 steps, 0 failures** (anonymize-worker +
  cluster + fixtures, scripted OpenAI/embedding dependencies, no real calls).
- `scripts/verify_phase4.sql` with `ON_ERROR_STOP=1`: **exit 0**, all
  sections A–I, including the 6 focused integrity proofs (model isolation,
  pairing constraint, duplicate-input rejection, partial-failure persistence,
  failed-input cluster-assignment rejection).
- `deno check`: clean across all Edge Functions and test suites.
- Frontend `tsc -b --noEmit` and `npm run build`: both clean.
- Browser verification: the `/clusters` page's run-failure indicator (failed
  input count, affected post(s), stored error message) rendered correctly
  against real seeded local data in both collapsed and expanded states, zero
  console errors.

## Cloud rollout — no-op smoke results

Schema push and function deploys only; no data-producing calls were made.

- `anonymize-worker` invoked once against the (confirmed) empty queue:
  `jobs_read=0`, zero jobs of any outcome, zero OpenAI calls (the OpenAI
  branch is structurally unreachable when nothing was read from the queue).
- `cluster` invoked once for a date window (`2020-01-01`–`2020-01-02`)
  outside the data's actual range: `eligible=0`, `run_id=null`, zero OpenAI
  calls (the embedding/label branches are structurally unreachable with zero
  eligible posts).
- Post-smoke check confirmed every Phase 4 table
  (`anonymize_job_state`, `anonymize_results`, `anonymize_dead_letter`,
  `clustering_runs`, `post_embeddings`, `clusters`, `cluster_assignments`)
  and the `anonymize_jobs` pgmq queue remained at **0 rows/messages**.

**No real-data backfill and no real Phase 4 OpenAI execution has occurred.**
`backfill_anonymize_jobs` has never been called against cloud. No post has
been anonymised, embedded, or clustered by the new pipeline.

## Deliberately deferred

Real-content validation — running `anonymize-worker` and `cluster` against a
small representative set of actual scored posts, with real OpenAI calls — is
intentionally deferred to the **first controlled execution**, not bundled
into this closure. This keeps Phase 4's closure state (schema + code +
offline tests + cloud no-op smoke checks, all passing) decoupled from the
one-time cost/inspection event of real LLM output.

The first real execution should remain bounded and **stop** on any of:

- an anonymisation leak (a company name or other entity that should have been
  replaced is still present in `anonymized_posts_current.anonymized_text`);
- a `dead_letter` outcome on any `anonymize_job_state` row;
- total embedding failure for a clustering run (`status='failed'` on
  `clustering_runs`, i.e. every eligible post's embedding call failed);
- incoherent cluster output (e.g. everything collapsing into one bucket, or
  clusters that are obviously not thematically related on manual read).

**No more Phase 4 development is planned** unless that first execution
reveals a concrete issue. Phase 4 is closed as a body of work; Phase 5 may
proceed in parallel with, or ahead of, the deferred validation.

## Security note

`INGEST_INTERNAL_SECRET` was exposed in chat/command history during the
cloud-rollout preflight session and has since been **rotated** (new value set
via `supabase secrets set`, verified working against `anonymize-worker`'s
empty-queue path). The old value is no longer valid. See
`docs/SESSION_HANDOFF.md` for the rotation record (no values recorded there
either).
