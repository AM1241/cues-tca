# Handoff for the next session

**Written:** 2026-09-15 (fourth session — D-2/NAM-06 closed and verified live).
**Audience:** whoever continues this next, including a non-Claude agent
(DeepSeek) picking up Track B. Read this in full before touching anything.

`docs/TCA_TRIAL_HANDOFF.md` is still the authoritative task list — read it in
full, its own status fields are current as of this session. This note is the
pointer: where the code actually is, what changed this session, and exactly
what to do next.

## Where the code is

- `phase6-frontend-binding` is at `72eaa16`, pushed to `origin`. This is what
  Netlify's Git-connected build deploys from.
- `frontend-design-system` was already in sync with `phase6-frontend-binding`
  as of the prior session (both at `04e0449` then); this session only added
  commits to `phase6-frontend-binding` on top. Reconcile the two branches
  before starting (see §0.2 in the trial doc) rather than assuming they're
  still aligned.
- `npm run build` (`tsc -b && vite build`) passes clean as of `72eaa16`.

## What happened this session

**D-2/NAM-06 — closed.** Χάρης picked **Option B** (`Review & Approve` tab
label, `Your carousel, ready to download` panel heading) from the three
options a prior DeepSeek session drafted. Applied by cherry-picking
`008653b` onto `phase6-frontend-binding` (`b05e9fc`), pushed, and verified
**live** with Playwright, logged in as `hzafeiris@f-in.eu` on
`cues-tca.netlify.app`:
- Nav tab and page `<h1>` both read "Review & Approve".
- Panel heading on a selected carousel item reads "Your carousel, ready to
  download".
- No console or page errors during login or navigation.

The two unused option branches (`nam06-option-a-review-download`,
`nam06-option-c-preview-download`) were deleted — their only content was the
same 2–3 line label diff, already fully reviewed before deletion.

**This closes Track A.** A1 through A12 were already done coming into this
session; A2/A4/NAM-06 were the only open piece, and they're done now. **A13
(create and send TechnoAlimenti's account) is explicitly Χάρης's own action,
not a developer task — do not attempt it, this session didn't either.**

## Start here — this is the task for the next session

**Track A is fully closed. The next work is Track B**, per
`docs/TCA_TRIAL_HANDOFF.md` §7 "Track B — during and after the trial". Read
that table in full; it lists five items. Not all of them are developer work
— read each one's own section in §2 before starting, since some are
"organisational pending" (nothing to implement) and some need a decision
from Χάρης before any code is written.

Recommended order, grounded in what's actually actionable without waiting on
someone else's decision:

### 1. FLOW-01 — write the proposal, do not implement it

Read `docs/TCA_TRIAL_HANDOFF.md` §2.3 FLOW-01 in full (search for
"FLOW-01"). Status is **TODO — proposal first**. A draft direction already
exists in the doc (remove the Generate tab from navigation, surface
generation history as a disclosure on Clusters, link a Review item back to
its request) but it is explicitly **not agreed** — the doc's own words:
"Design proposal (not agreed)".

- **What to produce:** a concrete, written proposal — exact new navigation,
  exactly what moves where, and an explicit checklist showing FLOW-03's
  required capabilities (content generation, editing, saving changes, human
  approval) are preserved. Write it into `docs/TCA_TRIAL_HANDOFF.md` under
  FLOW-01, replacing the "not agreed" draft with your own reasoned version
  (or refining it, if you agree with it — say why).
- **Do not implement the navigation change.** This needs Χάρης's approval
  first (§0.4 Scope and FLOW-01's own "Responsible" line: "developer
  proposes; Χάρης approves; then implement"). Writing code before that
  approval is the same mistake as picking a NAM-06 label yourself — don't
  repeat it in a different form.
- **Do not touch `Generate.tsx` or navigation code this session.**

### 2. DOC-05 — low priority, safe to scope but not urgent

Read §2.6 DOC-05. Status is **TODO, low priority** — the carousel prompt in
`supabase/functions/generate/` asks the model for markdown emphasis the
renderer can't draw, and CAR-03 already strips it at render time so nothing
user-visible is broken. If there's time after FLOW-01's proposal, look at
whether the prompt can stop requesting it — but this is optional this
session, not required.

### 3. Everything else in Track B is not a developer task right now

- **DOC-04** — already drafted in `docs/flow-guide-draft.md` (previous
  session). Nothing further needed from a developer; it's Theocharis's turn
  to adapt/translate it into the guide.
- **ACC-04** — already investigated and implemented (migration `0029` +
  function threading, committed `cd2b61f`). Closed from the developer side;
  §2.5 ACC-04 has the full written record if anyone asks what's covered.
- **ACC-03** — **organisational pending.** No dates or consumption limit
  have been agreed. Do not implement any limit or expiry as though a number
  had been decided — that is explicitly the mistake the doc warns against.
- **"Collect the trial feedback"** — not yet applicable; there's no trial
  running yet (A13 hasn't happened). Nothing to do here until TechnoAlimenti
  actually has the account and has used it.

### Before starting

Run the reconciliation check in `docs/TCA_TRIAL_HANDOFF.md` §0.2: `git fetch
--all`, check every branch (not only `phase6-frontend-binding`/
`frontend-design-system`) for undocumented work, and compare the deployed
bundle hash against a local build. This project's own history shows changes
sometimes happen without being recorded here — verify before trusting this
handoff's "where things stand" as still accurate.

### Report back

A short summary of the FLOW-01 proposal (or a note that it wasn't reached),
written into `docs/TCA_TRIAL_HANDOFF.md` itself, not just in a session log —
so the next session, or Χάρης directly, can read one document and know
whether the proposal is ready for his approval.

## Still open / not this session's job

- **A13 (ACC-01)** — Χάρης's action, sequenced after the guide is adapted.
  Not a developer task at any point in Track B.
- Anything in `docs/TCA_TRIAL_HANDOFF.md` §4 "Deferred ideas — not for
  implementation now" and §7 Track C. None of it should be picked up instead
  of Track B without being asked.
