# Handoff for the next session

**Written:** 2026-09-15.

Χάρης's colleague pushed `docs/TCA_TRIAL_HANDOFF.md` to
`phase6-frontend-binding` (commit `162f80f`) — **that file is now the
authoritative task list.** Read it in full before doing anything else. This
note is just the pointer and the gist, so a session that starts here knows
where to go and what the first move is.

## What that file is

A consolidated requirements/plan doc for a real client trial: TechnoAlimenti
(via Theocharis Moisis) reviewed CUES-TCA as an ordinary user, and the doc
merges that feedback with newer agreements from a follow-up meeting, under
stable task IDs (`NAM-*` naming, `UI-*` simplification, `CAR-*`
carousel/images, `FLOW-*` navigation, `ACC-*` trial access, `DOC-*` guide).
Each task states required behavior, status/evidence, dependencies, who's
responsible, and completion criteria.

## Start here, in order

1. **§0.2 "Reconciliation check" — do this first, always.** The doc says
   Χάρης has begun changes he hasn't fully reported. Before touching any
   task: `git fetch --all`, diff every branch against `6ad6ef1`, and compare
   the deployed Netlify bundle hash against a fresh local build. If they
   differ, someone shipped something this doc doesn't know about.
2. Check **§6 Open decisions** (D-1 through D-7) — several tasks are blocked
   on a one-line answer from Χάρης or Theocharis, not on code.
3. **§7 Track A** is the near-term priority list (before the TechnoAlimenti
   account goes out): the two agreed renames (NAM-01/02), terminology
   cleanup (NAM-04/05/06), making "Save edits" visually obvious (UI-03), and
   the Tone/Audience dropdowns (UI-02).
4. FLOW-01 (whether the Generate tab disappears) is **deliberately excluded**
   from Track A — it's the largest, least-settled change and the doc says
   not to ship it to the first external tester.

## What's already done, per that doc

- UI-01 (scoring engine removed from the interface) — done, deployed, verified.
- CAR-01 (the carousel/image panel is now prominent in Review) — done, deployed, verified.
- CAR-03 (markdown asterisks no longer painted into slide PNGs) — done, verified.
- FLOW-02 (export reflects the approved/edited content, not the original) — verified true, not a bug.

## Still open / TODO

Everything else in §2 — see the doc for the full list and evidence per item.
Nothing here should be treated as done from memory; the doc explicitly
separates "implemented" from "verified" from "in the tester's build" because
those weren't always the same thing.
