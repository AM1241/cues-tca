# Phase 4 requirements — anonymise & cluster

Confirmed with the user on 2026-07-24, starting from `origin/phase3c-circuit-break`
(handoff commit `e34d2a2b77eeaef7db781ea50e6d9a67991bc0dc`). This document is the
spec MIGRATION_PLAN.md's existing Phase 4 sketch was missing — read it before
touching that section or writing code. It narrows, and in places overrides, the
sketch.

## Scope boundary

Phase 4 makes anonymisation and clustering operational and inspectable. It does
**not** build the review/approve state machine, an editing workflow, or the
`generate` Edge Function — those stay Phase 5/7. The frontend surface for Phase 4
is a minimal inspection view, not production UX.

## 1. Anonymisation

- **Two-layer replacement**, both required:
  1. Deterministic replacement ported from legacy `anonymization_service.py`
     close to verbatim — source-name matching, the public-body preservation
     list, percentage/large-number bucketing, the `replacements` audit array.
  2. New LLM entity-extraction pass to catch companies named in post body text
     that don't match the source name (the known legacy gap — see
     `docs/legacy-system.md` §3). Runs before or alongside the deterministic
     pass; its findings feed the same replacement map and the same
     `replacements` audit trail.
- **Failure mode: fail loud, no silent fallback** (same principle as `generate`
  in CLAUDE.md).
  - If the entity-extraction LLM call fails for a post, that post is **not**
    written as a successful `anonymized_posts_current` row and the current
    pointer is not advanced.
  - The job/attempt is marked failed or retryable; error type/message and
    failing stage are stored.
  - The original post and any deterministic intermediate findings are
    preserved.
  - No partial/deterministic-only text is ever written under a "success"
    status. A deterministic-only provenance mode may be added later, but only
    as an explicit, separately-approved mode — never an automatic hidden
    fallback.
  - Retries are idempotent. One post's failure does not block or fail sibling
    posts in the same batch.
  - Failures are visible in the inspection UI, not just in logs.

## 2. Job architecture (anonymise)

Reuse the Phase 3 `score-worker` architecture — it already solves the same
shape of problem (one external LLM call per post, durable retries, wall-clock
limits). Do not invent a new framework or repeat Phase 3's full hardening
exercise; reuse its established contracts and add only anonymisation-specific
tests and failure handling.

- Separate anonymisation queue and job-state tables (own pgmq queue, own
  `*_job_state` / dead-letter tables — mirrors `scoring_jobs` /
  `scoring_job_state`, not shared with scoring).
- One job enqueued per eligible post.
- An on-demand worker (`anonymize-worker` or similar) drains in small batches,
  triggered by a button / internal-secret path — **no cron, no automatic
  background scheduling**, consistent with the rest of the product.
- Per-post fail/retry without aborting the batch; `anonymized_posts_current`
  only advances after a fully successful result for that post.
- Results are immutable/append-only where Phase 3 established that pattern
  (e.g. an audit/history table), consistent with `scoring_results`.

## 3. Clustering

- **Mechanism**: pgvector + OpenAI embeddings (reuses the existing
  `OPENAI_API_KEY` secret). Real similarity clustering, not the legacy
  score-bucket heuristic.
- **Execution model**: recompute-all per run. No incremental centroid
  assignment, no merge/split logic, no cross-run stable cluster IDs in this
  phase. Simplest mental model; matches the on-demand philosophy already used
  for ingest/score.
  - This is an explicit trade-off: cluster IDs and labels **may change between
    runs**. Review/Generate must reference `clustering_run_id` + `cluster_id`
    together, never a bare `cluster_id` as if it were stable over time.
  - Stable incremental clustering is deferred — revisit only if the editorial
    workflow proves cross-run continuity is genuinely needed.
- **Input scope**: caller-specified `period_start`/`period_end` (same shape as
  `generation_requests`), filtered to posts that:
  - have a successful current anonymised result in `anonymized_posts_current`;
  - meet `configurations.min_relevance_score` (or the run's snapshotted
    value — see below);
  - fall inside the requested window;
  - are not already excluded/invalidated.
  - No default "cluster everything ever anonymised" mode. A clustering run
    represents one editorial batch, matching how `generate` will eventually
    consume it.
- **Reproducibility**: every execution creates an immutable clustering-run
  record storing: embedding model, clustering parameters (similarity
  threshold, min cluster size) as used at run time, the exact input post IDs,
  the requested period, and a timestamp. The input set must stay reconstructable
  even if `anonymized_posts_current` changes later.
- **Coherence bar**: a run must not collapse into a single meaningless fallback
  cluster (the failure mode of the legacy heuristic). Verified by spot-checking
  real data during acceptance, not by an automated semantic-quality test.
- **Config knobs — new `configurations` columns** (migration required):
  - `cluster_similarity_threshold`
  - `min_cluster_size`
  - Conservative defaults, range-validated at the DB level. Keep this minimal —
    Phase 4 is not building a general clustering-configuration platform. Every
    clustering run snapshots the effective values it used into its own run
    record, so later edits to `configurations` never retroactively change the
    meaning of a past run.
  - No frontend editing UI required for these in Phase 4 unless it falls out
    naturally from the existing Objective/config screen.

## 4. Test coverage

Small, focused Deno offline suite for the new anonymise/cluster functionality —
required, but **not** the acceptance gate, and explicitly not a repeat of Phase
3's extensive hardening. Cover only:

- auth and invalid-request handling;
- deterministic anonymisation fixtures;
- replacement/audit-trail integrity;
- preservation of source traceability;
- idempotent reruns;
- explicit failure behavior when anonymisation can't complete safely;
- clustering input/output schema;
- avoidance of the single fallback-cluster collapse;
- stable handling of empty or too-small input sets.

No specific step-count or coverage-percentage target.

## 5. Acceptance criteria ("Phase 4 done")

1. **Anonymise deployed and verified on real data.** `anonymize`
   Edge Function (+ worker) deployed to cloud, run against a representative
   subset of real posts (not necessarily all 133). `anonymized_posts_current`
   populated correctly; `replacements` audit trail spot-checked; failures
   behave per §1.
2. **Clustering verified semantically coherent.** Run against real anonymised
   posts for a real period; clusters read as coherent editorial groupings, no
   collapse into one fallback bucket.
3. **Minimal frontend inspection surface**, showing at minimum:
   - the original post;
   - the anonymised/generalised output;
   - the assigned cluster (with its `clustering_run_id`);
   - source and replacement traceability.
   - Lightweight/unpolished is fine. No approve/reject state machine, no
     editing workflow, no generation UI — those are out of scope here.
4. Baseline offline test suite (§4) exists and passes; not gated on a specific
   size.

## Explicitly out of scope for Phase 4

- `generate` Edge Function (Phase 5).
- Review/approve workflow, editing, regeneration (Phase 7).
- Stable/incremental clustering across runs.
- A general-purpose clustering-configuration platform beyond the two knobs
  above.
- Cron or any unattended scheduling for anonymise or cluster.
- Deterministic-only anonymisation as an automatic fallback (may exist later
  as an explicit opt-in mode, not as part of this phase).
