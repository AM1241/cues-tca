# CUES-TCA — consolidated requirements, plan and handoff

**Audience:** the developer with Git access who will continue the work.
**Purpose:** everything needed to carry on without reading any chat history.
**Written:** 2026-09-15. Language: English, to match the rest of `docs/`.

This file is the authoritative task list. `docs/SESSION_HANDOFF.md` remains the
narrative record of how the system got here and why particular decisions were
made; read it when a task below points at it. `docs/user-guide-corrections.md`
is where drift between the product and the Word user guide is recorded.

---

## 0. Read this before you change anything

### 0.1 Where the code is

| | |
| --- | --- |
| Branch | `phase6-frontend-binding` — **all current work is here, not on `main`** |
| Last commit at time of writing | `6ad6ef1` |
| Supabase project | `bxaovkzemfyxrxbcqask` (`cues-tca`, eu-west-1) |
| Production frontend | cues-tca.netlify.app, bundle `index-DFrWsv4w.js` (FLOW-01 deployed 2026-09-15) |
| Migrations | applied through `0028` |
| Edge Functions | `ingest` v10, `score-worker` v11, `anonymize-worker` v12, `cluster` v6, `generate` v6, `discover-brands` v7, `slide-images` v2 |

`origin/phase6-frontend-binding` was fetched on 2026-09-15 and carried **no
commits beyond `6ad6ef1`**. Netlify was serving the bundle built from it.

