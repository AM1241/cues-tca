# Handoff for the next session

**Written:** 2026-09-15 (updated same day, after a second verification session).

`docs/TCA_TRIAL_HANDOFF.md` is still the authoritative task list — read it in
full, its own status fields are now current. This note is just the pointer:
where the code actually is, what changed this session, and what's next.

## Where the code is

- Branch `frontend-design-system`, commit `603714a` — **committed, not
  pushed, not merged into `phase6-frontend-binding`.**
- Two real code commits landed this session, both on top of `f5deec3`
  (previous session's tip):
  - `61fb237` — CAR-02 fix (removed fabricated per-tier image-generation
    timings from the quality dropdown) + FLD-01 (one-line hints on
    Title/Caption/CTA explaining what's drawn on images vs. export-only).
  - `1f1ac54`, `603714a` — doc updates recording the above and the live
    verification results.
- `npm run build` (`tsc -b && vite build`) and `npm run lint` (`oxlint`) both
  pass clean.
- **Still nothing pushed or merged.** `frontend-design-system` has no remote
  tracking branch at all — everything here is local-only until someone
  pushes it.

## What happened this session

Picked up from the previous handoff's "Start here" list: A9 (CAR-02 review),
A10 (FLD-01 hints), then closed out CHK-01/02/03 by actually reaching the
Review editor — the thing every prior session had been blocked on.

1. **A9 — CAR-02 review.** Read `PublicationPanel.tsx`'s progress states
   against the requirement. The states themselves ("Redrawing for your
   edits…", "Drawing N of M…", per-slide "Generating…"/"Failed to draw") were
   already adequate. Found one real violation: the quality `<select>` showed
   "low — about 15s a slide" / "medium — about 60s a slide" — numbers that
   exist nowhere in this repo. The only timing note in `SESSION_HANDOFF.md`
   (session 20) is an un-tiered "15-60s" design rationale, not a measured
   per-quality figure. Fixed to relative wording only ("fastest" /
   `medium` / "slowest").
2. **A10 — FLD-01.** Added a one-line hint under each of Title/Caption/CTA in
   the "Post text" section of `PublicationPanel.tsx`, straight from the
   table FLD-01 had already worked out (drawn on images vs. export-only).
   Confirmed `CarouselOutputEditor` in `generation.tsx` has zero call sites —
   no second editor surface needed the same fix.
3. **Reached the Review editor, against production, without spending on new
   API calls.** Production already had 28 generation results / 55 reviews
   sitting there from prior sessions, including one carousel
   (`55cab6c5-500d-4b69-9f5c-634122590cd1`) that already had a genuine prior
   edit baked in ("The shared story" → "The shared full story"). Used that
   instead of fabricating rows or running a live pipeline:
   - No project `/run` skill existed for this repo; `chromium-cli` wasn't
     installed. Used the Playwright SDK fallback: `npx playwright install
     chromium` (matching version, ~300MB, already partly cached from a
     previous session) + a throwaway driver script per check, `.env.local`
     already pointed `npm run dev` at production.
   - Logged in as `hzafeiris@f-in.eu` (admin) — **not**
     `demo.editor@f-in.eu`, whose password wasn't available this session
     (one guess was tried and failed). CHK-01/02/03 don't depend on role, so
     this didn't block them; CHK-04 specifically needs the editor account
     and was **not** attempted.
   - **CHK-01:** edited a slide heading live, confirmed Save went
     disabled→enabled on change, saved, reloaded the page fully, reopened
     the same result — edit persisted. Reverted the test marker afterward
     with a second clean edit/save, confirmed via direct SQL read.
   - **CHK-02:** approved the result via the live Approve button (**stopped
     and got explicit user confirmation first** — auto-mode correctly
     flagged this as a shared-production-state change). Downloaded the
     bundled Markdown and DOCX exports, confirmed both contain the *edited*
     heading, not the original (grepped the `.md`, unzipped the `.docx` and
     grepped `word/document.xml`). Then opened Generate → the matching
     request and confirmed it shows the *original* heading — Generate/Export
     legitimately differing on the same item is now empirically shown, not
     just argued from code.
   - **CHK-03:** Design Template (free) variant, downloaded all 7 slides,
     confirmed each is exactly 1080×1080 via `file`, visually confirmed
     slide 1 (no footer, correct — title only appears from slide 2 on) and
     slide 4 (footer present, correct title), then ran all 7 through
     `tesseract` OCR grepping for `*` — **zero found on any slide**.
   - Stopped the local dev server afterward (`lsof -ti:5174 ... kill`).

## Start here, in order

1. **CHK-04 — plain-user permissions.** The one unclosed item in A11. Needs
   `demo.editor@f-in.eu`'s real password (ask Χάρης — do not guess further or
   reset it without asking first, per this session's own back-and-forth).
   Confirm: whole workflow runs as editor; lookback + enabled switch can be
   changed; add/rename/delete source refused; deleting generated copy
   refused. Session 21 verified this once already — this is a
   no-regression check, not new ground, and nothing touched this session
   affects permissions/RLS.
2. **D-2 (NAM-06)** is still the one open naming decision blocking Track A —
   labels for the review/download step. Ask Χάρης; not blocking anything
   else in the plan per §7's own ordering.
3. **A12 — deploy, then tell Theocharis what shipped.** Track A's code
   (`cc3dab0` naming/UI + `61fb237` CAR-02/FLD-01) is sitting on
   `frontend-design-system`, committed but **not pushed, not merged into
   `phase6-frontend-binding`, not deployed**. The live bundle on
   cues-tca.netlify.app is still whatever `phase6-frontend-binding` built
   last (hash recorded in §0.1 of `TCA_TRIAL_HANDOFF.md` — re-check it, it
   may be stale by now). This is a real decision point, not just a git
   command — confirm with Χάρης before merging/pushing/deploying, since nothing
   in this branch has been merged upstream yet and Χάρης said he'd been
   making changes of his own that weren't all reported.
4. **A13 — create the TechnoAlimenti account and send it with the guide.**
   Explicitly sequenced *after* A12 per DOC-01: code ships → Χάρης tells
   Theocharis what's in the release → Theocharis adapts the guide → account +
   guide go out together. Don't create this account before A12, even though
   it's tempting to just get it done — jumping this order was asked about
   directly last session and the answer was: not yet, precisely because of
   this sequencing.
5. FLOW-01 stays out of Track A, per the earlier D-5 answer (deferred to
   Track B).

## Still open / TODO

Everything else in `TCA_TRIAL_HANDOFF.md` §2 not touched this session:
DOC-01/02/04/05, ACC-01/03/04/05, FLOW-01, CAR-04. See the doc for evidence
and status per item — nothing should be treated as done from memory, and the
doc's own §0.2 reconciliation check should be re-run at the start of any new
session before trusting anything here.
