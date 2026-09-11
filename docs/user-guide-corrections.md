# Corrections owed to the Word user guide

The user guide (`CUES_Editorial_Cloud_Odigos_Xrisis_v2.docx`, Greek, written in
session 18) **is not in git**. It was generated once, screenshotted from the
live site, and handed over; there is no source here to edit and no version
history. It therefore drifts silently every time the product changes, and the
only way anyone finds out is a reader hitting the difference — which is exactly
how the corrections below were found.

This file is where that drift gets recorded, so the next person to refresh the
guide has a list instead of a memory. Each entry quotes the guide verbatim,
states what is actually true, and says how that was checked.

---

## 1. Who may do what — the roles paragraph is wrong

**Section:** «Ρόλοι: απλός χρήστης και διαχειριστής»

**The guide says:**

> Υπάρχουν δύο επίπεδα πρόσβασης. Και τα δύο βλέπουν τα πάντα και μπορούν να
> τρέξουν όλη τη ροή εργασίας· η διαφορά είναι σε ενέργειες **που αλλάζουν τη
> διαμόρφωση ή διαγράφουν οριστικά**.

The first sentence is now true — session 21 made it true. The tail is not.
**Changing the configuration is open to every editor**, and always was: the
`configurations` UPDATE policy carries no `is_admin()` test, so a plain user can
change the relevance threshold, the scoring engine, the editorial brief, the
tone, the audience and the anonymisation name list.

**Replace the tail with:**

> · η διαφορά είναι στην προσθήκη, τη μετονομασία και την οριστική διαγραφή.

**What is actually true, verified against the live project on 2026-09-11:**

| Action | Plain user (`editor`) | Enforced by |
| --- | --- | --- |
| Every step of the workflow — Collect, Find names, Score, Anonymise, Cluster, Generate, AI slides | **yes** | `_shared/auth.ts` (allowlist only) |
| Change any setting on Objective | **yes** | `configurations` RLS — no admin test |
| Change a source's lookback, or its Enabled switch | **yes** | `sources` UPDATE RLS |
| Add a source | no | `sources_insert_for_admins` |
| Rename a source, change its URL/type/company | no | trigger, `0025` |
| Delete a source | no | `purge_source`, `0026` |
| Delete generated copy | no | `admin_delete_generation_result`, `0027` |

**How each row was checked.** The four admin-only rows were exercised against
`demo.editor@f-in.eu` on the live project in session 18 and re-confirmed in the
0026/0027 test suites. The "yes" rows were exercised in session 21: the
workflow rows by calling `ingest`, `discover-brands` and `slide-images` with
that account's real JWT (each reached input validation and returned 400, which
only happens after authentication succeeds), and the settings row by PATCHing
`configurations.min_relevance_score` **to the value it already held** — a write
that proves the permission without changing anything.

**Why the guide was wrong about the workflow, and is now right.** Until session
21 the shared `authenticate()` demanded role `admin` for every Edge Function,
so a plain user could run no step at all — the guide's first sentence was
false. A manager trialling the tool on `demo.editor` pressed Collect and Find
names, got `Edge Function returned a non-2xx status code` for both, and
reported two broken buttons; in fact all seven functions were closed to him.
The restriction's own comment said it stood "while provider quota is being
measured", and session 20 measured it. It was removed on the operator's
instruction, leaving admin-only exactly where the operator put it: deletions,
and adding or removing a LinkedIn source.

---

## 2. Known gaps, not errors

Not wrong, just missing. Listed so a refresh pass can decide about them, not
because anything is broken:

- **Slides are absent entirely.** Session 20 added "Download as slides" —
  carousel pages rendered as 1080×1080 PNGs, with an optional paid AI
  background. The guide predates it and does not mention the feature. The
  reviewer noticed the gap from the other direction, asking whether that step
  should be surfaced more prominently and the Review tab renamed.
- **The nav order and the Sources form** are documented as they were before the
  session-18 reorder and the URL/collection-address merge.

---

## 3. Standing feedback from the first outside reader

The guide's first reader outside the team (2026-09-09) returned it with three
defects — all fixed in session 21 — and roughly twenty questions and
suggestions that are **not** defects: proposed tab renames, requests to explain
how themes, clusters, slides and the publication text relate to one another,
and a request to define `approved` / `published` / `draft` / `rejected`
somewhere in the document. Those are product and documentation decisions, not
corrections, and are held separately from this list.
