# Draft — the flow explained, for the user guide (DOC-04)

**Purpose:** the technical content for the guide chapter Theocharis is writing.
Ten of his eleven comprehension questions were the same question — how the
stages relate — so this walks the whole path in order and defines the status
words. Written for a plain user; Theocharis adapts and translates.

Everything below is grounded in the current code (`frontend/src/` and
`supabase/migrations/`). Facts marked *(verified)* were exercised against a
running build; the rest are read from the code.

---

## What the tool makes

One **post** and one **carousel** per publication cycle. The post is the
LinkedIn text (headline, body, CTA, hashtags). The carousel is a set of square
images (1080×1080) whose text is drawn from the same material — the carousel
*is* the images, the post is the words that go with them.

The tool produces and exports content. It does **not** publish anything to
LinkedIn, and nothing goes out without a human pressing Approve.

## The path, in order

The screens run left-to-right in the navigation bar, and that order is the
process itself. Skipping a step means the next screen is empty.

| # | Screen | What it does | What it produces |
| --- | --- | --- | --- |
| 1 | **Sources** | Collects LinkedIn posts from the organisations you follow | `raw_posts` — the unprocessed pile |
| 2 | **Settings** | The editorial direction: domain, themes, voice, anonymity | The rules every later step reads |
| 3 | **Rating** | Scores each collected post for relevance against your themes | `analyzed_posts` — scored and filtered |
| 4 | **Topics** | Anonymises company names, groups posts into themes, and **runs generation** | Clusters → a post + carousel draft |
| 5 | **Generate** | Read-only history of generation requests and the model's originals | Nothing new — it's an audit view |
| 6 | **Review** | See, edit, approve or reject each draft; download the carousel | The approved copy |
| 7 | **Export** | Download approved copy as Markdown, JSON or Word | The files you hand on |

### 1. Sources — collect

Posts are gathered from a list of company sources. "Collect now" pulls recent
posts into `raw_posts`. Nothing here is scored yet — a fresh collect will not
show up in Rating until someone presses **Score now** (see below).

### 2. Settings — the direction

Holds the editorial brief as a row: the **domain**, the **themes** (the six
topics every post is scored against), the **voice**, the anonymity rules
(which company names to hide, and how), and the minimum relevance score.

Changing these changes what the scorer and the generator do on the *next* run.
Existing scored posts and existing drafts are not retroactively rewritten.

### 3. Rating — score

Each collected post is scored 0–100 on every theme, and an overall relevance
score is derived. Posts below the minimum relevance score are excluded from
generation. This is the filter that decides what the editor will actually be
writing about.

### 4. Topics — the work happens here

This one screen runs the three remaining pipeline steps, in order:

1. **Anonymise** — company names are replaced according to the Settings rules.
2. **Cluster** — the anonymised posts are grouped into themes (the "Topics").
3. **Generate** — one post and one carousel are written from the selected
   topic(s). The button reads **"Create the carousel"**; it also creates the
   post.

The output lands in Review as a **draft** — it is not approved, not exported,
and not published.

### 5. Generate — the history

Read-only. It lists every generation request (when, by which run, what it
asked for) and shows the **model's original** output. It deliberately does not
show edits or approvals — those live in Review. If Generate and Review seem to
show different text for the same item, that is by design: Generate shows what
the model wrote, Review shows what the editor made of it.

### 6. Review — see, edit, approve

Where the editor works. Each output has one of five states (below). You can:

- **Edit** the text (headline, body, CTA, hashtags for a post; slide headings,
  bodies, caption, CTA for a carousel). Edits are saved separately — the
  model's original is always preserved and shown at the bottom of the screen.
- **Approve** or **Reject** with a private note ("why you approved or rejected
  this — visible here only").
- **Regenerate** — ask for a new draft with a note explaining what to change.
  The old draft is kept; the new one is a separate item.
- **Download the carousel** — one 1080×1080 PNG per slide, in reading order.

Only **approved** copy appears in Export by default.

### 7. Export — the hand-off

Downloads the approved, final content as Markdown, JSON or a Word document.
The default filter is `approved`. What is exported is the **edited** version
where one exists, not the model's original.

---

## The status words, exactly

Every generated output has one status. These are the only ones that exist in
the database, and this is what each means in practice:

| Status | What it means | Who/what sets it |
| --- | --- | --- |
| **draft** | The model produced it; nobody has decided yet | automatic, when generation lands |
| **approved** | A human has accepted this exact copy | an editor, pressing Approve |
| **rejected** | A human has declined this exact copy | an editor, pressing Reject |
| **superseded** | A newer draft exists that answers this one (after Regenerate) | automatic, but only ever from draft/rejected |
| **published** | Reserved for "pushed onward" downstream | *(no action in the current interface sets this — the value exists in the data model for the older legacy path; in the current flow you will normally only see draft/approved/rejected/superseded)* |

Two rules worth stating, because they explain what the screens show:

- **An approval is never revoked automatically.** If a newer draft exists, an
  approved item keeps its approval and just points at the newer one. Only a
  human can change an approval.
- **Export shows the editor's version.** `edited_output` (the editor's saved
  changes) wins over the model's original. Unsaved edits are *not* included —
  press **Save edits** before exporting.

---

## The single most common "bug" report

"What I generated doesn't match what I exported." This is not a bug:

- **Generate** shows the model's original.
- **Review** shows the editable draft (and, at the bottom, the original).
- **Export** shows the approved, edited final version.

They are three views of the same thing at three stages. The guide should state
this on the page that explains Generate, because it is the one difference
people notice first.
