# Phase 5 kickoff

## Start here

- **Branch/commit:** start from `origin/phase5-generation` — created from the
  Phase 4 closure commit on `phase4-requirements` (documentation-only commit,
  message `docs: close Phase 4 and prepare Phase 5 handoff`), which is also
  tagged `phase4-complete`. `phase5-generation` contains no Phase 5
  implementation yet.

```bash
git fetch origin
git checkout -b phase5-<your-topic> origin/phase5-generation
```

A colleague starting an independent branch from the same stable base uses the
same command with a different topic suffix — both branches share the tagged
`phase4-complete` ancestor, so they cannot silently diverge on what "Phase 4
done" meant.

## Phase 4 cloud status (as of the handoff)

Phase 4 (anonymisation + reproducible clustering) is **implemented, deployed,
and smoke-verified**. Real-content validation (actually anonymising/embedding
real posts) is **intentionally deferred** to the first controlled execution —
this is a product decision, not a blocker, and Phase 5 work does not wait on
it.

- Cloud migration ledger: `0001`–`0015`.
- `anonymize-worker` and `cluster` Edge Functions deployed, `ACTIVE`,
  `verify_jwt=false`.
- All Phase 4 tables and the `anonymize_jobs` queue are empty on cloud — no
  post has been anonymised, embedded, or clustered yet.
- `INGEST_INTERNAL_SECRET` was rotated during Phase 4 closure (a prior value
  was exposed in chat/command history); the current value has not been
  exposed.

Full detail: `docs/PHASE4_COMPLETION.md` and `docs/SESSION_HANDOFF.md`. Don't
take this summary as a substitute for them — read the source docs before
making claims about Phase 4 state, and **do not repeat the Phase 4 audit**
(re-verifying migrations, re-running the offline suites, re-checking cloud
row counts) — that work is already done and recorded.

## Documents to read first, in order

1. `CLAUDE.md` — stack decisions, pipeline order, working conventions,
   secrets handling.
2. `docs/SESSION_HANDOFF.md` — the authoritative "where things stand" record.
3. `docs/PHASE4_COMPLETION.md` — exact Phase 4 closure state, what was and
   wasn't verified, and the deferred real-data-validation stop conditions.
4. `MIGRATION_PLAN.md` — Phase 5's own section (below the Phase 4 record) for
   the original architectural sketch of generation. Treat it as a starting
   sketch, not a spec — same caveat that applied to Phase 4's sketch before
   `PHASE4_REQUIREMENTS.md` superseded it.
5. `docs/editorial-brief.md` — the editorial objective and voice; directly
   relevant to any generation prompt.
6. `docs/legacy-system.md` — how the old FastAPI app generated posts and
   carousels (`generation_service.py` in the legacy repo) — the prompt
   builder and output formats there are, per `MIGRATION_PLAN.md`, "the best
   code in the legacy system" and worth porting closely. Read it for the
   *content/prompt* approach; do not assume its job-orchestration or storage
   pattern carries over unchanged — Phase 3/4 established a different,
   stricter convention (see below).
7. Read the existing `editorial_assets` / `traceability_link_posts` table
   definitions in `supabase/migrations/0001_schema.sql` before assuming
   Phase 5 needs new tables from scratch — they may already cover some of
   this, dating from before Phase 3/4's append-only/immutable-result pattern
   existed. Reconcile deliberately; don't silently duplicate or silently
   reuse without checking whether the existing shape still fits.

## Phase 5 goal (initial scope)

A generation layer that consumes **approved Phase 4 data structures** —
nothing upstream of `anonymized_posts_current` / `clustering_runs` /
`clusters` needs to change. Concretely, the initial implementation should
cover:

- Input selection: a caller-selected `clustering_run_id`, and one or more
  selected `cluster(s)` within that run.
