# Phase 6 — frontend binding, and the first real Phase 4 execution

**Date:** 2026-07-24
**Branch:** `phase6-frontend-binding` (pushed; branched from the `phase4-complete` tag)
**Commits:** `d8947fb`, `8981d11`, `607d348`

Two things happened in this session. The intended one was binding the remaining
pipeline stages to the UI. The unintended — and more important — one was that
doing so forced the first real Phase 4 execution, which found three defects that
no offline test could have caught.

## 1. Every stage is now driveable from the UI

`ingest` and `cluster` were already bound. `score-worker` and `anonymize-worker`
rejected every browser caller (`403`, internal secret only), which contradicted
`MIGRATION_PLAN.md`: *"every stage (ingest, score, drain) is triggered by a
button in the UI."*

Both workers now use the dual-auth path `_shared/auth.ts` already provided and
`cluster` already relied on — the internal secret, or an admin editor's verified
Bearer token. **The admin-only rule is unchanged**; this widens who may drain a
queue, not what a non-admin can do.

This turned out to be the same call the Phase 5 author made independently:
`generate` also calls `await authenticate(...)` with no `actor.kind` guard. The
convention across the codebase is now consistent.

| Stage | Function | UI trigger |
|---|---|---|
| ingest | `ingest` | Sources → "Collect now" (pre-existing) |
| score | `score-worker` | Posts → **"Score now"** (new) |
| anonymise | `anonymize-worker` | Clusters → **"Anonymise now"** (new) |
| cluster | `cluster` | Clusters → "Run clustering" (pre-existing) |

### `backfill_anonymize_jobs` stays privileged

That RPC is `service_role`-only by design (migration `0014`) and was **not**
granted to `authenticated`. Instead `anonymize-worker` accepts an opt-in
`backfill: true` flag and calls the RPC itself, behind its own auth gate. Off by
default, so an existing plain drain stays a pure drain.

### The batch is operator-set

`backfill_anonymize_jobs` would enqueue **51** posts, each one a real LLM call.
The first implementation hardcoded `batch_size: 25`. That is exactly the
unbounded first run `PHASE4_COMPLETION.md` warned against, so the batch is now
an operator-set 1–25 defaulting to **5**. Backfill still enqueues everything
eligible; the batch caps only how many are drained per click, and the queue
holds the rest between runs.

## 2. The first real Phase 4 execution

`PHASE4_COMPLETION.md` deferred real-content validation to "the first controlled
execution." This was it: **2 posts, 2 OpenAI calls**, seeded by SQL rather than
by backfill so the other 49 stayed untouched.

Mechanically it passed — `jobs_read=2, anonymized=2, dead_lettered=0`, and the
new editor auth path worked. The **output** was wrong in three ways. Both test
posts were from MASAF, the Italian agriculture ministry, and all three defects
are Italian-corpus defects invisible to the English-language offline fixtures.

### Defect 1 — public bodies anonymised despite `keep_public_bodies=true`

> "i Carabinieri per la Tutela Agroalimentare di Parma e del personale AUSL"
> → "**another food-sector organization** di Parma e del personale **another food-sector organization**"

The exemption only ever covered the post's *own source name*. For bodies named
inside the text, the only guard was a sentence in the extraction prompt — and
the model returned them anyway. Two distinct institutions also collapsed to an
identical placeholder.

**A prompt instruction is not an enforcement point.** The flag is now re-checked
against the model's output, and `isPublicBody` gained a pattern list, since the
exact-match list held only English/EU names and never fired on Italian
institutions.

### Defect 2 — years bucketed as magnitudes

> "tra il 2021 e il 2025 … Controlli 2026" → "tra il **2000-3000** e il **2000-3000** … Controlli **2000-3000**"

`/\b(\d{4,})\b/` treated every four-digit number as a quantity. Years 1900–2099
are now exempt.

### Defect 3 — European decimals corrupted

> "+25,7%" → "+**25,0-10%**"

