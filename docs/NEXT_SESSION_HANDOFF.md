# Handoff for the next session

**Written:** 2026-09-15 (third session — A12 deploy + CHK-04 verification).
**Audience:** whoever continues this next, including a non-Claude agent
(DeepSeek) picking up the one remaining Track A item. Read this in full
before touching anything.

`docs/TCA_TRIAL_HANDOFF.md` is still the authoritative task list — read it in
full, its own status fields are current as of this session. This note is the
pointer: where the code actually is, what changed this session, and exactly
what to do next.

## Where the code is

- Branches `frontend-design-system` and `phase6-frontend-binding` are now
  **in sync** (both at commit `04e0449`) and **both pushed to `origin`**.
  `phase6-frontend-binding` is what Netlify's Git-connected build deploys
  from.
- `04e0449` is a doc-only commit on top of `cd2b61f` (the ACC-04 consumption-
  attribution work from earlier this session, evaluated and committed
  first — see `docs/TCA_TRIAL_HANDOFF.md`'s own history for that).
- `npm run build` (`tsc -b && vite build`) passes clean as of `04e0449`.

## What happened this session

1. **Evaluated uncommitted ACC-04 work** (consumption attribution — a
   migration plus threading the caller through 6 Edge Functions) that was
   sitting in the working tree from a prior DeepSeek session. Verified it
   against the runtime (`supabase db reset` applied clean through the full
   migration chain) and had a background review check RLS exposure and
   function-grant history across every prior migration touching the same
   tables. Held up: correct wiring, exhaustive actor handling, no grant
   widening, no overload collisions. Committed as `cd2b61f`.
2. **A12 — deployed.** Merged `frontend-design-system` into
   `phase6-frontend-binding` (clean fast-forward, no conflicts — the former
   already contained everything from the latter), pushed both. Netlify's
   connected build picked it up automatically. Confirmed live:
   cues-tca.netlify.app now serves bundle `index-7Ix5u0wk.js` (previously
   `index-BJ5_C7wK.js`), page and both new assets return HTTP 200.
3. **CHK-04 — verified at the database layer**, since
   `demo.editor@f-in.eu`'s real password still wasn't available. Instead of
   waiting on it, created a throwaway `role='editor'` account in the
   **local** Postgres only, and exercised the five permission checks
   directly against RLS/triggers/admin functions by impersonating its JWT
   (`set_config('request.jwt.claims', ...)` + `set local role
   authenticated` — the same mechanism PostgREST itself uses, so this reads
   the actual policies, not a proxy for them). All five held: editor can
   change `lookback_days`/`enabled`; cannot rename/add/delete a source;
   cannot delete generated copy. All throwaway rows were deleted afterward;
   production was never touched. Full detail and exact error messages are
   in `docs/TCA_TRIAL_HANDOFF.md` under CHK-04's own status line — read that,
   not just this summary, if you need to reproduce or extend it.
   - This confirms the *mechanism* is intact. It does not confirm the
     deployed frontend surfaces these refusals cleanly to a real editor
     (readable error vs. raw exception) — a real UI pass with
     `demo.editor@f-in.eu` is still worth doing eventually, but no longer
     blocks anything.

## Start here — this is the task for the next session

**D-2 / NAM-06 is the only open item left in Track A.** Everything else —
A1 through A12 — is implemented, verified, and deployed. A13 (create and
send TechnoAlimenti's account) is explicitly **Responsible: Χάρης** per
`docs/TCA_TRIAL_HANDOFF.md` §2.5 ACC-01 — it is not a developer task, and it
is sequenced after A12 per DOC-01 (code ships → Χάρης tells Theocharis what
shipped → guide gets adapted → account + guide go out together). **Do not
attempt A13.**

D-2/NAM-06 is a wording decision: the tab label and panel heading for the
review-and-download step, where the user sees and downloads the generated
carousel/post. Read `docs/TCA_TRIAL_HANDOFF.md` §2.1 NAM-06 (search for
"NAM-06") and §6 D-2 (search for "| D-2 |") in full before starting — this
handoff summarizes, that doc is authoritative.

Key facts already established, don't re-derive:

- The doc gives **"Review and Download" and "Carousel Download" as EXAMPLES
  ONLY**, explicitly not final labels. Do not treat them as the answer or
  as a safe default.
- The underlying interface (CAR-01) is already done — the relevant code is
  `frontend/src/components/PublicationPanel.tsx` (renamed from
  `SlideDownload.tsx` in commit `5523b58`) and whichever route renders its
  tab (check `frontend/src/routes/`). Find the exact current tab label and
  panel heading strings before proposing alternatives — don't guess what's
  live.
- The wording decision belongs to Χάρης, not to whoever implements this.
  **Do not pick one and ship it.**
- Keep new labels consistent with this project's already-settled vocabulary
  register: D-1 settled "Topics" for the clustering step (see NAM-05) —
  match that same plain-user tone, not jargon.

### What to produce

1. **2–3 concrete label options** (a tab-label + panel-heading pair for
   each), each with a one-line rationale grounded in the project's own
   stated vocabulary decisions. Write these into
   `docs/TCA_TRIAL_HANDOFF.md` under NAM-06/D-2, following the doc's
   existing status-line style (§0.3: **Implemented** / **Verified** / **In
   the tester's build** are different things — this item is none of them
   yet, so its status line should say "options drafted, decision pending,"
   not jump ahead).
2. **A ready-to-apply code change per option** — small diffs/patches (or
   separate throwaway branches/commits, whichever is cleaner to hand off)
   that swap in each option's exact strings, so whichever Χάρης picks can be
   applied with zero further engineering judgment. `npm run build` must
   pass clean for every option's diff, not just the one you'd personally
   pick.
3. Do not touch A13/ACC-01, and do not touch `supabase/migrations/` — this
   is frontend copy only. If a migration starts to seem necessary, stop:
   that means you've misread the task.

### Before starting

Run the reconciliation check in `docs/TCA_TRIAL_HANDOFF.md` §0.2:
`git fetch --all`, check every branch (not only
`phase6-frontend-binding`/`frontend-design-system`) for undocumented work,
and compare the deployed bundle hash against a local build. Χάρης has said
before that he sometimes makes changes without reporting them here — verify
before trusting this handoff's "where things stand" as still accurate.

### Report back

A short summary of the options drafted and exactly where the corresponding
diffs/commits/branches live, so the next session — or Χάρης directly — can
pick one and apply it without re-deriving anything. This session will read
that report and evaluate the work before it's merged, the same way this
session evaluated the prior ACC-04 work.

## Still open / not this session's job

Everything else in `TCA_TRIAL_HANDOFF.md` §7 Track B and Track C: FLOW-01,
DOC-04/05, ACC-03, ACC-05, and the deferred ideas in §4. None of it blocks
Track A and none of it should be picked up instead of D-2/NAM-06 without
being asked.