- Exact traceability from generated output back through source → anonymised
  result → cluster assignment, mirroring the traceability discipline already
  established in `anonymize_results`/`post_embeddings`/`clustering_run_posts`
  (every generated asset should be able to answer "which raw posts, through
  which anonymisation and clustering steps, produced this").
- Configuration and prompt snapshots stored with the generation result — the
  same "immutable definition, not a live re-read of `configurations`"
  discipline used by `scoring_requests`/`clustering_runs`, so a later config
  edit cannot retroactively change what a past generation claims it used.
- Generation of editorial **post** and **carousel** drafts.
- Explicit failure behavior: **no silent canned fallback**. A failed
  generation call is a failed result, surfaced as such — matching the
  fail-loud convention already established in `anonymize-worker` (Stage 2
  LLM failures never complete under a success state) and `cluster` (a failed
  label call sets `label_failed=true` rather than fabricating a title).
- **Immutable generation results**, plus a **current projection** if the
  existing schema conventions call for one — check whether
  `editorial_assets` (from `0001`) already serves this role, or whether it
  needs to be replaced/extended with an append-only-results-plus-current-
  pointer pattern like `anonymize_results` → `anonymized_posts_current` and
  `scoring_results` → `analyzed_posts.current_result_id`. This is a real
  design decision, not a given — resolve it explicitly during requirements
  discussion, don't default silently either way.
- **On-demand execution only.** No cron, no automatic triggering — matches
  the deliberate on-demand philosophy already established for
  `backfill_anonymize_jobs` and the `cluster` function (see
  `supabase/migrations/0014_anonymize_schema.sql`'s header comment for the
  reasoning: auto-triggering starts paying for LLM calls before an operator
  asks for them).

**Explicitly out of initial scope:** the review/approve/edit/regenerate
workflow. `MIGRATION_PLAN.md`'s Phase 6/7 sketch already anticipates a
`Review` UI surface and a `generate` request/status flow — do not build that
here unless it is explicitly pulled into Phase 5 after requirements
discussion. The initial goal is generation itself (input → LLM call →
persisted, traceable result), not the editorial workflow around it.

## Open product decisions — resolve before writing code

None of the following have been decided. A fresh session must get explicit
answers (from the user, or from a more detailed design doc if one exists)
before implementing:

- **Generated output formats and schemas** — exact structure of a "post"
  draft and a "carousel" draft (title/body/hashtags/CTA fields, etc.).
- **One output per cluster vs. one output per run** — does a single
  `cluster` invocation's clustering run produce one generation call per
  selected cluster, or one call covering the whole run?
- **Post, carousel, or both** — is a single generation request expected to
  produce one format, or always both together?
- **Carousel slide count and structure** — how many slides, what each slide
  contains, any per-slide character/length limits.
- **Tone/length/CTA requirements** — sourced from `docs/editorial-brief.md`
  and/or the `configurations` row's `voice`/`themes` fields (confirm which),
  plus any length constraints (LinkedIn character limits, etc.).
- **Whether only successfully labeled clusters may generate** — a cluster
  with `label_failed=true` (see Phase 4's `clusters.label_failed` column) —
  does generation refuse to run on it, warn, or proceed with a fallback
  label?
- **Treatment of unclustered posts** — posts that `cluster`'s
  `groupBySimilarity` placed in the `unclustered` bucket (visible in the
  `cluster` response's `totals.unclustered`, not currently persisted as a
  pseudo-cluster) — are they ever eligible for generation, individually or
  otherwise?
- **Generation model** — which OpenAI model, and whether it's the same
  pinned-snapshot discipline used for scoring
  (`gpt-5.4-nano-2026-03-17`) and clustering-label calls, or a different
  choice suited to longer-form generation.
- **Acceptance criteria and minimal frontend surface** — what "Phase 5 done"
  means (mirroring how `PHASE4_REQUIREMENTS.md` defined Phase 4's acceptance
  criteria before implementation started), and what minimal UI (if any) is
  needed to trigger/inspect a generation call for Phase 5's own closure,
  separate from the explicitly-deferred full Review workflow.

**Do not implement Phase 5 until these product requirements and acceptance
criteria are approved.**

## Copy-paste prompt for a fresh Claude session

```
Continue in this repo on a new branch from origin/phase5-generation (tagged
ancestor: phase4-complete).

Read, in order: CLAUDE.md, docs/SESSION_HANDOFF.md, docs/PHASE4_COMPLETION.md,
docs/PHASE5_KICKOFF.md, MIGRATION_PLAN.md (Phase 5 section), docs/editorial-brief.md,
docs/legacy-system.md.

Phase 4 (anonymisation + reproducible clustering) is implemented, deployed, and
smoke-verified; real-content validation is intentionally deferred to the first
controlled execution, which is not a blocker for Phase 5. Do not re-audit or
re-verify Phase 4 — docs/PHASE4_COMPLETION.md and docs/SESSION_HANDOFF.md are
authoritative on its state.

Do not start implementing Phase 5 yet. First help me pin down the actual product
requirements for Phase 5 (output formats, one-per-cluster vs one-per-run, post vs
carousel vs both, slide structure, tone/length/CTA rules, whether only labeled
clusters can generate, treatment of unclustered posts, generation model,
acceptance criteria, and minimal frontend surface) — ask me whatever you need to
ask. The review/approve/edit/regenerate workflow is explicitly out of scope for
this initial pass unless I say otherwise.
```