`bucketPercentages` only understood `.` decimals, so on `25,7%` it matched the
fraction alone. It now accepts both separators, with a lookbehind so a match
cannot begin mid-number.

### Verification of the fixes

Deployed, then **re-ran the same two posts**. Live output now preserves
Carabinieri, AUSL and all three years, and renders `+20-30%` / `+90-100%`.

`supabase/functions/anonymize-worker/__tests__/deterministic_test.ts` covers
every case offline. **Caveat:** `deno` is not installed on the machine this was
written on, so the suite was never run as a Deno test. Each assertion was
instead executed directly against the real module via Node type-stripping
(15/15 pass). **Run `deno test` before merging.** The pre-existing 64-step
suites were likewise not re-run here.

## 3. Cloud state (verified 2026-07-24, end of session)

- **Migrations:** `0001`–`0016`, local == remote. `0016` was applied by the
  Phase 5 author during this session.
- **Functions:** `ingest` v8, `score-worker` v7, `anonymize-worker` **v5**,
  `cluster` v3, `generate` v1 — all `ACTIVE`.
- **Data:** `raw_posts` 180 · `analyzed_posts` 133 · `anonymized_posts_current` 30
  · `editorial_assets` 15 (legacy) · `clustering_runs` 0 · `clusters` 0.
- The 2 test posts hold corrected text. Their earlier bad results remain in
  `anonymize_results` as superseded history — the append-only design working as
  intended, not leftover garbage.
- The other 49 eligible posts have never been anonymised.

## How we proceed

Roughly in order.

1. **Run `deno test`** on a machine that has Deno, then merge
   `phase6-frontend-binding`. Expect a trivial `config.toml` conflict with
   `phase5-generation` (adjacent additions).
2. **Deploy `score-worker`.** Deliberately *not* done here: cloud `v7` was
   deployed from a `cues-editorial-cloud-colleague-review` checkout on another
   machine, and it could not be diffed against this repo. Confirm with its
   author that `v7` matches `main` before overwriting. **Until this ships,
   "Score now" returns 403.**
3. **Widen the anonymise run gradually** — batch of 5, read the output, repeat.
   The stop conditions in `PHASE4_COMPLETION.md` still apply, and this session
   is evidence they are worth honouring. Watch particularly for company names
   that survive (a real leak — the opposite failure from the three above) and
   for public bodies wrongly *preserved* by the new pattern list.
4. **Decide on the 30 legacy `anonymized_posts_current` rows.** All have
   `current_result_id IS NULL`, so the backfill treats them as never
   anonymised and will redo them. That is probably desirable — they gain real,
   traceable `anonymize_results` — but it is a decision, not a default.
5. **Re-enqueue the 47 unscored `raw_posts`.** They have no `analyzed_posts` row
   and the scoring queue is empty, so "Score now" will report an empty queue and
   do nothing for them. They need the `0005` enqueue path.
6. **Bind the Generate route.** `docs/PHASE5_FRONTEND_HANDOFF.md` was written
   for exactly this and has not been read yet. `/generate` is still a
   `Placeholder`.

## Security note

`frontend/.env.local` holds `SUPABASE_ACCESS_TOKEN` (a personal access token
with full management-API control) and `SUPABASE_DB_PASSWORD`, alongside the
`VITE_` variables.

Verified: the file is covered by `*.local` in `frontend/.gitignore`, has never
been committed on any branch, and neither secret appears in `frontend/dist/` —
Vite only bundles `VITE_`-prefixed variables.

It is still the wrong place for them. Renaming either to `VITE_*` would ship it
in a public bundle, and `CLAUDE.md` is explicit that only the anon key and
project URL may reach the frontend. Move both to the shell environment or
`~/.config/supabase`. **Both values were used during this session, so rotating
the PAT is the safe call.**

A `service_role` key and a short-lived admin session were also minted during the
test (via the Auth admin API — no password was changed and no mail was sent).
Both were shredded; the session expires within the hour.