**Update, same day:** Track A's naming/UI work (§7 A3–A8) was implemented on
`frontend-design-system` — not `phase6-frontend-binding` — as commit `cc3dab0`.
That branch already contains everything through `162f80f`
(this file's own commit) merged in. `cc3dab0` is **committed but not pushed**
and **not yet merged into `phase6-frontend-binding`**. See
`docs/NEXT_SESSION_HANDOFF.md` for the current pointer.

### 0.2 Reconciliation check — do this first

Χάρης has stated he has begun implementing changes that have not all been
reported here. Nothing in this document should be treated as untouched ground
until that is checked. **Before starting any task below:**

1. `git fetch --all` and compare against `6ad6ef1`. Look on every branch, not
   only `phase6-frontend-binding`, and ask Χάρης about uncommitted local work.
2. Compare the deployed bundle hash on cues-tca.netlify.app with a local
   `npm run build`. If they differ, someone deployed something this document
   does not know about.
3. For every task marked **TO CONFIRM**, resolve it with Χάρης before writing
   code. Those are the places where duplicate or conflicting work is likely.
4. Re-read §5 (verification) before declaring anything finished.

### 0.3 What the status words mean

Three different things, deliberately kept apart:

- **Implemented** — the code exists on the branch.
- **Verified** — exercised against the running application, not only compiled.
  Where this is claimed, the evidence is named.
- **In the tester's build** — present in the bundle currently served by
  cues-tca.netlify.app, which is what TechnoAlimenti will open.

A task is only `DONE` when all three are true and its completion criteria are met.

### 0.4 Scope

In scope: making the existing CUES-TCA simple and legible for an ordinary user,
from sources and settings through to post/carousel, human editing and approval,
and export.

Out of scope for this round: CO₂ calculation and any other tool; automatic
publishing to LinkedIn or any platform (never requested); a billing dashboard or
payment system (see ACC-04 for what was actually asked).

---

## 1. Direction

Theocharis Moisis (TechnoAlimenti) reviewed the product as an ordinary user.
The direction agreed from that review:

> Make the existing CUES-TCA simple and understandable for a plain user, with a
> clear path from sources and settings to post/carousel, human editing and
> approval, and export. Whatever offers concrete value must be clearly visible.
> Whatever has no clear use should be re-examined and simplified or removed.
> Deferred capabilities stay deferred until testers ask for them.

Two consequences worth stating, because they decide arguments later:

- **The tool produces posts *and* carousels.** Do not mechanically rename
  "publication" to "carousel" — see NAM-04.
- **The tool produces and exports content. It does not publish it.**

---

## 2. Consolidated requirements

IDs are stable. Use them in commits, branches and questions. Nothing is renumbered.

Each task states: required behaviour · status and evidence · dependencies ·
who is responsible · completion criteria.

### 2.1 Naming and terminology

#### NAM-01 — `Objective` becomes `Settings`
- **Required:** the tab and every in-app reference to it read "Settings".
- **Status:** **VERIFIED in the running app, 2026-09-15.** `Layout.tsx` nav
  label, the screen's own `<h1>`, the save toast, and every `reaches` badge
  that named "Objective" now say "Settings" (`cc3dab0`). Route `/objective`
  was deliberately left as-is, per this task's own scope note.
  `grep -rn "Objective" frontend/src` now returns only the route path,
  the component name `Objective()`, and code comments — no user-visible string.
  Exercised against a fresh local Supabase stack (`supabase db reset`, all 28
  migrations) + `npm run dev`, signed in as a throwaway `editor`-role account:
  nav shows "Settings", the Settings `<h1>` reads "Settings", zero console
  errors. Screenshot evidence in session scratchpad. **Not yet on
  cues-tca.netlify.app** — deploy is still A12.
- **Evidence:** explicit agreement with Theocharis.
- **Dependencies:** none. Blocks DOC-01.
- **Responsible:** developer.
- **Done when:** nav shows "Settings"; no visible string in the app calls that
  screen "Objective"; `grep -rn "Objective" frontend/src` returns only route
  paths and file names. *(Grep condition met; verified-in-app is now done. Only
  in-tester's-build remains — see A12/A13.)*

#### NAM-02 — `Posts` becomes `Rating`
- **Required:** the tab reads "Rating".
- **Status:** **VERIFIED in the running app, 2026-09-15.** `Layout.tsx` nav
  label, `Posts.tsx`'s own `<h1>`, and the `reaches`/`STAGE_TONES` references
  on Settings now say "Rating" (`cc3dab0`). Confirmed same session as NAM-01:
  nav and screen `<h1>` both read "Rating", not deployed yet.
- **Evidence:** explicit agreement with Theocharis. **This supersedes an earlier
  recommendation in this project to keep "Posts"** on the grounds that the name
  was incomplete rather than wrong. The explicit agreement wins.
- **Dependencies:** none. Blocks DOC-01.
- **Responsible:** developer.
- **Done when:** as NAM-01, for "Posts".

#### NAM-03 — the product title/description says what it makes
- **Required:** the title or description makes clear the tool produces **posts
  and carousels**.
- **Status:** **VERIFIED in the running app, 2026-09-15.** The header now
  carries a one-line description under "Editorial Cloud": "LinkedIn posts and
  carousels, ready for review" (`Layout.tsx`, `cc3dab0`). No new product name
  was invented, per the constraint below. Visible on every screen in the
  running app (it's in the shared header), not deployed yet.
- **Open:** **no final new product name has been agreed.** Do not invent one.
- **Dependencies:** none.
- **Responsible:** developer for the description; Χάρης + Theocharis for any
  name change.
- **Done when:** a user landing on the app can tell from the header or a one-line
  description that it produces LinkedIn posts and carousels.

#### NAM-04 — remove vague "publication" / «έκδοση» *(create-carousel button text: NOT reachable this session — see A11 note below)*
- **Required:** where the interface or guide says "publication" ambiguously, say
  **post** or **carousel** according to what is actually meant at that point.
  Specifically requested: the creation step must read **"Create the carousel"**,
  not "Create the publication".
- **Constraint, stated explicitly:** do **not** replace every occurrence of
  "publication" with "carousel" — the tool also produces posts, and some places
  legitimately mean the whole output of a period.
- **Status:** **IMPLEMENTED for the interface, not yet verified, deployed, or
  applied to the guide.** All the occurrences named below were fixed in
  `cc3dab0`, plus several found by a follow-up review pass (fixed in a second
  commit same session): the Topics screen's create button now reads exactly
  "Create the carousel"; its box heading reads "Create a post and carousel";
  `PublicationPanel.tsx`'s heading is now "Your carousel", its text-editing
  section is "Post text", and "Untitled publication" is "Untitled carousel";
  toast copy in Clusters.tsx ("The post and carousel failed to generate.",
  "Drafted — approve it in Review.") and the "Draft ready" label no longer say
  "publication". Left alone, deliberately: the `kind: 'publication'` /
  `'(per_cluster,publication)'` strings are backend API contract values, not
  user-visible text, and several code comments — matching the "not every
  occurrence" constraint above.
- **Evidence:** explicit request.
- **Dependencies:** NAM-05, NAM-06 — decide names once, then apply.
- **Responsible:** developer, after the naming decisions.
- **Done when:** every user-visible "publication" either says post/carousel
  correctly or is deliberately kept and justified in a code comment; the create
  button reads "Create the carousel"; UI and guide agree. *(UI side done; the
  guide has not been touched — DOC-01/DOC-04 still pending.)*

#### NAM-05 — what the `Clusters` tab should be called
- **Required:** a decision. The current name is internal jargon.
- **Status:** **DECIDED, IMPLEMENTED and VERIFIED in the running app,
  2026-09-15.** Χάρης confirmed `Topics` (2026-09-15). Applied to the nav
  label, the screen's own `<h1>` (was "Anonymised & Clusters"), every
  `reaches`/`STAGE_TONES` reference on Settings, and the cross-links from
  Generate.tsx and Review.tsx that used to say "the Clusters view" (`cc3dab0`
  + follow-up commit). Confirmed live: nav label "Topics", screen `<h1>`
  "Topics" (route stays `/clusters`, as designed), Review's empty-state text
  correctly says "run a generation from the Topics view". Not deployed yet.
- **Conflict to resolve:** an earlier proposal in this project was
  `Clusters → Publication`. **NAM-04 supersedes it** — "publication" is exactly
  the vague word being removed. A new name is required.
- **Design proposal (not agreed):** ~~`Topics`~~ — **agreed, see Status above.**
  It names what the grouping produces, avoids the word "publication", and does
  **not** collide with `Themes`, which is already taken by the six scoring
  themes on the Settings screen. That collision is real and is the source of
  Theocharis's question "what is the relationship between themes and
  clusters?" — do not make it worse by calling this screen "Themes".
- **Responsible:** Χάρης decides.
- **Done when:** a name is chosen and applied with NAM-04.

#### NAM-06 — labels for the review-and-download step
- **Required:** the user must easily understand where they *see* and where they
  *download* the result.
- **Status:** **DECIDED and APPLIED, 2026-09-15.** Χάρης picked **Option B**
  (`Review & Approve` / `Your carousel, ready to download`). Cherry-picked
  from `nam06-option-b-review-approve` (`008653b`) onto
  `phase6-frontend-binding` as `b05e9fc`. `npm run build` verified clean
  after applying. Not yet pushed/deployed — see "Done when" below for what's
  left. The underlying interface work is done — see CAR-01.
- **Note:** "Review and Download" and "Carousel Download" were given as
  **examples, not final labels.**
- **Live strings today** (verified in `frontend/src/`, commit `9a2f7c8`):
  the nav tab reads **`Review`** (`frontend/src/components/Layout.tsx:15`);
  the screen `<h1>` reads **`Review`** (`frontend/src/routes/Review.tsx:86`);
  the panel heading inside the carousel editor reads **`Your carousel`**
  (`frontend/src/components/PublicationPanel.tsx:293`). The route stays
  `/review` in every option — this is copy only, no migrations, no A13.
- **Options** (each is a branch off `9a2f7c8`, one commit each, all `npm run
  build` clean — apply with a single `git cherry-pick`):

  | Option | Tab label | Panel heading | Branch |
  | --- | --- | --- | --- |
  | A | `Review & Download` | `Your carousel` (unchanged) | `nam06-option-a-review-download` (`606f8a3`) |
  | B | `Review & Approve` | `Your carousel, ready to download` | `nam06-option-b-review-approve` (`008653b`) |
  | C | `Review & Download` | `Your carousel — download it here` | `nam06-option-c-preview-download` (`1c2e7d4`) |

  Rationale, grounded in this project's own settled vocabulary:
  - **A** names the two user actions in the doc's own words, keeps the
    already-shipped "Your carousel" heading, and matches the plain-user tone
    D-1 settled ("Topics"). No new wording introduced anywhere.
  - **B** emphasises approval because that is the step's purpose per FLOW-03
    (approve before export) and puts "download" on the panel itself, right
    next to the Download button it describes.
  - **C** is the strongest "where do I download" answer: the heading points
    at the download control, while the tab stays minimal. Slightly more
    conversational ("— download it here"), which is a tone decision for
    Χάρης, not a consistency one.

- **Responsible:** Χάρης decides; developer applies the chosen branch.
- **Done when:** Option B applied (`b05e9fc`), pushed to
  `phase6-frontend-binding`, and confirmed live via Playwright as
  `hzafeiris@f-in.eu` on `cues-tca.netlify.app`, 2026-09-15: nav tab and
  page `<h1>` both read "Review & Approve", panel heading on a selected
  carousel item reads "Your carousel, ready to download", no console/page
  errors. The two unused option branches
  (`nam06-option-a-review-download`, `nam06-option-c-preview-download`)
  have been deleted. **NAM-06 is fully closed.**

### 2.2 Simplification of the interface

#### UI-01 — the scoring engine leaves the interface
- **Required:** the model choice and scoring-engine controls are not shown to
  the user. Scoring keeps working; internal parameters stay configurable.
- **Status:** **DONE.** Implemented (`0202db7`), verified on the production URL
  as `demo.editor@f-in.eu` on 2026-09-14, and present in the tester's build.
- **How it was done, and why it matters:** the fields were removed from the form
  **and from the UPDATE statement**, not merely hidden. A form that still writes
  a field it no longer shows will overwrite a value changed elsewhere with
  whatever it loaded. `frontend/src/routes/Objective.tsx` can no longer touch
  `configurations.scoring_model`, `.scoring_model_snapshot` or
  `.aggregation_strategy`.
- **Superseded:** an earlier proposal to keep the control for admins only. The
  final agreement was removal.
- **Carry-over risk, recorded in the code where the control used to be:**
  `scoring_model_snapshot` is sent to OpenAI verbatim. A wrong value does not
  fail on save — it fails silently on every subsequent score. Editing it by hand
  in SQL or the dashboard now happens without the guard-rail the dropdown gave.
- **Not approved:** support for Claude or other providers (see LATER-04).

#### UI-02 — `Tone` and `Audience` become dropdowns
- **Required:** replace entirely free text with a small set of appropriate
  options.
- **Status:** **IMPLEMENTED and VERIFIED in the running app, 2026-09-15.**
  Χάρης confirmed shipping the proposed lists as-is (2026-09-15). Both fields
  are now a `SelectField` closed dropdown in `frontend/src/routes/Objective.tsx`
  (`cc3dab0`). An out-of-list or empty stored value is kept/shown rather than
  silently swapped — this needed a follow-up fix in the same session: the
  first version didn't render a blank option for the never-configured (`''`)
  case, so the select would visually default to the first list item while the
  real stored value stayed empty. Fixed before commit. **The specific fix was
  re-verified live this session**, against a `configurations` row seeded with
  `voice_tone`/`voice_audience` both NULL (the never-configured case the bug
  was about): both selects correctly show and have selected "Not set" — the
  bug does not reproduce. Full option lists confirmed present and in order for
  both fields.
- **Options shipped, per confirmed proposal:**
  - *Tone:* Informative · Analytical · Practical · Authoritative ·
    Conversational
  - *Audience:* Industry professionals · Policy and regulators ·
    Business decision-makers · General public
- **Dependencies:** none technically; option list confirmed 2026-09-15.
- **Responsible:** Χάρης/Theocharis confirm the lists; developer implements.
- **Done when:** both are closed lists, an out-of-list stored value still
  displays, and saving does not alter the other Voice fields. *(Met in code;
  not yet exercised against the running app.)*

#### UI-03 — `Save edits` must be easy to see
- **Required:** the control is visually distinct enough not to be missed.
- **Status:** **IMPLEMENTED, still not verified in the running app.** Reaching
  this control needs an actual generated result to edit (a row in
  `cluster_generation_results`/`_reviews`), which needs a real run through
  score → anonymize → cluster → generate — i.e. live OpenAI/RapidAPI calls.
  That was out of scope for this session's verification pass (no API keys
  configured locally, and running paid calls just to click through a save
  button wasn't judged worth the cost — see ACC-04 on keeping trial
  consumption attributable). Review's *empty* state was confirmed correct
  (correct heading, correct "Topics view" cross-link, no console errors); the
  editor and its Save button were not reached. Both Review.tsx
  editors (the carousel/post path and the legacy-asset path) now switch the
  button to `variant="primary"` with a drop shadow when there are unsaved
  changes (`cc3dab0`). A first attempt also made the button `sticky` to the
  viewport bottom while dirty; a review pass caught that this had no proper
  scroll container and could visually overlap the notes field and
  Approve/Reject buttons scrolling underneath it, so `sticky` was dropped —
  prominence comes from color/shadow only, not repositioning.
- **This got more urgent, not less.** The Review screen was restructured in
  CAR-01 and the panel above the button is now long: the user edits at the top
  and the save control is far below. The risk is losing work, not aesthetics.
- **Dependencies:** none.
- **Responsible:** developer.
- **Done when:** the control is visually primary when there are unsaved changes,
  and an editor who has typed something cannot plausibly miss it. *(Color/shadow
  change is in code; whether it's enough to "not plausibly miss" on the long
  restructured panel is a judgment call worth confirming against the running
  app, not just trusting the diff.)*

#### UI-04 — decide the fate of `Review notes`
- **Required:** either the purpose is explained clearly in the interface, or the
  field is simplified/removed from the flow.
- **Status:** **DECIDED and IMPLEMENTED, not verified in the running app —
  same reason as UI-03.** The relabelled text lives inside the Review editor,
  which needs a real generated result to reach; not clicked through this
  session. Χάρης
  confirmed: keep the field, relabelled (2026-09-15). Both occurrences in
  `Review.tsx` now read "Why you approved or rejected this (visible here
  only)" instead of "Review notes" (`cc3dab0`), exactly the wording this
  document recommended. Investigated on 2026-09-15; the facts behind that
  recommendation:
  - Written to `cluster_generation_reviews.approval_notes` when a result is
    approved or rejected (`Review.tsx:377`).
  - Read back only into the same screen when that result is reopened
    (`Review.tsx:281`).
  - **Nothing consumes them** for generated results — no Edge Function reads
    them, no prompt receives them, and the generated-content export does not
    include them.
  - They *are* included in the **legacy asset** export
    (`frontend/src/lib/exporters.ts:74`), which is a different, older path.
- **So the honest description today is:** a private note to yourself about why
  you approved or rejected something, visible only on that item.
- **Recommendation, agreed and applied:** keep the field and label it for what
  it is — "Why you approved or rejected this (visible here only)". It costs one
  line and removes the confusion; removing it would delete an audit trail that
  `0017` deliberately created.
- **Not requested:** any mechanism that learns from the notes, and any deletion
  of historical data.
- **Responsible:** Χάρης decides; developer applies.

### 2.3 The Generate → Review → Export flow

#### FLOW-01 — simplify the separate `Generate` tab
- **Required direction:** Theocharis questions whether a separate Generate tab
  earns its place. Χάρης undertook to examine having generation lead **directly
  to Review**.
- **This is a direction for simplification, not a finalised screen layout.**
  A concrete proposal is required before implementation.
- **Status:** **IMPLEMENTED and VERIFIED against production, 2026-09-15** —
  see CHK-05. Χάρης approved D-5 (move Generate's content to Topics and
  Review). Applied exactly as proposed below; `npm run build` clean; live
  verification recorded under CHK-05. **Deployed to cues-tca.netlify.app
  2026-09-15** — pushed `phase6-frontend-binding` (`8e03c9e..78975cd`);
  Netlify's Git-connected build picked it up, now serving bundle
  `index-DFrWsv4w.js` (hash matches local `npm run build`), Generate nav
  gone, "view in Topics" present in the live bundle.
- **What the screen actually is today**, so the proposal is grounded:
  `frontend/src/routes/Generate.tsx` is **read-only**. Its own header comment
  says so: it lists generation *requests* with timestamp and status, and the
  action itself lives on the Clusters screen. It reads `post_output` /
  `carousel_output` — the **model's originals** — and never `edited_output`.
  Two details worth knowing before judging whether anything is lost: Review's
  empty state already says "run a generation from the Topics view" (so Review
  already points at Topics as the home of generation), and the Topics run
  selector already shows "· N generated" per run (so a count already exists
  there). The Generate tab's only unique content is the *list of requests
  with status/errors* and the *model originals read back from the database*.
- **Design proposal (drafted 2026-09-15 — awaiting approval):** remove the
  Generate tab from the navigation and move its two jobs — the request list
  (status/errors) and the model-original results — into a collapsible
  "Generation history" disclosure on the Topics screen, plus a link from each
  Review item back to the request that produced it. Nothing is deleted from
  the database; this is a navigation change. Concrete shape:
  1. **Nav + routing.** Remove `{ to: '/generate', label: 'Generate' }` from
     `frontend/src/components/Layout.tsx` (line 14) and the `/generate` route
     + its import from `frontend/src/App.tsx` (lines 9 and 73). The
     `frontend/src/routes/Generate.tsx` route component then becomes dead
     code and is deleted — its shared rendering (`GenerationResultCard`,
     `GenerationErrorList`) lives in `frontend/src/components/generation.tsx`,
     which Topics already imports, so nothing rendering-related is lost with
     the file.
  2. **Generation history on Topics.** Add a collapsed disclosure at the
     bottom of `frontend/src/routes/Clusters.tsx` (below the two existing
     generation blocks) titled "Generation history", rendering the same
     request list the Generate tab shows today — timestamp, status badge
     (completed/failed), cluster count, output types, error message — and,
     per request, the model originals + errors via the already-imported
     `GenerationResultCard` / `GenerationErrorList`. It is scoped to the
     **selected run** by default, so the existing run selector doubles as the
     history filter and no new control is added.
  3. **Review → request link.** Add a one-line link in the review detail
     header ("Request {timestamp} — {status}", opening the history entry for
     the request behind that draft). The join already exists in Review's own
     query (`cluster_generation_results` → `cluster_generation_requests`); no
     new data is read.
  4. **Settings `reaches` badges.** The Settings screen's `StageHeader` badges
     currently name "Generate" as the screen a change reaches
     (`frontend/src/routes/Objective.tsx`: stage 1 reaches
     `['Rating', 'Topics', 'Generate']`, stage 4 reaches `['Generate']`).
     With the tab gone, stage 1 becomes `['Rating', 'Topics']` and stage 4
     becomes `['Topics']`, and the `Generate` key is dropped from
     `STAGE_TONES` — the badge must name a screen on the nav bar, per
     `StageHeader`'s own comment.
- **FLOW-03 preservation checklist** — each capability, and where it lives
  after the change:
  - *Content generation* — Topics' "Create a post and carousel" and (when
    `PER_CLUSTER_GENERATION` is re-enabled) "Generate editorial copy". Unchanged.
  - *Editing* — Review's `PostOutputEditor` / `CarouselOutputEditor` and the
    image panel. Unchanged.
  - *Saving changes* — Review's Save-edits control (UI-03) and regenerate. Unchanged.
  - *Human approval* — Review's Approve/Reject. Unchanged.
  - *Model originals + request status/errors* — moved verbatim from the
    Generate tab to the Topics "Generation history" disclosure. Nothing lost.
