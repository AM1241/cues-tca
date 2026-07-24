# Phase 4 kickoff

## Start here

- **Branch/commit:** start from `origin/phase3c-circuit-break` — canonical handoff
  commit `e34d2a2b77eeaef7db781ea50e6d9a67991bc0dc` (this is the branch HEAD, including
  the finalized documentation) — or a later commit on `main` once that branch's PR has
  been merged. Do not start from `origin/phase-3-score-worker`,
  `origin/phase3c-reconciliation`, or `phase3c-test-foundation` — superseded
  intermediate branches that don't contain the circuit-break/lock-order fixes.
- **Deployed Phase 3 application-code commit:** `e1652c58df1ce5307ef1a131056991a3f46d4047`
  — this is the commit that was actually applied to cloud (migrations 0011–0013,
  `score-worker` redeploy) and validated by the smoke test. It is an ancestor of the
  handoff commit above (only documentation changed since); it is not the branch HEAD.

```bash
git fetch origin
git checkout -b phase4-<your-topic> origin/phase3c-circuit-break
```

## Phase 3 cloud status (as of the handoff)

Phase 3 core functionality is complete and deployed:

- Cloud migration ledger: `0001`–`0013`.
- `score-worker` Edge Function deployed and hardened (request-wide circuit-break,
  request-first lock ordering across enqueue/complete/fail).
- Verified: Deno suite (32 steps), seedless SQL assertions, real two-session RPC
  concurrency probes, and a controlled real-OpenAI cloud smoke test — all passed.
- Nothing production-scored yet: 0 production scoring requests, 0 rows promoted via
  `set_current_scoring_result`. Only evaluation requests have been used so far.
- No cron, no backfill enabled.

Full detail: `docs/SESSION_HANDOFF.md`. Don't take this summary as a substitute for it —
read the source doc before making claims about Phase 3 state.

## Documents to read first, in order

1. `CLAUDE.md` — stack decisions, pipeline order, working conventions, secrets handling.
2. `docs/SESSION_HANDOFF.md` — the authoritative "where things stand" record.
3. `MIGRATION_PLAN.md` — Phase 4's own section (below the Phase 3 record) for the
   original architectural sketch of anonymise/cluster. Treat it as a starting sketch,
   not a spec — see below.
4. `docs/legacy-system.md` — how the old FastAPI app did anonymisation and clustering,
   including bugs and dead code not to carry over.
5. `docs/editorial-brief.md` — the editorial objective and voice, relevant to anything
   that touches theme/cluster labeling.

## Known non-blocking follow-ups (not Phase 4's job to fix, just be aware)

- Strict 133-row legacy regression hasn't been re-run against the current scoring code
  (needs a legacy seed not present on every machine). Scoring/circuit-break changes don't
  touch `ingest` or the legacy data path.
- No sample-rubric evaluation of scoring quality has been done at scale; the pinned model
  (`gpt-5.4-nano-2026-03-17`) may still be revised by that review later. Don't assume
  scores in `scoring_results` are final/production-quality — treat them as evaluation
  output until a production scoring request exists.
- Credential rotation was explicitly deferred by the user in the prior session.

## Instructions for whoever (or whatever) picks this up

- **Do not repeat the Phase 3 audit.** The documentation state above has already been
  verified this session — re-confirming migration ledgers, re-running the concurrency
  probes, or re-auditing `docs/*.md` files for Phase 3 accuracy is not Phase 4 work.
  Trust the handoff doc; if something in it looks wrong, say so and ask, don't silently
  re-derive it from scratch.
- **Identify or ask for Phase 4 product requirements before implementing anything.**
  `MIGRATION_PLAN.md`'s Phase 4 section is an early architectural sketch (pgvector
  clustering, an `anonymize` Edge Function) written before Phase 3 existed in its current
  form. It is not a confirmed spec, and this document makes **no assumptions about what
  Phase 4 actually contains** — anonymisation strategy, clustering approach, what "done"
  looks like, and how it fits the editorial workflow are open questions. Get them
  answered (from the user, or from a more detailed design doc if one exists) before
  writing code.

## Copy-paste prompt for a fresh Claude session

```
Continue in ../cues-editorial-cloud-colleague-review (or wherever this repo is
checked out) on a new branch from origin/phase3c-circuit-break.

Read, in order: CLAUDE.md, docs/SESSION_HANDOFF.md, docs/PHASE4_KICKOFF.md,
MIGRATION_PLAN.md (Phase 4 section), docs/legacy-system.md, docs/editorial-brief.md.

Phase 3 (ingest, scoring, circuit-break hardening) is complete. The deployed
application-code commit is e1652c58df1ce5307ef1a131056991a3f46d4047 (applied to cloud);
the branch HEAD / canonical handoff commit is e34d2a2b77eeaef7db781ea50e6d9a67991bc0dc
(adds only finalized documentation on top). Do not re-audit or re-verify Phase 3;
docs/SESSION_HANDOFF.md is authoritative on its state.

Do not start implementing Phase 4 yet. First help me pin down the actual product
requirements for Phase 4 (anonymisation approach, clustering approach, what counts as
done) — ask me whatever you need to ask. MIGRATION_PLAN.md's existing Phase 4 section
is an early sketch, not a confirmed spec.
```