- **Files touched at implementation** (so the size of the change is explicit
  before approval): `Layout.tsx`, `App.tsx`, `routes/Generate.tsx` (deleted),
  `routes/Clusters.tsx`, `routes/Review.tsx`, `routes/Objective.tsx`. No
  `supabase/` changes; no migrations.
- **Open question for Χάρης:** whether the history disclosure shows only the
  selected run (proposed default) or all runs with its own filter.
- **Responsible:** developer proposes; Χάρης approves; then implement.
- **Done when:** an ordinary user can get from "make me a draft" to "approve it"
  without visiting a screen that does nothing, and no capability listed in
  FLOW-03 was lost. **Met 2026-09-15 — CHK-05 passed against production.**

#### FLOW-02 — export must reflect the final approved version
- **Required:** what is exported is the final content, not superseded content.
- **Status:** **VERIFIED ALREADY TRUE** for saved edits. Investigated
  2026-09-15: `frontend/src/routes/Export.tsx:210` resolves
  `edited_output ?? original`, so a saved editorial change is what gets
  exported. Export defaults its filter to `approved` (`Export.tsx:40`).
- **Therefore:** *Generate and Export can legitimately differ, because Generate
  shows the model's original and Export shows the approved result. That is by
  design and is not a bug* — this was agreed explicitly.
- **Residual risk to check, not assumed:** unsaved edits in Review are not in
  `edited_output`, so an editor who edits and exports without pressing Save gets
  the previous content. That is what UI-03 is for.
- **Responsible:** developer runs CHK-02.
- **Done when:** CHK-02 passes and the difference between Generate and Export is
  explained in the guide (DOC-04).

#### FLOW-03 — capabilities that must survive any simplification
- **Required:** content generation, editing, saving changes, human approval.
- **Status:** constraint, not a task. Cite it in review of FLOW-01.

### 2.4 Carousel and images

#### CAR-01 — the image step is prominent
- **Required:** the critical step of seeing and downloading the images has a
  clear title, position and visual weight.
- **Status:** **DONE** as an interface change; **labels still open** (NAM-06).
  Implemented (`5523b58`), verified on production as `demo.editor@f-in.eu` on
  2026-09-14, present in the tester's build.
- **What changed:** `SlideDownload.tsx` became
  `frontend/src/components/PublicationPanel.tsx`. Measured before: 118×118px
  thumbnails roughly 11,500px down the detail pane, below the raw citation
  links, under the heading "Download as slides". Measured after on production:
  the panel starts at 228px with a 510px slide. Review now opens with the
  finished post — title, caption and CTA as the accompanying words, the slide, a
  counter, swipe dots — then the editing bench for the slide currently shown,
  then the publication's own text.
- **Note for whoever touches it:** both bands read and write the same draft, so
  editing below changes the post above once the copy settles. There is
  deliberately **no second place** to edit slide text; `CarouselOutputEditor` is
  no longer used on this screen.

#### CAR-02 — make it clear when an image is being produced or updated
- **Required:** the user is clearly informed that image creation/update is in
  progress. The delay was considered acceptable; a faster, more expensive model
  was **not** requested.
- **Status:** **IMPLEMENTED, not yet verified in the running app, 2026-09-15.**
  Reviewed `PublicationPanel.tsx` against this requirement. The progress
  indication itself was already sufficient and needed no change: "Redrawing for
  your edits…" while text is being redrawn, a "Drawing N of M…" status line, the
  generate button switching to "Generating…" while busy, and per-slide "Drawing…"
  / "Failed to draw" states. **Found one real violation of the explicit
  instruction below:** the quality `<select>` showed "low — about 15s a slide"
  and "medium — about 60s a slide" — numbers that do not exist anywhere in this
  repo. The only timing note in `docs/SESSION_HANDOFF.md` (session 20, on
  `supabase/functions/slide-images/`) says generation takes "15-60s" as a single
  un-tiered range, given as a design rationale for one-request-per-slide, not as
  a measured per-quality-tier figure. `quality` is passed straight through to
  the OpenAI images API server-side with no timing code anywhere. Fixed: the
  dropdown now reads "low — fastest" / "medium" / "high — slowest" — relative
  ordering only, no invented numbers.
- **Explicit instruction:** the "10 seconds" mentioned in conversation is **not
  a measured figure and must not be presented as one.** Any duration shown to a
  user or written in the guide needs a real measurement behind it. The only
  measured figures in this project are session 20's image-generation timings —
  see `docs/SESSION_HANDOFF.md`, session 20 — and they are per-image generation
  costs and durations, not page-level waits, and not broken down by quality tier.
- **Responsible:** developer.
- **Done when:** a user who triggers image generation or an edit always sees
  that something is happening, and no unmeasured duration is claimed anywhere.
  *(Both halves are true in code now. Not yet clicked through in a running app —
  same constraint as UI-03/UI-04: needs a real generated result to reach the
  panel at all.)*

#### CAR-03 — markdown is not painted into the images
- **Required:** emphasis markers from the generator must not appear in the PNGs.
- **Status:** **DONE.** Implemented (`30368b2`), verified end-to-end in the
  running application, present in the tester's build.
- **Origin:** found while making the slides large enough to read; not raised by
  Theocharis. `stripEmphasis()` in `frontend/src/lib/slides.ts`.
- **Two properties not to undo:** the closing-marker boundary is "not a word
  character", not a list of punctuation — the first attempt listed punctuation
  and missed an em dash, which is what closes `*connections*` on slide 7 of a
  real publication. And there is deliberately **no sweep for leftover unpaired
  markers**, because the one that was tried deleted the trailing asterisks of a
  partly-masked name, which is a word rather than notation.
- **Related:** the generator used to be *asked* for markdown; **done 2026-09-15**
  — see DOC-05. `stripEmphasis` is kept regardless, as the guard for
  pre-change output and any emphasis a model emits anyway.

#### CAR-04 — explain Design Template versus AI images
- **Required:** the guide makes the difference understandable: AI image
  generation is based on the slide text and **is charged**; Design Template is
  immediate, uses no AI and carries no such charge.
- **Status:** TODO (documentation).
- **Responsible:** Χάρης/Theocharis for the guide text; developer confirms the
  technical claims against `frontend/src/lib/slideExport.ts` and
  `supabase/functions/slide-images/`.

#### FLD-01 — what `Caption`, `Title` and `CTA` actually do
- **Required:** establish what each field does, how they differ, where they
  appear, and whether they are used in export. If useful, explain clearly in the
  interface and guide. If redundant, propose simplification after checking
  dependencies.
- **Status:** **INVESTIGATED 2026-09-15.** The meeting did not establish this and
  verbal guesses were explicitly not to be adopted as specification. These are
  read from the code:

  | Field | Drawn on the images? | In Markdown/DOCX export? |
  | --- | --- | --- |
  | `title` | **Yes** — footer of every slide except the first (`slides.ts`, `drawFooter`) | Yes, as the H1 (`exporters.ts:109`, `docx.ts:112`) |
  | `caption` | No | Yes, as a paragraph after the slides (`exporters.ts:113`, `docx.ts:123`) |
  | `cta` | No | Yes, emphasised at the end (`exporters.ts:113`, `docx.ts:124`) |

  Each slide's `heading` and `body` are drawn on its own image and exported as
  H2 + text. So `caption` and `cta` are **the words that accompany the images**
  when the carousel is posted — which is how `PublicationPanel.tsx` now presents
  them, above the slide, in the post frame.
- **Conclusion:** all three are used and none is orphaned. The problem is that
  nothing told the user what they were for.
- **Status:** **IMPLEMENTED for the interface, not yet verified, 2026-09-15.**
  Added a one-line hint under each of Title/Caption/CTA in
  `PublicationPanel.tsx`'s "Post text" section, stating plainly whether it's
  drawn on the images or export/post-only — directly from the table above. No
  second editor surface exists to also fix: `CarouselOutputEditor` in
  `generation.tsx` is defined but confirmed unused (grep found zero call sites),
  matching CAR-01's own note that it was retired from this screen.
- **Remaining work:** the guide via DOC-01. Simplification is **not**
  recommended on this evidence.
- **Responsible:** developer for the interface hints; guide via DOC-01.

### 2.5 Access for TechnoAlimenti and the trial

#### ACC-01 — a plain user account on the FINT instance
- **Required:** give TechnoAlimenti a simple user account soon, **without admin
  rights** for the initial trial.
- **Status:** TO CONFIRM — the account for TechnoAlimenti has not been created as
  far as this document knows. What exists today: three accounts
  (`hzafeiris@f-in.eu` admin, `demo.admin@f-in.eu` admin, `demo.editor@f-in.eu`
  editor). The `editor` role can run the whole workflow as of session 21.
- **Dependencies:** none technical.
- **Responsible:** Χάρης.
- **Done when:** a named TechnoAlimenti account exists with role `editor`, its
  credentials are delivered, and the recipient can complete the flow.

#### ACC-02 — the team adds sources during the trial
- **Required:** for the initial period the team adds the sources for the
  partner. Full add/edit/delete of Sources for the plain user was **not** agreed.
- **Status:** **ALREADY THE CASE — verified** against the live database in
  session 21: inserting a source is admin-only (RLS), renaming and changing
  url/type/company are blocked by the `0025` trigger, deletion is admin-only via
  `purge_source` (`0026`). An editor can change `lookback_days` and the `enabled`
  switch, which is by design.
- **Action:** none, beyond not regressing it. Covered by CHK-04.

#### ACC-03 — the trial period and cost cover
- **Required:** roughly one month of controlled use, with FINT covering the cost
  initially.
- **Status:** **ORGANISATIONAL PENDING — no dates and no consumption limit have
  been set.** Do not implement any limit as though a number had been agreed.
- **Responsible:** Χάρης.

#### ACC-04 — consumption must be distinguishable and documentable
- **Required:** it must be possible to tell FINT's consumption apart from
  TechnoAlimenti's, and to document it.
- **Explicitly not required:** a billing dashboard or a payments system. Do not
  turn this into one.
- **Status:** **INVESTIGATED 2026-09-15 — the per-operation audit is written;
  the gap is named; implementation follows.** What the investigation found
  (verified against `supabase/migrations/*.sql` and the six functions' code,
  not the doc's own earlier claims):
  - **LinkedIn collection** — attributed. `ingest_runs` has
    `triggered_by`/`triggered_by_email` (`0003_ingest.sql`), populated by
    `ingest/runs.ts` from the resolved actor; `provider_requests` is a volume
    proxy.
  - **Scoring** — recorded but **not** attributable. `scoring_requests`,
    `scoring_job_state`, `scoring_results` (`0005`) have no attribution
    column; `score-worker/index.ts` resolves `authenticate()` into an `actor`
    used only for the batch cap, never persisted. `scoring_results.
    provider_response` carries the raw OpenAI response (token usage) per row,
    but with no caller column it cannot be summed per user.
  - **Anonymisation** — recorded but **not** attributable. Same shape as
    scoring: `anonymize_results`/`anonymize_job_state` (`0014`) have no
    attribution column, and `anonymize-worker/index.ts` discards the actor.
  - **Clustering** — `clustering_runs.created_by` exists (`0015`) and is
    populated via `(select auth.uid())` inside `create_clustering_run()`, but
    it is **always NULL in practice**: `cluster/index.ts` calls
    `authenticate()` and discards the result, then writes through the
    service-role client, under which `auth.uid()` is null.
  - **Generation** — same bug as clustering. `cluster_generation_requests.
    created_by` (`0016`) is schema-ready but always NULL, because
    `generate/index.ts` discards the actor and uses the service-role client.
    The doc's earlier statement "generation requests are attributed to the
    caller" is **false as currently wired**.
  - **Slide images** — **nothing recorded.** `slide-images/index.ts` is
    deliberately stateless (its own header: "WHY NOTHING IS STORED"); the
    only trace is Supabase platform logs.
  - **FINT vs TechnoAlimenti** — `public.editors` (`0002`) has
    `user_id, email, full_name, role` and **no org/domain column**, so even
    where a caller is captured (ingest), attributing to an organisation
    requires manual email-domain reading.
- **Minimal fix, implemented (migration `0029` + function threading):**
  `editors.org` column; `scoring_requests.created_by` + `scoring_results.
  triggered_by`/`triggered_by_email`; `anonymize_results.triggered_by`/
  `triggered_by_email`; threading the already-resolved `actor` into
  `create_clustering_run`/`create_cluster_generation_request` (explicit
  `p_created_by` argument, not `auth.uid()` under a service-role session);
  and a new `slide_image_requests` log table written by `slide-images`. No
  UI, no dashboard — every paid path becomes attributable to a caller, and
  callers to an org via `editors.org`.
- **Responsible:** developer investigates and reports; Χάρης decides what, if
  anything, to build.
- **Done when:** a short written answer exists saying, per paid operation, what
  is recorded and by whom it can be attributed — and any gap is named.
  *(The answer above is that written record; the gap-filling migration and
  function changes are the implementation of it.)*

#### ACC-05 — after the trial
- Feedback is gathered and what can be incorporated is incorporated. A separate
  instance/admin for TechnoAlimenti, with its own billing, is then **under
  consideration**. The payment mechanism remains open.
- **Status:** later. No work now.

### 2.6 Guide and delivery

#### DOC-01 — the guide follows the release, not the other way round
- **Agreed sequence:** (1) the changes are made; (2) Χάρης tells Theocharis what
  the release contains; (3) Theocharis adapts/translates the guide into English
  and sends it together with the account.
- **Consequence for planning:** every naming task (NAM-01…NAM-06) must be
  finished and deployed **before** step 2, because the guide's screenshots show
  the navigation bar.
- **Status:** blocked on the naming tasks.
- **Responsible:** Χάρης (release note), Theocharis (guide).

#### DOC-02 — keep recording guide drift
- `docs/user-guide-corrections.md` already holds one correction: the guide says
  the difference between the two roles is "actions that change the configuration
  or delete permanently", and **configuration is not admin-only** — verified
  live. Add to that file rather than to chat.

#### DOC-03 — scoring is ten posts per click
- **Verified 2026-09-15:** `supabase/functions/score-worker/index.ts` sets
  `DEFAULT_BATCH_SIZE = 10` and caps browser-triggered runs at that same value
  (`MANUAL_BATCH_CAP`). So a manual click processes **at most ten** posts.
  Theocharis's "(about 10)" annotation is correct and can be stated exactly.
- **No change to the batch size was requested.**

#### DOC-04 — a chapter explaining the flow
- **Required:** the guide should explain how sources, ratings, topics/clusters,
  slides, the post text and the export relate to one another, and what
  `approved` / `published` / `draft` / `rejected` mean.
- **Why:** ten of Theocharis's eleven comprehension questions are the same
  question — the relationship between the stages is not explained anywhere.
- **Status:** **DRAFTED 2026-09-15** — technical content written to
  `docs/flow-guide-draft.md` (developer half of the task; not committed as of
  writing). Theocharis's adaptation/translation into the Word guide is still
  his half, and is still blocked on D-2 for the final nav labels.
- **Responsible:** developer drafts the technical content; Theocharis writes the
  guide.

#### DOC-05 — stop asking the generator for markdown
- **Required (proposed, not agreed):** the carousel prompt in
  `supabase/functions/generate/` asks for emphasis the renderer cannot draw.
  CAR-03 strips it at render time, which fixes every publication that already
  exists — which is why it was done there first — but the prompt could stop
  producing it.
- **Status:** **DONE 2026-09-15.** Both prompts (`buildGenerationPrompt` and
  `buildPublicationPrompt`) now end their Rules with an explicit plain-text
  rule: no markdown emphasis — the post and slide text is drawn verbatim and
  cannot render those markers. Provenance versions bumped so the change is
  traceable in `cluster_generation_results`: `generate_v3` → `generate_v4`,
  `publication_v1` → `publication_v2`. Two new assertions pin the rule in
  `prompt_test.ts` and `publication_prompt_test.ts`; the full generate suite
  passes (22 passed, 1 ignored). CAR-03's `stripEmphasis` is deliberately kept
  — it still guards text generated before this prompt change and any emphasis
  a model emits anyway.

---

## 3. Clarifications to keep — things that are **not** bugs or tasks

Recorded so nobody spends time on them:

- **`Change lookback` already existed.** Theocharis had not noticed it and
  acknowledged this. Not a confirmed functional bug.
- **A `Collect` problem was reported fixed by Χάρης.** **TO CONFIRM:** which
  version contains that fix. Separately, session 21 found and deployed a
  different cause of Collect failing — every Edge Function required an `admin`
  role, so a plain editor could run nothing; `_shared/auth.ts` now requires only
  presence on the `editors` allowlist, and all seven functions were redeployed.
  **Establish whether these are the same issue or two before repeating work.**
- **`Find Names` returned no new results in the test**, without demonstrating a
  malfunction. The observation that messages disappear quickly is a **usability
  check**, not a documented bug. Session 21 did fix a separate, real problem
  here: failures showed the generic "Edge Function returned a non-2xx status
  code" instead of the server's own sentence (`frontend/src/lib/functionError.ts`).
- **Clustering stays.** The `minimum cluster size = 1` case was discussed to
  understand a possible use, **not** as a decision to remove clustering or to
  change the default.
- **Export was tried by Theocharis and reported working.** That is not an
  exhaustive test of the application. His testing was done as a plain user,
  mainly for comprehension and usability.
- **No automatic publishing** to LinkedIn or any other platform was requested.

---

## 4. Deferred ideas — not for implementation now

Record only. Revisit if testers ask.

- **LATER-01** — less text per slide, a length setting, or an LLM shortening
  function. **No word count was agreed.**
- **LATER-02** — an extra image prompt per slide. Explicitly **not now**;
  reconsider only if feedback asks for it.
- **LATER-03** — more colours or design templates. An exploratory question with
  no agreement to implement.
- **LATER-04** — support for other models or providers, including Claude. Only
  after a specific need.
- **LATER-05** — automatic contradiction checking between Themes and the
  Editorial Brief. Discussed with no change requested.
- **LATER-06** — full-screen slide presentation with arrow keys, and a
  two-column layout on wide screens. Proposed and deliberately left out of the
  CAR-01 work.

---

## 5. Targeted verification

Use what already exists. **Do not start a separate testing project.** Prefer the
Design Template variant for anything involving slides — it is free and needs no
provider call.

What already exists: 81 Deno tests for `ingest` and 24 for `slide-images`
(run instructions in `docs/SESSION_HANDOFF.md`, session 21 — note the documented
`docker run` omits `RAPIDAPI_KEY` and `INGEST_INTERNAL_SECRET`, and 19 of 81
tests fail confusingly without them).

#### CHK-01 — saving edits in Review
Edit a slide heading and a body, press Save, reload the page, reopen the same
result. The edit must still be there and the item must be marked as edited.
Then check the model's original is still shown separately.
- **Status: VERIFIED against production, 2026-09-15**, signed in as
  `hzafeiris@f-in.eu` (admin — `demo.editor@f-in.eu`'s password was not
  available this session; CHK-01/02/03 don't depend on role, only CHK-04
  does). Result `55cab6c5-500d-4b69-9f5c-634122590cd1` (carousel, already had
  a genuine prior edit — "The shared story" → "The shared full story"). Drove
  the browser with Playwright against the local dev server pointed at
  production Supabase. Appended a marker to the Heading field, confirmed
  "Save edits" went from disabled to enabled the moment the field changed,
  clicked Save, reloaded the page from scratch, reopened the same result: the
  marker was still there. Cleaned the marker back out afterward with a second
  edit/save cycle, confirmed by direct SQL read of `edited_output`. Zero
  console errors throughout. The model's original stayed visibly separate and
  unaltered ("Generated original" panel at the bottom of Review) — see CHK-02
  for the same fact confirmed from the Generate screen's side.

#### CHK-02 — export matches the final approved content
Take an approved carousel that has been edited. Export it as Markdown and as
Word. Both must contain the **edited** heading and body, the `title` as the
first heading, and the `caption` and `cta` at the end. Confirm the Generate
screen still shows the model's original for the same item — that difference is
expected and must not be "fixed".
- **Status: VERIFIED against production, 2026-09-15.** Same result as CHK-01.
  Approved it via the live Approve button (user confirmed this explicitly,
  since it changes shared production state — attribution recorded via
  `approved_by`/`approval_timestamp` in `cluster_generation_reviews`).
  Downloaded the bundled "Download all" Markdown and DOCX exports from the
  Export screen (default filter is already `approved`, confirming FLOW-02's
  claim). Both files contain the **edited** heading ("The shared full
  story…"), not the original — confirmed by grepping the raw `.md` and by
  unzipping the `.docx` and grepping `word/document.xml`. Content order in the
  Markdown matches the doc: `title` as `# H1` first, slide headings as `##`,
  caption and CTA at the end (CTA rendered bold — that's the exporter's own
  emphasis, not a CAR-03 regression; CAR-03 only concerns text painted into
  images, not the Markdown/DOCX text exports, which are supposed to carry
  Markdown syntax). Then opened Generate → the same request (`2026-09-03
  23:03`, matching the result's `created_at`) → confirmed it shows "The
  shared story: trust…" — the **original**, not the edit. Generate and Export
  differing on the same item is now empirically confirmed, not just argued
  from reading `Export.tsx:210`.

#### CHK-03 — carousel download
With the Design Template variant, download all slides. Confirm one PNG per
slide, 1080×1080, in reading order, and that the words on the images match the
approved text exactly — including that no `**` markers appear (CAR-03).
- **Status: VERIFIED against production, 2026-09-15.** Same result, Design
  Template variant (the default, free — no provider call). "Download 7
  slides" produced 7 files, `slide-01.png`…`slide-07.png`, each confirmed
  1080×1080 PNG via `file`. Slide 1 visually confirmed to show the edited
  heading exactly ("The shared full story: trust is built…"), no title/footer
  (correct — title is only in the footer of every slide *except* the first,
  per FLD-01's table). Slide 4 confirmed the footer does carry the title
  ("A system view of trust: logistics + controls + safety + talent"). Ran all
  7 PNGs through `tesseract` OCR and grepped for `*` — **zero asterisks found
  on any slide**, confirming CAR-03 holds for this carousel.

#### CHK-04 — plain-user permissions
Signed in as an `editor` account, confirm: the whole workflow runs; lookback and
the enabled switch can be changed; adding, renaming and deleting a source are
refused; deleting generated copy is refused. Session 21 verified this live — the
purpose here is to confirm no regression after the naming and flow changes.
- **Status: verified at the database layer, 2026-09-15 (third session)** —
  `demo.editor@f-in.eu`'s real password still isn't available, so this
  wasn't driven through the live UI as that named account. Instead, a
  throwaway `role='editor'` account was created in the **local** Postgres
  (not production) and the five restrictions were exercised directly against
  RLS/triggers/functions by impersonating its JWT (`set_config
  ('request.jwt.claims', ...)`, `set local role authenticated` — the same
  mechanism PostgREST uses, so this is what the policies actually see, not a
  proxy for it):
  - Editor **can** update `sources.lookback_days` and `.enabled` — succeeded.
  - Editor **cannot** rename a source (`sources.name`/`.url`/etc.) — blocked
    by the `enforce_source_edit_scope` trigger (0025): `only an admin may
    change name, type, url, company_name, rapidapi_identifier or
    collection_frequency`.
  - Editor **cannot** add a source — blocked by RLS
    (`sources_insert_for_admins`, 0025): `new row violates row-level
    security policy`.
  - Editor **cannot** delete a source at all (admin included) — there is no
    delete policy or grant on `sources` for any authenticated role, by
    design (0002).
  - Editor **cannot** delete generated copy — `admin_delete_generation_result`
    (0027) raises `only an admin may delete generated copy` before it even
    looks up the row.
  - Control: `is_editor()` true, `is_admin()` false, and ordinary reads
    (`sources` select) still work for the editor — confirming the block is
    specific to the five restricted actions, not a broken session.
  All throwaway rows (auth user, editor, seeded source/post) were deleted
  after the test; nothing persisted, and production was not touched. This
  confirms the *mechanism* CHK-04 cares about is intact after this session's
  changes (none of which touched RLS/triggers/admin functions). It does not
  confirm the deployed frontend surfaces these refusals cleanly to a real
  editor (e.g. as a readable error rather than a raw exception) — that part
  still wants a real UI pass with `demo.editor@f-in.eu` at some point, but is
  no longer a blocker for anything in Track A.

#### CHK-05 — after any FLOW-01 change
Confirm nothing in FLOW-03 was lost: generation, editing, saving, approval.
- **Status: VERIFIED against production, 2026-09-15.** Signed in as
  `hzafeiris@f-in.eu` (admin), Playwright against the local dev server pointed
  at production Supabase (`bxaovkzemfyxrxbcqask`). Evidence:
  - Nav now reads Sources · Settings · Rating · Topics · Review & Approve ·
    Export — **Generate is gone**, zero console/page errors.
  - Topics shows the collapsed **Generation history** disclosure; expanding it
    lists the selected run's requests ("N requests for the selected run",
    "5 clusters · post + carousel", completed badges) and shows the model
    originals on selection.
  - Review detail shows **"Request 9/14/2026, 4:23:57 PM — completed"** with a
    **"view in Topics"** link; clicking it navigates to
    `/clusters?run=…&request=…`, opens the disclosure, and the linked request
    is pre-selected with its originals shown. Zero errors throughout.
  - FLOW-03 controls all present and rendering live: Topics' "Create a post
    and carousel", Review's Save edits / Approve / Reject / Regenerate.
  - Not re-exercised this session: a fresh *paid* generation run. FLOW-01 is a
    navigation change that did not touch the generation/editing/approval code
    paths (confirmed by diff), and CHK-01/02/03 already exercised save/approve/
    export against production rows — re-running a paid generation just to
    re-confirm unchanged code was judged against ACC-04's cost-attribution
    concern.

---

## 6. Open decisions

Short list. Each needs one answer, from the person named. **None of these blocks
the rest of the plan** — work around them in the order given in §7.

| # | Decision | Proposal | Who answers | Answered |
| --- | --- | --- | --- | --- |
| D-1 | Name for the `Clusters` tab (NAM-05) | `Topics` — avoids "publication" and does not collide with the scoring `Themes` | Χάρης | **Yes, 2026-09-15 — `Topics`, implemented in `cc3dab0`.** |
| D-2 | Labels for the review/download step (NAM-06) | Apply once D-1 is settled so the vocabulary is consistent | Χάρης | **Yes, 2026-09-15 — Option B** (`Review & Approve` / `Your carousel, ready to download`), applied `b05e9fc` and verified live. |
| D-3 | Keep or remove `Review notes` (UI-04) | Keep, relabelled to say it is a private note visible only there | Χάρης | **Yes, 2026-09-15 — keep + relabel, implemented in `cc3dab0`.** |
| D-4 | The `Tone` and `Audience` option lists (UI-02) | The sets proposed in UI-02 | Χάρης / Theocharis | **Yes, 2026-09-15 (Χάρης) — ship the proposed lists as-is, implemented in `cc3dab0`.** Theocharis has not separately confirmed; revisit if he pushes back during the trial. |
| D-5 | Whether `Generate` disappears from the navigation (FLOW-01) | Yes, moving its content to Clusters and Review | Χάρης, after seeing the proposal | **Yes, 2026-09-15 — implemented and verified live.** FLOW-01 applied and CHK-05 passed (see §2.3 FLOW-01 and §5 CHK-05). |
| D-6 | A new product name (NAM-03) | None proposed — not invented deliberately | Χάρης / Theocharis | No — still open, no name invented (correct per NAM-03). |
| D-7 | Trial dates and any consumption limit (ACC-03) | None proposed — organisational | Χάρης | No. |

---

## 7. Plan

Three tracks. Priorities marked **[proposed]** are this document's
recommendation; everything else follows an explicit agreement.

### Track A — before TechnoAlimenti gets the account

The account cannot usefully be sent before the guide, and the guide cannot be
written before the names settle. That is the critical path.

| Order | Task | Blocked by | Status |
| --- | --- | --- | --- |
| A1 | Reconciliation check (§0.2) — **do this first, always** | — | **Done, 2026-09-15.** No undocumented work found on any branch; working tree clean. |
| A2 | D-1, D-2 decided | Χάρης | **D-1 done** (`Topics`). **D-2 done** — Χάρης picked Option B, 2026-09-15. |
| A3 | NAM-01, NAM-02 — the two agreed renames | A2 for consistency of one pass | **Implemented, `cc3dab0`. Verified in the running app, 2026-09-15.** |
| A4 | NAM-04, NAM-05, NAM-06 — terminology and the create button | A2 | **NAM-04, NAM-05 implemented, `cc3dab0`.** NAM-05 verified; NAM-04's create-button text not reachable without clustered data (see UI-03 note). **NAM-06 done and verified live, `b05e9fc`** — see NAM-06's Status line. |
| A5 | NAM-03 — description says posts and carousels | — (name itself is D-6) | **Implemented, `cc3dab0`. Verified in the running app, 2026-09-15.** |
| A6 | UI-03 — `Save edits` visible **[proposed: do early, it risks lost work]** | — | **Implemented, `cc3dab0`. Verified against production, 2026-09-15 (second session)** — see CHK-01: button correctly goes disabled → enabled the instant the field changes. |
| A7 | UI-02 — Tone/Audience dropdowns | D-4 | **Implemented, `cc3dab0`. Verified in the running app, 2026-09-15** — including the specific empty-value fix. |
| A8 | UI-04 — Review notes | D-3 | **Implemented, `cc3dab0`. Verified against production, 2026-09-15 (second session)** — "Why you approved or rejected this (visible here only)" confirmed rendering live in Review. |
| A9 | CAR-02 — progress indication reviewed | — | **Implemented, `61fb237`.** Found and fixed one real violation (fabricated per-tier timings); progress indication itself was already adequate. Not yet re-verified live post-fix (the "N of M" / "Redrawing…" states were exercised implicitly during CHK-01/03, no console errors, but the quality-dropdown wording itself wasn't re-screenshotted). |
| A10 | FLD-01 — explain the three fields in the interface | A4 vocabulary | **Implemented, `61fb237`. Verified against production, 2026-09-15 (second session)** — all three hints (Title/Caption/CTA) confirmed rendering live in Review's Post text section. |
| A11 | CHK-01…CHK-04 | A3–A10 | **CHK-01, CHK-02, CHK-03 verified against production, 2026-09-15 (second session).** **CHK-04 verified at the database layer, 2026-09-15 (third session)** — see each check's own Status line in §5. CHK-04 still wants a real UI pass with `demo.editor@f-in.eu` eventually, but the underlying mechanism (RLS + triggers + admin functions) is confirmed intact and is no longer a blocker. |
| A12 | Deploy, then DOC-01 step 2: Χάρης tells Theocharis what the release contains | A11 | **Deployed, 2026-09-15 (third session).** `frontend-design-system` pushed to `origin`, fast-forward merged into `phase6-frontend-binding` (`162f80f..cd2b61f`, no conflicts), pushed — Netlify's Git-connected build picked it up automatically. `npm run build` verified clean locally before push. Confirmed live: cues-tca.netlify.app now serves bundle `index-7Ix5u0wk.js` (was `index-BJ5_C7wK.js`), page and both new assets return HTTP 200. DOC-01 step 2 (Χάρης tells Theocharis) not done — that is Χάρης's own action, not a developer task. |
| A13 | ACC-01 — create the account and send it with the guide | A12 | Not started. **Responsible: Χάρης** — not a developer task, do not attempt it. |

**A2–A8 code is committed (`cc3dab0`, `frontend-design-system`, unpushed) and
`npm run build` (tsc -b && vite build) passes clean.** Per §0.3's own
distinction — **update, 2026-09-15, second session:** NAM-01, NAM-02, NAM-03,
NAM-05, and UI-02 are now **verified** against a running local app (see each
task's own Status line above for what was actually clicked through). UI-03 and
UI-04 remain implemented-but-unverified — their controls live inside the
Review editor, which needs a real generated result (a live score → anonymize →
cluster → generate run) to reach; that wasn't done this session, see the note
under UI-03. NAM-04's exact "Create the carousel" button text is in the same
boat — it only renders once Topics has clustered data. **None of this is on
cues-tca.netlify.app yet** — deploy is still A12.

**Local dev environment note for whoever runs this next:** this session found
the local Supabase stack's migration history was stuck at 0016 — the tables
from 0017 onward (`cluster_generation_reviews` among them) were missing,
producing "Could not find the table ... in the schema cache" errors on Review.
This was **local Docker-volume drift, not a code bug** — `supabase migration
list --local` showed 0017–0028 applied to neither local nor remote in its
tracking table, even though the doc's own §0.1 says production is at 0028.
Fixed with `supabase db reset` (reapplies all 28 migrations from scratch,
confirmed clean). If you hit the same schema-cache error, reset first before
assuming it's a regression from this branch's changes. Note also: the ports
Supabase CLI defaults to (54321-54324) are shared with at least one other
local project on this machine (`protero`'s `supabase-local` stack) — `supabase
start` will fail with "port already allocated" if that one is up. This session
stopped protero's stack to free the ports (data preserved in its Docker
volume, `supabase stop --project-id supabase-local`, not destroyed) and left
cues's own stack running afterward, on request.

A follow-up code review on the same diff (before commit) caught and fixed two
real bugs from the first pass, worth knowing about for anyone touching this
area next:
- `SelectField` (Objective.tsx, new for UI-02) didn't render a blank option
  for a never-configured (`''`) Tone/Audience value, so the dropdown would
  silently *display* the first list item while the real stored value stayed
  empty — exactly the kind of silent-mismatch bug UI-02's own requirement
  was written to avoid. Fixed: an explicit "Not set" option now covers the
  empty case.
- The first version of UI-03 made the Save-edits button `sticky` while dirty.
  There was no scroll container for `sticky` to resolve against (the page
  scrolls, not the Card), so it pinned to the viewport and could visually
  overlap the notes field and Approve/Reject buttons scrolling underneath it.
  Dropped `sticky`; the button is now primary-colored + shadowed only, no
  repositioning.

FLOW-01 is deliberately **not** in Track A. It is the largest change with the
least settled shape, and shipping a half-decided navigation change to a first
external tester is the wrong risk. **[proposed]**

### Track B — during and after the trial

| Task | Note |
| --- | --- |
| FLOW-01 | **DONE 2026-09-15** — implemented, CHK-05 verified against production, and **deployed** (`index-DFrWsv4w.js`) |
| DOC-04 | The flow chapter; feeds the guide's next revision — draft in `docs/flow-guide-draft.md` |
| ACC-04 | Investigate what consumption is already recorded, report, then decide |
| DOC-05 | **DONE 2026-09-15** — both prompts forbid markdown emphasis; versions bumped to `generate_v4` / `publication_v2` |
| ACC-03 | Dates and limits, once agreed |
| Collect the trial feedback | Then re-plan |

### Track C — later

Everything in §4, plus ACC-05 (separate TechnoAlimenti instance and billing).

---

## 8. What this document does not know

Stated plainly rather than guessed:

- **Which changes Χάρης has already made.** He has said he has begun and has not
  reported all of them. Every "TODO" above is written on the assumption that
  nothing was done; §0.2 exists to correct that before work starts.
- **Whether the reported `Collect` fix is the same as session 21's** — see §3.
- **What the final product name should be** — not invented.
- **Trial dates and consumption limits** — not set.
- **Whether `Find Names` has a real defect** — the one test produced no new
  results, which is not evidence of a malfunction.
