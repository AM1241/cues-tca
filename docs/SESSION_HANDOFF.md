# Session handoff — CUES Editorial Cloud

Last updated: 2026-09-04 (session 20 — a carousel can be downloaded as PNG
slides, optionally over gpt-image-2 backgrounds; and the "expired" Supabase
token that blocked session 19 turned out never to have been expired at all).
Read this first, then `MIGRATION_PLAN.md`. This file is the single "where are
we" pointer between working sessions.

## Verified state at the end of session 20 (checked 2026-09-04)

| | |
| --- | --- |
| Branch | `phase6-frontend-binding`, clean, **pushed** — head `e369d16` |
| Project | `bxaovkzemfyxrxbcqask` (`cues-tca`, eu-west-1) |
| Migrations applied | through **0028** — confirmed against the live project, `migration list --linked` shows local and remote matching at 0028 |
| Edge Functions | `slide-images` **deployed this session** (new), plus `discover-brands` v6, `generate` v5, `anonymize-worker` v11, `cluster` v5, `score-worker` v10, `ingest` v9 |
| Tests | 24 offline Deno tests for `slide-images` (scripted fetch, no network) + session 19's 17 live-stack steps for the admin RPCs. Frontend `npm run build` clean. |
| Frontend | live bundle on cues-tca.netlify.app is `index-C1PbHM0E.js`, **identical to the local `npm run build`**. Netlify built in ~40s. Verified on the production URL as the real editor: the slide panel renders and all 7 thumbnails draw. |
| Sources / Reviews | Unchanged — 5 sources, 47 reviews (3 approved). MASAF still blocked from purge; no live data was altered this session. |

**The access token was never the problem, and session 19's record of it was
wrong.** `SUPABASE_ACCESS_TOKEN` lives in `frontend/.env.local`, which neither
`npx supabase` nor the MCP server ever reads — so both reported
`Unauthorized`, and session 19 concluded the token was dead and spent the whole
session working around a wall that did not exist. Passing it explicitly works:

```bash
TOKEN=$(node -e "…read SUPABASE_ACCESS_TOKEN from frontend/.env.local…")
SUPABASE_ACCESS_TOKEN="$TOKEN" npx supabase functions deploy <name> --project-ref bxaovkzemfyxrxbcqask
```

`migration list --linked` and `db push --linked` additionally need `-p "$PW"`
(`SUPABASE_DB_PASSWORD`, same file) and do **not** accept `--project-ref`.
`db push` emits a pgdelta SSL-certificate error *after* applying — that is the
schema-diff engine (`[experimental.pgdelta]`), not the migration; verify with
`migration list` rather than trusting or panicking at the exit output.

**The Phase 7 gate is closed.** MIGRATION_PLAN.md's last unchecked box —
"an editor completes collect → score → generate → approve → export on the
production URL" — asked for a human, not code. The operator did it themselves
between sessions: 3 approvals now exist where session 17 ended at zero. Checked
off below.

**Data left behind by session 16's live tests.** The cluster *"Più controlli,
più sicurezza"* now carries three generation results — the original (superseded),
a no-note regeneration, and one produced from the note *"Too soft. Lead with the
enforcement angle…"*. Real rows, visible in Review. Nothing was left approved;
`cluster_generation_results` is append-only, so removing them needs deliberate
SQL and is not obviously worth it.

~~**The corpus still carries the OLD over-replacements.**~~ **Done on
2026-09-03.** The encoding repair was applied and the corpus re-anonymised on top
of it — 81 posts, 0 failures. "Made in Italy" and the public bodies are preserved
again, and the accented brand aliases match for the first time. Full account in
Session 17 below, including what it left stale.

## Session 20 — a carousel becomes images, and the words are never drawn by a model (2026-09-04)

### What was asked for, and what the specification actually says

The operator asked to "make the carousel slides into images via GPT", believing
the original brief called for it. It does not. All 398 paragraphs of
`CUES Technical Analysis TCA.docx` were searched for
`image|visual|design|graphic|DALL|render|PNG`: it asks for *"short carousel
slide texts"* and *"Export LinkedIn-ready main post and carousel slide text"*.
Every occurrence of "image" is metaphorical (*"not by creating a polished image
of the industry"*) or refers to packaging design inside a source post.

The gap it names is real, though, and sits one step further on: a LinkedIn
carousel is **published as images** (or a PDF document), so a tool that stops at
slide text leaves the last step manual. That is what this session built.

### The one thing this must never do

Hand the slide's words to an image model. Image models still garble exact
multi-line text, so an editor would approve wording in Review and publish
something subtly different — silently breaking the guarantee the whole review
layer exists to make (0017 keeps the model's words and the editor's edit
separately answerable, forever). **The text is therefore always drawn by our own
code from the approved output, character for character**, in both variants. The
model's only job is the picture behind it.

### `frontend/src/lib/slides.ts` — the renderer

Canvas, 1080×1080 (LinkedIn's square), no dependency at all. Two variants:
`flat` (a designed gradient template) and `image` (a generated background under
a scrim). Real production copy was the test: a live carousel whose headings and
bodies are far longer than the specification's tidy example still fits, because
`fitBlock` shrinks until it does rather than overflowing.

**The scrim is what makes the image variant safe, and it took two attempts.**
The first was a uniform veil heavy enough to guarantee contrast — which also
erased the picture, so both variants rendered nearly identically. It is now
directional: dark down the left column and along the top and bottom edges where
the text and chrome sit, close to clear through the middle-right. Legibility no
longer depends on what the model happened to return.

### `supabase/functions/slide-images/` — one background, one request

`gpt-image-2-2026-04-21` (pinned snapshot, like every other model here), POST
`/v1/images/generations`, admin-gated through the shared `authenticate()`.
`_shared/openai_images.ts` is a separate client because `_shared/openai.ts`
commits itself to "Responses API, structured outputs only".

One slide per request, deliberately: generation takes 15-60s, so a
whole-carousel call would outlive any sensible function timeout and lose every
image when it tripped. Per-slide means real progress, and a failure costs one
image rather than ten.

The prompt does three things that each fix a specific failure: forbids text in
the terms models actually add it (signage, captions, watermarks), demands a
dark low-key image so the scrim stays light, and reserves the left column
compositionally because that is where the text lands. Plus no faces and no
branding — the corpus is anonymised, and restoring identity in the picture
would be absurd.

**Nothing is stored.** The image returns to the browser, which composites and
downloads. Persisting would mean a bucket, a policy, signed URLs and a cleanup
job — the trade `lib/docx.ts` already rejected. The cost of that choice, stated
plainly: regenerating is billed again.

### Two bugs found by looking at the running UI, not by reading the code

1. **Selecting "AI background image" fired all seven paid requests
   immediately**, with no click on Generate. It escaped billing only because
   the function was not deployed yet. A `variant !== 'flat'` guard inside an
   effect was not enough. `renderSlideAt` now takes the variant as an
   **argument** and the automatic path hardcodes `'flat'`, so it is
   structurally incapable of spending anything whatever the component state is.
   Verified by counting network calls: **zero** after switching the radio.
2. The first build **downloaded each slide as it rendered**, so the only place
   to look at a paid-for image was the Downloads folder, after the money was
   spent. Generate and download are now separate steps, with the slides shown
   on screen in between, click-to-enlarge, per-slide `redo`, and a free
   `Download`.

Both were caught by screenshotting the real screen with real data. Neither
would have been visible in the diff.

### Verified live, end to end

Signed in as the real editor against the deployed function: `200`, a genuine
`gpt-image-2` image in 18.5s. Nine images generated in total across testing
(seven low, two medium) for roughly **15 cents**.

Measured, so the operator can choose: **low ≈ $0.006/image, 14-19s; medium ≈
$0.053, 50-64s; high ≈ $0.211**. The default is **low**, because the scrim
darkens half the detail anyway and the difference is hard to see in the
finished slide. Official pricing is per token ($30/1M output), not per image —
these are derived figures, so confirm against the OpenAI usage dashboard after
a real run.

### A CORS trap that will bite the next person

Production `ALLOWED_ORIGINS` allows `localhost:5173` but **not** 5174/5175.
Vite silently moves to the next free port when 5173 is taken, and the symptom
is `Failed to send a request to the Edge Function` — which reads like a missing
function, not a blocked origin. Run the dev server as
`npm run dev -- --port 5173 --strictPort` so it fails loudly instead.

### Not done this session

- **No real AI carousel has been produced end to end through the live UI.** The
  function was proven live with a direct call, and the panel was proven live
  with the free variant; the paid button on the production site has not been
  pressed by anyone yet.
- `docs/` was not given a page about the slide feature; this section is the
  only record.
- The Word user guide (session 18) is now further behind — it does not mention
  slides at all.
- The Editorial brief field's wrong content, and `min_cluster_size`'s UI floor,
  remain open from session 18.

## Session 19 — Deno tests for the two admin RPCs found a real bug in one of them (2026-09-04)

Picked up the single item session 18 flagged as most worth doing next: "no Deno
test files were added for `purge_source` or `admin_delete_generation_result`."
Writing real tests against a real database is what found the bug below — neither
the live calls nor the rolled-back transactions session 18 verified with happened
to exercise the one shape that mattered.

### purge_source could never purge a real source

`purge_source()` (0026) deletes from `scoring_results` and `anonymize_results` as
part of its own documented contract — both counted in its return jsonb. Neither
table's append-only trigger (0005, 0014) has ever had an exception, for anyone,
including `SECURITY DEFINER` callers — that guarantee is what the rest of the
schema relies on. The consequence: `purge_source` raised
`"scoring_results is append-only (DELETE blocked)"` and aborted the whole
transaction the moment it reached a source that had been scored or anonymised
even once — which is nearly every real source, since a `raw_posts` insert
auto-enqueues scoring under an active production request.

**Confirmed before writing any fix**, directly against a fresh local database in
a rolled-back transaction: inserted a source, a post, one `scoring_results` row,
then ran exactly the `delete from scoring_results where raw_post_id = any(...)`
statement `purge_source` itself runs. It raised immediately.

Every prior verification of `purge_source` (0026's own commit history) happened
to purge Tecnoalimenti, which had zero citations *and*, apparently, no
`scoring_results`/`anonymize_results` rows at the moment each test ran — so the
gap was never exercised. **Today, purging MASAF to unblock it — the operator's
actual stated goal — would have hit this exact error**, not the citation refusal
0026 documents; 71 scored posts, not 18 cited ones, would have been the first
wall.

### The fix — `0028_purge_source_append_only_fix.sql`

Mirrors 0027's own approach exactly, on the two tables 0027 left alone: a
transaction-local flag (`cues.allow_purge_delete`, distinct from 0027's
`cues.allow_result_delete` so each flag maps to exactly one calling function on
exactly the tables it may touch), set once by `purge_source()` itself immediately
before its ordered deletes, checked by both triggers. `UPDATE` stays blocked
unconditionally for everyone, always, on both tables — only this one `DELETE`
path, from this one function, is exempted.

**Proven to be the actual fix, not just plausible**: with 0028 removed and the
database reset to 0027, the new "clean purge" test (below) fails with exactly
`anonymize_results is append-only (DELETE blocked)` — the same error found by
hand above. Restoring 0028 and resetting again turns it green. This is the
regression test for the bug, not just a test that happens to pass.

**Not applied to the live project.** `bxaovkzemfyxrxbcqask` is still on 0027.
Applying 0028 is the operator's call — see "Pending" below.

### The tests — `supabase/functions/_admin_rpcs/__tests__/`

New directory (underscore-prefixed, like `_shared`, so the Supabase CLI does not
try to deploy it as a function — these two RPCs have no Edge Function handler of
their own; the frontend calls them directly via PostgREST RPC, so the tests do
too, through per-role **authenticated** clients built the same way
`ingest/__tests__/handler_test.ts` already does it: a real Auth user, signed in
for real, `is_admin()`/`is_editor()` reading a real `auth.uid()` — never the
service-role key, which the RPCs would see as neither).

`fixtures.ts` holds what both suites share: building a real scored → promoted →
anonymised → embedded → clustered post. Every table on that path
(`scoring_results`, `scoring_job_state`, `scoring_dead_letter`,
`anonymize_results`, `anonymize_job_state`, `anonymize_dead_letter`,
`post_embeddings`, `clustering_runs`, `clustering_run_posts`, `clusters`,
`cluster_generation_requests`, `cluster_generation_results`) grants
`service_role` **SELECT only** — confirmed by grep across every migration before
assuming otherwise — so every fixture row is built through the same
`SECURITY DEFINER` RPCs the real score-worker/anonymize-worker/cluster functions
use, never a raw insert.

`purge_source_test.ts` (6 steps): both auth-gate rejections, not-found, the
citation-block refusal (asserts the message names the blocking `cluster_label`,
`result_id`, and `"approved":true`, and that nothing was touched), and the
clean-purge regression test — a source with three posts covering every path
`purge_source` claims to clear (full success chain including
`clustering_run_posts`; scored-then-anonymize-dead-lettered; scoring-itself-
dead-lettered) plus an `ingest_run_sources` row, asserting both the returned
jsonb counts **and** that every one of those tables is actually empty afterward,
including the `post_embeddings` cascade off the `anonymize_results` delete.

`admin_delete_generation_result_test.ts` (8 steps): both auth-gate rejections,
not-found, a clean draft delete, an **approved** delete (`was_approved: true`),
and — the two pointer-clearing paths kept genuinely separate because they clear
different columns in different directions — deleting an *older* result clears a
newer regeneration's `cluster_generation_requests.regenerates_result_id` back-
reference to it, while deleting a *newer* result (one recorded via
`supersede_generation_review` as replacing an older draft) clears the older
review's `superseded_by_result_id`. Also re-verifies, now as a permanent
regression test rather than a one-off finding, session 18's "welcome surprise":
a raw `UPDATE`/`DELETE` on `cluster_generation_results` fails at the **grant**
level (`service_role` has no such grant at all) before the append-only trigger
would even run.

All 17 steps pass together in one run; see the run transcript pattern in
`score-worker/__tests__/handler_test.ts`'s own header for how to invoke —
same `docker run` shape, targeting `_admin_rpcs/__tests__/` instead.

### A Windows/Git-Bash trap, worth adding to every test file's own header

The `docker run -v "$PWD/...":/app -w /app ...` invocation documented at the top
of every existing test file **does not work as written** from Git Bash on this
machine: `$PWD` and the bind-mount path get silently mangled by MSYS path
conversion, and Docker fails with `the working directory '.../app' is invalid`.
Fix: prefix the command with `MSYS_NO_PATHCONV=1` and use `$(pwd -W)` (a real
Windows path) in the volume mount instead of `$PWD`. Not yet propagated into the
other test files' own header comments — worth doing in a pass if this keeps
tripping people up.

### Not done this session

- **0028 was not applied to the live project.** Purging MASAF for real still
  needs both this migration applied there and the operator deleting its 3
  approved + 15 draft citing results first (unchanged from session 18).
- **Nothing was committed or pushed.** `0028_purge_source_append_only_fix.sql`
  and the three new files under `_admin_rpcs/__tests__/` are new, untracked.
- **The Supabase MCP server had no valid access token this session** —
  `execute_sql` returned `Unauthorized. Please provide a valid access token`.
  Worked around by using the local Docker stack instead (which is the more
  correct tool for writing/running a real test suite anyway), but the token in
  `.mcp.json`/the environment is worth checking if quick live SQL is needed
  next session.
- The other three items from session 18's own "not done" list (the Editorial
  brief content, the stale Word user guide, `min_cluster_size`'s UI floor) —
  untouched, not in scope this session.

## Session 18 — an admin tier, a real delete on both sides, and an Objective screen that says where it goes (2026-09-04)

Ten commits, walking through an operator's actual use of the product rather
than a planned feature list — most of this started as a question ("can I
delete a source?", "why did this say 0 when it clearly ran?") that turned up a
real gap once it was chased down.

### A user guide exists, but is not in git

Before the code work: a full Word document was generated — cover page, one
section per screen, step-by-step instructions, 14 screenshots taken from the
live production site with a real login (Playwright, not mockups) — and sent
directly to the operator, with a copy left on their Desktop. It is not a repo
artefact and carries no version history here.

**It is already slightly behind** everything below: it documents the nav order
before the reorder, the Sources form before the admin lock and the URL/address
merge. Worth a short refresh pass before it is handed to anyone else, not a
blocker for anything in this file.

### Nav bar reordered to match the pipeline (`c40e78e`)

Was Posts, Sources, Objective, Clusters, Generate, Review, Export — build-date
order. Now **Sources, Objective, Posts, Clusters, Generate, Review, Export**,
matching CLAUDE.md's own pipeline description, and the post-login landing route
moved from `/posts` to `/sources` for the same reason: the first thing done
with this tool is collect, not read scores that do not exist yet.

### Sources gets an admin tier (`0025_source_admin_lock.sql`, `03b221f`)

`editors.role` (`'editor'` | `'admin'`) has existed since the very first RLS
migration and had never been read by anything — every editor had identical
privileges. `is_admin()` mirrors `is_editor()`; creating a source and changing
its name/url/type/company_name/collection address is now admin-only.
`lookback_days` and the enabled toggle stay open to every editor, on the
operator's explicit instruction — pausing or resuming collection is routine
operation, not configuration.

RLS cannot express "any editor may update these two columns, only an admin may
touch the rest" on its own: editor and admin both map to the Postgres role
`authenticated`, so there is no column-level GRANT to lean on the way
`cluster_generation_reviews` does for the service_role/authenticated split. A
`BEFORE UPDATE` trigger does the column check instead, and rejects outright —
not silently reverts — anything outside the two allowed columns for a
non-admin. **Verified: 6/6 scenarios inside a rolled-back transaction**
(non-admin insert rejected, non-admin protected-column update rejected,
non-admin lookback+enabled update succeeds, and the same three checks for
admin succeeding) before being applied, then the admin path re-verified
against the live API.

**The non-admin frontend branch (a lookback-only edit form, "Add source"
hidden) was never seen live.** There is only one real account, and downgrading
it — even briefly — to see the non-admin UI risked interfering with the
operator's own concurrent use of the tool, so it was skipped deliberately. The
code path is simple, deterministic React (`isAdmin ? fullForm : lookbackOnly`)
and was read carefully, not just written.

### URL and the collection address became one field, on request

The operator's ask: stop showing "RapidAPI" — it names the vendor behind
collection, which should not be visible — and stop asking for the same value
twice. **Checked before merging anything**: `url` and the field that actually
drives collection are byte-identical for 3 of 5 real sources, but **MASAF and
Fratelli Branca Distillerie genuinely need them to differ** (a posts-feed URL
for a human vs. the bare company page the collector needs), proven against the
live provider in an earlier session. A blind merge would have broken both
silently.

Shipped instead: one visible field ("URL"), plus a collapsed "Collect from a
different address (rare)" field — never named after the vendor — that defaults
empty (meaning "same as URL") and is pre-expanded only when editing a source
that already has a real override. Functionality for the two sources that need
it is unchanged; the common case is one field, not two.

A list-row note surfacing this divergence to admins was added, then removed
one message later on the operator's ask (`52e4abf`) — it is still visible and
editable in the Edit popup, just not cluttering the list.

### Why Tecnoalimenti said 0 when it had just run successfully

The operator added Tecnoalimenti as a 5th source (closing a gap flagged
earlier: the original specification names 5 sources, only 4 existed) and hit
three real things in one sitting, all now fixed:

1. First `Collect` attempt: `skipped`, `no_rapidapi_identifier` — the field
   was labelled **"(optional)"** although ingest skips a source outright
   without it. Fixed by the field merge above; the field that drives
   collection is no longer separately labelled at all.
2. Second attempt: `ok`, 46 posts fetched, **0 inserted** — all 46 were older
   than the 30-day lookback. `last_fetched_at` still updated, because it
   stamps "the provider round-trip succeeded," not "something new arrived" —
   confirmed against `stamp_source_last_fetched()` (0007), which fires on
   `status = 'ok'` regardless of post count.
3. The toast never said *why* it was 0 — `posts_skipped_out_of_window` was
   already in the ingest response and simply was not surfaced. Fixed: the
   toast now reads e.g. `"0 new, 46 outside your lookback window"`.

Widening the lookback on a third attempt got 3 real posts in. All three fixes
are in `frontend/src/routes/Sources.tsx`.

### `discover-brands` (Find Names) now respects the source's own lookback (`5a5b35d`, deployed as **v6**)

It read the N most recent posts ever collected, unbounded by date — a source
with a long history could surface brand names from copy far outside anything
currently being collected. Now bounded by `sources.lookback_days`, the same
window `Collect` itself uses, applied as a `.gte('published_at', …)` filter
before the existing sample-size cap.

**Verified live, both directions**: European Commission (15-day lookback) now
reads exactly the 20 posts inside that window. Fratelli Branca and
STAR/GBfoods currently have nothing published inside their windows and
correctly return the existing empty result at zero cost — not a bug, the
direct and correct consequence of the fix.

### An admin can permanently delete a source (`0026_purge_source.sql`, `09dff8e`)

0002 shipped deliberately with no DELETE path for `sources`:
`raw_posts.source_id` is `ON DELETE RESTRICT`, and nine tables read from
`raw_posts`, so any source with real history is load-bearing. The operator's
need was real and distinct from disabling: a source added by mistake, or one
that should genuinely leave no trace.

Before writing anything, every FK touching `raw_posts` and `anonymize_results`
was mapped against `pg_constraint` — a mix of `CASCADE` and `RESTRICT` in an
order that matters (`clustering_run_posts` restricts on *both* and must be
cleared first; `anonymize_results` before `raw_posts`; the remaining
`RESTRICT` children after). `purge_source()` follows that exact order inside
one transaction.

**The one check nothing in the schema can enforce on its own**:
`cluster_generation_results.raw_post_ids` is a plain `uuid[]`, because Postgres
cannot put a foreign key on an array element. That is precisely the reference
that matters most — it is the traceability behind copy an editor may have
already approved. `purge_source()` checks it explicitly and **refuses
outright** if any of the source's posts are cited by a generation result,
naming which results and whether any are approved, rather than silently
orphaning a citation nothing else could have caught.

**Verified: 6 scenarios inside a rolled-back transaction** — non-admin
rejected; admin blocked from purging MASAF (71 posts, 18 citations, 3
approved, all named in the refusal); admin cleanly purging Tecnoalimenti (0
citations) with every one of the 9 touched tables confirmed empty afterward —
then the MASAF refusal re-verified live against the real API, full message
included in this file's own history (`09dff8e`'s commit body). **Not actually
applied to any real source** — every test ran inside `begin; … rollback;`.
Today, only **European Commission** and **Tecnoalimenti** have zero citations
in generated copy and could be purged without a refusal; the other three all
currently would be blocked.

Frontend: a red "Delete" per row, admin-only, opening a confirm dialog that
states the consequence and offers the enabled toggle as the reversible
alternative before the destructive one.

### An admin can permanently delete one generated result, even an approved one (`0027_admin_delete_generation_result.sql`, `3bb87be`)

The direct follow-on from the above: `purge_source`'s refusal on MASAF names
copy that blocks it, three pieces of it approved, and there was no way to act
on that on purpose. `cluster_generation_results` has been append-only by
trigger since 0016, no exception, for anyone — and session 16 built "an
approval is never revoked" on that same premise. Both govern what the
**system** does automatically (regeneration, re-scoring); the operator asked
for a deliberate **admin** action instead, and confirmed explicitly — asked
directly, given what it means — that it should work even on an approved
result.

The trigger now allows exactly one exception: `DELETE` when a
transaction-local flag (`cues.allow_result_delete`) is set. Nothing reachable
from PostgREST can set that flag — only `admin_delete_generation_result()`
does, immediately before the one delete it performs, scoped to that
transaction alone. `UPDATE` stays blocked unconditionally, for everyone,
always. Pointers *from* elsewhere *to* the deleted result
(`regenerates_result_id`, `superseded_by_result_id`) are cleared rather than
blocking the delete or being left dangling — losing "this was a regeneration
of X" is an acceptable trade against the alternative of the feature being
useless for exactly the case it exists for.

**Verified inside a rolled-back transaction**, including a rigged scenario
built specifically to prove the pointer-clearing *fires* rather than merely
not erroring (no real row happened to have one at test time, so one was
planted): non-admin rejected; a draft deleted cleanly; an **approved** result
deleted cleanly (`was_approved: true` correctly reported); both planted
dangling pointers confirmed nulled; a raw `UPDATE` and a raw `DELETE`
bypassing the RPC both still rejected — at the **grant level**, before the
trigger even runs, a second layer of defence that was not deliberately added
and was a welcome surprise on discovery; the other two approved results
confirmed untouched throughout. Re-verified live with a nonexistent UUID
(clean 404-style rejection, proving the function is reachable and gated).

Frontend: a visually separated red "Danger zone" at the bottom of Review's
detail pane, admin-only, with its own confirm dialog that names the result and
warns explicitly when deleting it will remove it from Export.

**Nothing has actually been deleted with either RPC.** MASAF's 3 approved
citations and 15 drafts are all still exactly where they were; deleting them
to actually unblock a source purge is the operator's call, one row at a time,
whenever they choose to make it.

### Objective reorganised around what each setting actually reaches (`31041c0`)

The operator's read: eleven flat sections gave no indication of where a change
landed. Fixed by reading the actual prompt-builder code — grep, not memory —
before touching any UI, to map every field precisely:

- `score-worker/prompt.ts` substitutes only `{{DOMAIN}}` and `{{THEMES}}`.
- `cluster/prompt.ts`'s `buildBrief` reads the same two.
- `generate/prompt.ts` reads domain, themes, and all three voice fields.
- `anonymize-worker` reads the two `domain_generic_entity` fields, the three
  toggles, `company_aliases`, and — the one field that reaches two screens —
  `min_relevance_score`, via `backfill_anonymize_jobs` defaulting to it when
  called with `null`.

Regrouped into four numbered stages, each carrying which screen(s) it reaches
as a coloured badge using the nav bar's own names: **Scope** (Domain, Themes →
Posts, Clusters *and* Generate, honestly, since all three genuinely read them),
**Deciding what's relevant** (Relevance threshold, Scoring engine → Posts —
the threshold's hint now says it gates Clusters too, not generation alone),
**Anonymising and grouping** (the two Anonymised-wording fields moved out of
"Editorial scope," where they had no functional connection, into here where
they are actually read; Anonymisation toggles; Company and brand names;
Clustering → Clusters), **Writing the final text** (Tone, Audience, and the
renamed brief field → Generate).

**"Style" is renamed "Editorial brief" and upgraded to a textarea.** It was
never a stylistic descriptor: `generate/prompt.ts` reads
`config.voice_style` as *the* main brief text, falling back to a
domain-derived sentence only when blank. **Confirmed live, and left as a
finding rather than fixed**: the field's current stored value is *"Find posts
most relevant to the current editorial objective"* — a scoring-sounding
instruction sitting in the one field that should say what the publication is
actually about. The content is the operator's call.

Verified visually against a local `vite preview` build on real production
data before deploying, not just compiled — every stage header, the moved
fields, and the renamed textarea confirmed by screenshot.

### Scoring model is a closed dropdown, not free text (`a666e41`)

"Model" and "Pinned build" were two plain text inputs. Pinned build is not
cosmetic: `score-worker` sends `request.model_snapshot` to OpenAI as the
literal model parameter on every scoring call, copied from this field the
moment a scoring request opens. A typo there does not fail on save — it fails
quietly on every score afterwards.

Confirmed there is exactly **one** model this pipeline's own code ever calls:
`gpt-5.4-nano-2026-03-17` is hardcoded as the default in `score-worker`,
`anonymize-worker`, `cluster`, `generate` and `discover-brands` alike.
Replaced the two fields with one dropdown carrying that one pair — same
reasoning already applied to "Combining theme scores" next to it: a closed
list of one real option today, so a second is a visible choice later rather
than free text now. A stored value that does not match the known list (from
before this shipped, or written directly in the database) is shown labelled
"not a standard option," never silently swapped for the first real one.

Verified against a local preview build on real data: the live value
(`gpt-5.4-nano-2026-03-17`) selects cleanly with no fallback warning.

### Clusters explains a 0-cluster run instead of hiding the button

Answers an operator question directly: with 1 eligible post, a cluster can
never form regardless of settings (`groupBySimilarity`, `cluster/grouping.ts`,
needs at least `min_cluster_size` — default 2 — similar posts to keep a
group). With exactly 2, it depends on whether their cosine similarity clears
the configured threshold (default 0.75); if not, both become "unclustered."
Either way, the "Create the publication" panel used to simply not render, with
no explanation.

Now states the three distinguishable cases (zero embedded / exactly one /
several but not similar enough) with a concrete next step. **Verified against
a real run already sitting in history, not a synthetic one**: a local preview
build against production data found a genuine 0-cluster run (7 posts
embedded, all still "unclustered"), and the new message renders exactly as
intended against it.

### Not done this session, worth naming

- **No Deno test files were added for `purge_source` or
  `admin_delete_generation_result`.** Both were verified exhaustively but only
  via rolled-back SQL transactions and live API calls in this conversation,
  not committed, repeatable test suites. Given both are destructive,
  admin-only, and now load-bearing for how the operator plans to unblock
  MASAF, they are strong candidates for real coverage next.
- The user guide Word document was not refreshed to match the nav reorder,
  the admin lock, or the URL/address merge.
- `min_cluster_size`'s UI floor stayed at 2 even though the database itself
  permits `>= 1` (`0014`'s own CHECK constraint) — noted, not changed; a
  1-post "cluster" is arguably not a cluster at all, and nobody asked for it.
- The Editorial brief field's evidently-wrong content was flagged, not fixed.
- Deploys were unusually slow twice this session (one push took ~20 minutes
  and needed an empty-commit nudge before it landed; another took ~140s where
  every other deploy all session took ~20s) — Netlify-side, not code; GitHub
  showed no commit status for either push, and this environment has no
  Netlify CLI/dashboard access to see why. Worth a glance at the Netlify
  dashboard's own deploy log if it keeps happening.

## Session 17b — the output shape was wrong, and now is not (2026-09-03)

### The finding

The operator read the finished work and said the result was not what had been
asked for. They were right, and it took reading the **original specification**
to see why — `CUES Technical Analysis TCA.docx`, one directory above the repo.

**That document is referenced nowhere in this repository.** Every "TCA" in the
tree is a project, repo or hostname. `MIGRATION_PLAN.md` scopes the work as
*"moving `cues-tca-editorial-agent` to Supabase, and fixing the things that make
the current system expensive to operate"* — so the reference point was always the
**legacy Python app**, never the requirement it was supposed to implement. The
Phase 5 contract even calls `newsletter` and `post+carousel` *"legacy Phase-0
sketch values"*: the specified deliverable was treated as an early sketch.

### What the specification actually asks for

One LinkedIn publication per cycle: a main post plus a carousel **whose slides
are the themes**. Its own worked example is titled *"Beyond stereotypes: a new
story for the food industry"*, and its seven slides run opening → innovation →
sustainability → traceability → heritage → Europe → closing.

Clustering is step 4 of 8 there. It is the skeleton of one narrative, not a way
of splitting the output.

What had been built generated a post and a carousel **per cluster**. Session
17's run produced 8 clusters, so it produced **16 unrelated drafts** and asked an
editor to pick. One story with seven chapters had become sixteen stories.

### Two smaller gaps found in the same reading

- **A source is missing.** The specification lists five; `sources` holds four.
  Absent is **Tecnoalimenti / TCA** — described there as supplying *"highly
  relevant content on sustainability, circular economy, bioplastics, regenerative
  agriculture, food safety, traceability and innovation"*. It is both the most
  on-brief source and the organisation the copy is written for. Not fixed here.
- **The themes do not match.** `European institutional context` is missing;
  `talent_development` is configured and appears nowhere in the specification.
  That is not idle: it is the theme that admitted an EU traineeship ad at 95 in
  session 14, and it produced the cluster *"Formare i talenti per l'agrifood"* in
  session 17's run. Not fixed here — it is an editorial call.

### What was built — `0024_editorial_publication.sql`

A publication is **another `cluster_generation_results` row**, not a new table.
Review, Export (Markdown/JSON/Word), regenerate-with-feedback and the append-only
version history all key on `result_id` and none of them care what a result is
*about*; a separate table would have meant reimplementing four mechanisms that
already work in production. Proven rather than assumed: the first publication
seeded its two review rows through the existing after-insert trigger, untouched.

The cost, stated plainly: `cluster_id` is no longer NOT NULL, so the table holds
two shapes. Two CHECK constraints make them mutually exclusive and total, and all
three malformed shapes were verified rejected before the migration was applied.

Three things had to change that were written assuming one outcome per cluster:

- `create_cluster_generation_request` gains `kind`/`period_start`/`period_end`.
  **Dropped and recreated, not replaced** — defaulted parameters create an
  overload, and the five-argument call would then be ambiguous. 0023 recorded
  this same trap; it was hit again here and caught by re-reading 0023.
- `finish_cluster_generation_request` raised when results + errors did not equal
  the cluster count. A publication owes exactly one outcome however many clusters
  it drew on, so it now counts by `kind`. Without this it would have raised
  *after* the LLM was paid for and the text stored.
- `cluster_generation_request_errors.cluster_id` becomes nullable, with
  `record_publication_error` for a failure that belongs to no single cluster.

### The generation itself

`generate` takes `kind: "publication"` and makes **one** call over all themes.
Structurally unlike the per-cluster loop, deliberately: there, one cluster's
failure never aborts its siblings, because each draft stands alone. Here the
whole point is that the themes are argued together, so there is no half a
publication — it produces its one text or it fails.

- Carousel length is `2 + themes`, capped at **8 themes / 10 slides**; past that
  the last themes are read by nobody. Which themes survive (largest first) is
  recorded in `source_cluster_ids`, so the choice is auditable.
- The validator asserts the exact slide count. A publication that quietly drops
  a theme still reads like a finished piece — nothing in the copy announces that
  a selected theme never made it in.
- The period comes from the **request row**, not the caller, so a text can never
  claim a window nobody asked for. The UI passes the clustering run's own
  period for the same reason: a narrower window would put posts in the text that
  fall outside the period it claims.

**Verified live.** 8 themes → 10 slides, opening + one per theme + closing, 19
posts behind it, request `completed`, 2 review rows seeded, `publication_v1`.
13 offline tests, 20 passing in `generate/__tests__/`.

### Per-cluster generation is hidden, not removed

`frontend/src/lib/features.ts` → `PER_CLUSTER_GENERATION = false`, on the
operator's instruction: it may return as a deliberate feature. Nothing behind it
was deleted. The Edge Function still accepts `kind: "per_cluster"`, the RPCs
still work, the old three-argument call still behaves identically
(regression-tested), and all 21 previous results and 41 reviews are still in the
database. Review and Export filter to `kind = publication` **through the same
flag**, so one constant restores the old UI whole.

The embedded-column filter was verified against the live API rather than
assumed: unfiltered returns 43 review rows (41 per-cluster, 2 publication),
filtered returns 2.

### The Posts empty state lied, and it made a working button look broken

The operator collected 42 real posts (verified: `ingest_runs` 13:21:39,
`posts_inserted: 42`, `error: null`, all four sources OK) and then reported
"Collect now didn't work." It had. Posts told them otherwise.

The new default-window empty state (above) said *"Nothing was published in the
last 15 days"* whenever `analyzed_posts` had no rows in the window — but Posts
only ever shows `analyzed_posts`, never `raw_posts`. The 42 new posts were
sitting in the scoring queue, correctly enqueued by the insert trigger, simply
not scored yet. 23 of them fall inside the 15-day window. The message conflated
"not yet scored" with "not published", and told the operator the opposite of
what was true.

Fixed by counting `raw_posts` in the window with no `analyzed_posts` row at all,
and giving that case its own message ahead of the "nothing published" one:
*"N posts collected in this window, not yet scored"*, with a **Score now**
button right there — the same action already on this screen, now reachable from
the exact place that made the button seem missing.

**A trap in building the counter, worth recording because it fails silently.**
The natural query — filter a to-one embed by its own id column,
`analyzed_posts.id=is.null` — is accepted by PostgREST without error and
silently ignored: it returns the same row count as no filter at all. Proved by
testing both `is.null` and `not.is.null` on `.id` and getting the *same* count
back from each — the filter was doing nothing. The form that actually works
filters the **embedded object itself**: `analyzed_posts=is.null`. Confirmed
against the live API in both directions (`is.null` → 23, `not.is.null` → 0,
`!inner` with no filter → 0 — three independent checks agreeing) before it went
into the code.

### Posts opens on a window, not the whole archive

The screen fetched every analysed post ever, then filtered in the browser. It now
takes a **period**: a days box defaulting to **15**, and an **All** button. The
period filter is applied in the QUERY (`raw_posts.published_at`, through the
`!inner` embed) rather than to rows already downloaded — the corpus only grows,
and source/score/included stay client-side because they narrow what is already
there.

**With today's data the default window is empty, and that is correct.** Nothing
has been collected since 2026-07-23, 42 days ago, so "the last 15 days" holds
zero posts. Verified against the live API: 15 days → 0 rows, 90 days → 73,
all → 180, matching the SQL counts exactly.

A bare "no posts match the current filters" would read as a broken screen, so the
empty state names the cause instead — how stale the corpus is, and a one-click
**Show all posts**. The newest date comes from its own tiny query, because a
query that matched nothing cannot report it.

Two smaller decisions worth keeping: the days box does not blank the table while
it refetches (it fires per keystroke, and a spinner each time costs the editor
their scroll position — the old rows dim instead), and the value is clamped to
1–90 rather than rejected, matching `sources.lookback_days`.

### Where this leaves the product

Deployed and verified: live bundle `index-qqNChnQe.js`, byte-identical to the
local build and carrying the publication UI. Review now shows **two rows** — the
publication's post and its carousel, both `draft`, both covering 2026-08-20 to
2026-09-03 with 19 posts behind them.

**Still zero approvals.** Unchanged by any of this, and still the one open gate:
it needs an editor, not a run. What is different is that there is now one text to
approve rather than sixteen to choose between.

Two gaps found in the specification reading and deliberately NOT closed, because
both are editorial calls rather than code:

1. **Tecnoalimenti / TCA is missing from `sources`.** Five sources specified,
   four configured.
2. **`talent_development` is configured and unspecified; `European institutional
   context` is specified and unconfigured.** Fixing this changes which posts
   pass the threshold, so it invalidates clusters and copy downstream — cheap to
   do, not cheap to do casually.

## Session 17 — Ε is diagnosed: the encoding damage is not an ingest bug (2026-09-03)

### It was never ingest

Split the 180 posts by how they arrived and the answer is immediate:

| | posts | carry non-ASCII characters | carry `?` inside a word |
| --- | --- | --- | --- |
| migrated from Phase 1 (`legacy_id` set) | 133 | **0** | 105 |
| collected by the `ingest` function | 47 | **47** | **0** |

Ingest's posts are perfect — `🚨`, `¡Enhorabuena, España! 🏆🇪🇸`. The migrated
rows contain **not one byte above 127**. The damage happened once, on
2026-07-22, and cannot recur through the pipeline. Everything filed under
"encoding corruption at ingest" since session 9 pointed at the wrong component.

### Where it happened, exactly

The migration chain was walked link by link, and only the last one is damaged:

1. `migration-backups/phase1/legacy_snapshot_2026-07-22.db` — **clean**, 132 of
   133 posts carry valid UTF-8.
2. `DO_NOT_RERUN_load_legacy_2026-07-22.sql` — **clean**, 10,681 non-ASCII bytes.
3. Postgres — **damaged**.

So it broke in the apply step, which §5 of the runbook specified as:

```powershell
Get-Content ./load_legacy.sql -Raw -Encoding UTF8 | docker exec -i … psql
```

`Get-Content -Encoding UTF8` decoded correctly. **The pipe did not.** Windows
PowerShell 5.1 re-encodes text entering a native command using `$OutputEncoding`,
which defaults to **ASCII**, and the replacement fallback emits a literal `?` for
everything else — one per UTF-16 **code unit**, so `è` → `?`, an emoji → `??`,
and a flag emoji → `????`. Reproduced directly: `"a"+"è"+"😀"+"b"` encoded ASCII
round-trips to `a???b`.

Because ASCII survives, the load reported `COMMIT`, §6's row counts and orphan
checks all reconciled, and nothing looked wrong until somebody read the Italian.
**Every reconciliation step in the runbook counts rows; not one of them looked at
a character.** §5 now uses `docker cp` + `psql -f` and carries the warning, plus a
check that a multilingual corpus reporting zero multi-byte rows is a failure.

Applying the model to all 133 rows and comparing against the snapshot:
**133/133 match exactly.** Not inference — measurement.

Two independent confirmations:

- **The hashtags survived** — `#FlorDeCaña`, `#AprèsSki`, `#dentrocèlitalia` are
  intact in Postgres today. The legacy system stored them as JSON with `ñ`
  escapes, which are themselves ASCII, so the pipe had nothing to destroy. Only
  literally non-ASCII bytes died.
- **`editors.full_name` is fine.** It reads `Χαρίσιος Ζαφείρης`. The session-13
  walkthrough listed it as corrupted; that was a terminal that could not print
  Greek, not stored damage. **That line was wrong and is withdrawn.**

### What is actually damaged

| table.column | damaged values |
| --- | --- |
| `raw_posts.post_text` | 132 |
| `raw_posts.author` | 46 (all the same value: "Sovranit**?** alimentare") |
| `normalized_posts.clean_text` | 132 |
| `editorial_assets.generated_text` | 15 |
| `traceability_links.claim_text` | 3 |
| **total** | **328** |

Everything else the loader wrote is clean. `analyzed_posts` and `configurations`
differ from the snapshot for the ordinary reason that sessions 14–15 replaced
them; `sources` differs by the deliberate 0004 GBfoods→STAR repoint.

### The repair is offline and costs nothing

The clean text is still on disk, so this needs no re-scraping, no provider quota
and **no LLM calls**. `scripts/build_encoding_repair.mjs` emits 328 UPDATEs, each
guarded on the md5 of the damaged value — idempotent, inert against anything not
in the exact expected damaged state, and a no-op on a correctly loaded database.

**Verified against production inside a transaction that was rolled back:**
503 values byte-identical to the clean snapshot, **0 mismatches**, and the
database confirmed unchanged afterwards. The script in the repo was then checked
to emit that exact statement set.

`content_hash` is `generated always as (md5(post_text))`, so it corrects itself.

### Applied, on the operator's go-ahead (2026-09-03)

**328 UPDATEs applied to `bxaovkzemfyxrxbcqask`. Verified after the fact:
503 values byte-identical to the clean snapshot, 0 mismatches.** The 14 posts
that still contain a `?` are the 14 that genuinely contain one in the snapshot.

Then, in the same sitting and through the real editor path (signed in as the
allowlisted editor, PostgREST RPC + function invoke — not service_role):

- `requeue_anonymisation()` → **89 requeued**
- backfill enqueued **81** — not 89. The eight left behind are scored 0–45 and no
  longer clear the threshold of 50, so they are not eligible. See below.
- drained in four batches of 25 → **81 anonymised, 0 dead-lettered, 0 errors**,
  about two minutes of wall clock on `gpt-5.4-nano`.

Measured afterwards:

| | |
| --- | --- |
| anonymised posts carrying real accents | 80 of 81 (the 81st is the one pure-ASCII post) |
| anonymised posts still carrying `?` damage | **0** |
| posts leaking any of the 18 brand aliases | **0** |
| `Made in Italy` correctly left alone | 21 posts |
| `MASAF` correctly preserved as a public body | 12 posts |

**The accented aliases now work, and this is the proof the repair mattered
beyond cosmetics:** `Niccolò Branca` appears in 3 raw posts and `Caffè Borghetti`
in 1; **zero** anonymised posts contain either. Against `Niccol? Branca` those
aliases could never have matched.

### Two things this left behind, both worth knowing

**Eight posts dropped out of the anonymised set.** `requeue_anonymisation` clears
`current_result_id` for everything, but the backfill only re-enqueues what is
currently eligible. These eight were anonymised back when they qualified and have
since been re-scored below 50. Their `anonymize_job_state` still reads
`dead_letter` — that is the *mechanism* requeue uses, not a failure; they carry no
error message. Clusters shows them under **"Not yet anonymised"**, which is
honest, though the `dead_letter` badge reads worse than the truth.

**The over-replacement long tail is real and now measurable.** 58 distinct
entities were replaced. Every class session 16 set out to fix is gone — no
`Made in Italy`, no `Cabina di Regia`, no `AGEA`, no `Australia`, no
`6,2 milioni di euro`, no `associazioni di categoria`. What remains, on a manual
read of the 58, is roughly a third that are not companies: trade fairs
(`Vinitaly 2026`, `Veronafiere`, `Fieracavalli`, `Salone del Vermouth`), events
(`Fuori Salone`), venues (`Museo del Risorgimento`, `Bar Cavour`), TV programmes
(`Domenica in`, `Zecchino d'Oro`), associations (`Federazione Apicoltori
Italiani`), a person (`Al Bano`), **a horse breed (`Lipizzano`)**, and
**`COLTIVAITALIA`, a government funding package** — that last one corrupts a
fact the way the session-16 cases did. This is the limitation session 16
documented as "left to the prompt"; it is no longer an estimate.

### Re-anonymisation invalidated everything downstream

74 of the 75 posts that had a previous anonymisation came back with **different
text**, so every derived layer described copy that no longer existed —
90 embeddings, 21 clusters, 13 generation results. All rebuilt in the same
sitting; see below. Recorded because the dependency is the point: **anything
that re-runs anonymisation invalidates embeddings, clusters and generated copy,
in that order.**

### Re-clustered and re-generated (2026-09-03, same sitting)

The operator approved the spend, so the derived layers were rebuilt on the
repaired text. Both runs went through the editor path, not service_role.

**Nothing had to be invalidated by hand.** `post_embeddings` is keyed on
`(anonymize_result_id, model)`, not on the post — and re-anonymisation wrote new
`anonymize_results` rows, so every post simply had no matching embedding and was
re-embedded. That design decision paid for itself here.

`cluster`, window 2025-06-01 → 2026-09-01 (the same window as the previous run,
so the two are comparable), run `20009874`:

| | |
| --- | --- |
| eligible / embedded / failed | 81 / 81 / **0** |
| clusters | **8** (19 posts assigned, 62 unclustered) |
| labels carrying `?` damage | **0** |

The labels are the first real evidence the whole chain is clean: *"Controlli e
tutela dell'olio: regole, **qualità** e trasparenza"*, *"Formare i talenti per
**l'agrifood**"*, and — the one that matters — *"Controlli che proteggono il
**Made in Italy**"*. That phrase was being replaced by the generic entity until
session 16; it is now a cluster name.

`generate`, all 8 clusters, both output types: **8 results, 0 errors**, each
carrying a post and a carousel, all with real accents, **0 damaged**, and a
sweep for all 18 brand aliases finds **0 leaks in the generated copy**. The copy
names *"Cabina di Regia"* and *"Made in Italy"* directly — both previously
corrupted into "another food-sector organization", so the session-16 fixes are
demonstrably reaching the final output an editor reads.

Totals now: 21 generation results, 41 reviews, 38 of them `draft`.

**Still zero approvals.** That remains the one open gate on the product, and it
is unchanged by any of this work: it needs an editor, not a run.

### Deployed

`git push` was refused twice by the environment's permission layer and succeeded
on the third attempt — transient, as the first refusal said it usually is. Worth
knowing for the next session: a refusal carrying "usually transient" is worth
retrying before treating it as a wall, and a deployment channel other than the
one the project uses is not the way around one.

Netlify built from the branch on its own. Live bundle is now `index-CSLiETWZ.js`,
**byte-identical to the local build** (md5 `65378244…`, 536,412 bytes).

No post-deploy steps were needed: the origin did not change, so `ALLOWED_ORIGINS`
and the Supabase redirect URLs still match — the session-11 CORS failure does not
recur here.

Note what the deploy did and did not carry. **Only the title-leak fix is code.**
The encoding repair, the re-anonymisation, the 8 clusters and the 16 drafts are
all *data*, and were live the moment they were written — no build involved.

### Why this should be done before the ~89 anonymisation calls

Anonymisation reads `post_text`. **68 of the 89 anonymised posts derive from
damaged text.** Repairing first means the "Redo all" that was already being
considered for session 16's over-replacement fix corrects the accents in the same
batch of calls. In the other order the calls are paid for twice.

It also unblocks something already observed: session 15's brand discovery
proposed `Niccolò Branca` and `Caffè Borghetti`, which can never match
`Niccol? Branca`. Those aliases start working the moment the text is repaired.

Downstream that was produced by a model reading damaged text, for whoever decides
how far to re-run:

| derived from damaged text | |
| --- | --- |
| `anonymized_posts_current` | 68 of 89 |
| `post_embeddings` | 68 of 90 |
| `analyzed_posts` / scores | 132 of 180 (60 of them above the threshold) |
| `cluster_assignments` | 44 of 54 |

Re-scoring is the expensive, least certain one: the model still read the words,
only the accents were missing, and re-scoring can move which posts pass the
threshold and therefore invalidate the clusters and the generated copy resting on
them. Repair + re-anonymise is the coherent minimum.

### A trap worth naming, because it bit twice in one session

The verification tooling built to check this **had the same bug**. Python's
`sys.stdin` on this machine decodes using the locale codepage (cp1253), so a
UTF-8 SQL script read from stdin arrived mangled, and the first dry run reported
328 mismatches. It was only visible because the check compared md5s against the
snapshot rather than eyeballing output. Anything on this machine that moves text
between a file and a process must state its encoding explicitly; the default is
wrong, and it fails quietly in both directions.

## Session 16 — the anonymiser stops corrupting facts (2026-09-02)

### What was wrong

Session 15 produced the first corpus of real anonymised text, which made the
first real audit of it possible. Every `entity_extraction` replacement ever
stored was read back: **45 distinct entities, and a large share of them were
not companies at all.**

| What was replaced | Times | What it actually is |
| --- | --- | --- |
| `Made in Italy` | 5 | a phrase |
| `Vinitaly` | 4 | a trade fair |
| `Cabina di Regia` | 3 | an inter-ministerial body |
| `AGEA - Agenzia per le Erogazioni in Agricoltura` | | a public agency |
| `Bando MASAF INAIL ISMEA CREA` | | a funding notice naming four agencies |
| `Anci`, `Capitanerie di Porto`, `Copernicus` | | public bodies |
| `Australia` | | a country |
| `Al Bano` | | a person |
| `6,2 milioni di euro` | | an amount of money |
| `associazioni di categoria` | | a category noun |

Each one silently rewrites what a post says into "another food-sector
organization". Nothing downstream can tell, which is what makes it worse than
a leak: a leak is visible when you grep for the name.

### Why the public bodies got through

`isPublicBody` compared for **equality**. The extractor returns an institution
as the text spells it — `"AGEA (Agecontrol)"`, `"Bando MASAF INAIL ISMEA
CREA"` — and none of those equals a list entry, so `keep_public_bodies` never
fired. It now matches by **whole-word containment**.

One trap, hit on the first attempt: making every acronym case-sensitive (to
stop `WHO` and `UN` firing on English "who" and Italian "un") broke `"Ismea"`,
which is exactly the spelling the corpus uses. Only `EU`, `UN`, `WHO` and
`CREA` are case-sensitive now — the four whose lowercase form is a real word.
`ANCI` and `Copernicus` joined the list; `Capitanerie`, `Commissione
Agricoltura` and `Cabina di Regia` joined the wording patterns.

### The second guard

`isNotOrganizationName` is new, applied in the same merge loop and **ungated by
config**: an amount of money and a lowercase multi-word phrase are not
companies under any setting, so replacing them is a factual corruption rather
than a policy choice. Deliberately narrow — names that merely contain digits
(`Industry 4.0`) and single lowercase words (`adidas`) pass, because refusing
in that direction leaks a real company.

`ENTITY_PROMPT_VERSION` is now `entity_extraction_v2`, with an exclusion list
drawn from the measured failures and a closing instruction to leave out
anything uncertain: a missed company can be typed into `company_aliases`, a
wrongly reported one cannot be noticed.

**Still probabilistic:** countries, people and trade fairs are left to the
prompt, because only a gazetteer could settle them and guessing wrong in that
direction leaks a name.

### Text already stored still carries the old replacements

The fix changes what the anonymiser *will* do. `"Redo all"` on the Clusters
screen re-runs anonymisation against the deployed version — **~89 LLM calls**,
so it is a deliberate operator action, not something to do casually.

### The scoring model is now a setting

The Objective screen gains a **Scoring engine** section: model, pinned build,
and the aggregation strategy as a select with its one implemented option.

`0022_model_in_scoring_snapshot.sql` is the half of 0021 that was missing.
`queue_scoring` rotates the active production request when the config hash
moves, and `scoring_config_snapshot()` did not include the model — so exposing
the field without this would have let an operator change the model, press
Queue, and be scored by the old one. The snapshot change moves the hash once,
which rotates the request on the next queue with no edit; that costs nothing,
because `backfill_scoring_for_request` enqueues posts with **no current result
at all**, not posts unscored under the new request. The 180 scores stand.

### Shipped

- `c20f012` — anonymise: the containment fix, the shape guard, prompt v2
- `fa6ef15` — objective: the Scoring engine section, migration 0022
- `anonymize-worker` deployed; 0022 applied to `bxaovkzemfyxrxbcqask`
- 34 offline tests in `anonymize-worker/__tests__/deterministic_test.ts`, green

### Α is done — regenerate with an instruction

An editor reading a draft in Review can now write what to change and get a new
one. `0023_generation_feedback.sql` plus `generate_v3`.

**Nothing is overwritten.** `cluster_generation_results` is append-only, and its
own comment already fixed the rule: a re-generation is a new request producing
new rows. So a revision is an ordinary request carrying two extra facts —
`cluster_generation_requests.regenerates_result_id` and `.feedback` — both
stored, because `prompt_hash` tells you two results differ while only the note
tells you what was asked for.

Four decisions worth knowing:

- **Scoped to one output type.** Feedback about a post must not replace a
  carousel that was already approved. A regeneration inherits the previous
  result's outputs and refuses an output it never carried.
- **An approval is never revoked.** `supersede_generation_review` moves a review
  to `'superseded'` only from `draft` or `rejected`. An approved row keeps its
  status and gains a pointer to the newer draft, so nothing disappears from
  Export because somebody explored a variant.
- **An empty feedback box is a real request.** It asks for a materially
  different angle on the same evidence, not a paraphrase — a separate branch in
  the prompt.
- **The supersede call is non-fatal.** By the time it runs the LLM call has been
  paid for and persisted; a 500 over a pointer would lose copy the editor just
  bought. Worst case is an old row still reading `draft`.

**A trap this sprung, and it would have broken the Review screen:** 0023 gives
`cluster_generation_reviews` a *second* foreign key to
`cluster_generation_results`, and results/requests now reference each other. Any
unqualified PostgREST embed between those tables started returning PGRST201
("more than one relationship was found"). Review and Export both had one. Both
now name the FK explicitly. Confirmed against the live API: the old form fails,
the hinted form works. **Anything new that embeds these tables must do the
same.**

Verified end to end on the live project — the note reaches the model and changes
the copy:

> "More traceability controls: a practical path to food safety"
> → "More enforcement, more safety: traceability that blocks unsafe risk"

`6287148`, `generate` deployed, 0023 applied. 7 offline prompt tests.

### Β is done — Word export

Export offered Markdown and JSON. The people this copy is written for work in
Word, and pasting Markdown into a document is not a handoff. There is now a
third format on both tabs.

**Built in the browser, not as an Edge Function writing to Storage** — a
deliberate departure from the earlier note. The outputs are a few kilobytes the
client already holds and renders in the preview pane; a round trip would have
bought a bucket, a storage policy, signed URLs that outlive RLS for their
lifetime, and a cleanup job, to move bytes that were already there. If sharable
links are ever wanted, that is the reason to revisit it — not file size.

- The `docx` dependency is behind a **dynamic import**: a separate 403 kB chunk
  nobody downloads until they pick the format. The main bundle grew 8 kB.
- Hand-rolling OOXML was considered and rejected. A .docx is easy to produce
  and easy to produce almost right; a file Word refuses to open is worse than
  no file.
- **"Download all" is one document** with page breaks between entries, not a
  folder of twenty.
- The preview pane shows the Markdown rendering with an explicit note that the
  download is Word. Previewing one format while downloading another silently is
  the sort of small lie that costs an afternoon.

Verified against real generated files: ZIP integrity, every XML part parses,
content types cover every extension, hyperlink `r:id`s all resolve through
`document.xml.rels`, Heading1/Heading2 applied, carousel slides sorted 1-5 from
shuffled input, exactly one page break between two entries and none trailing,
and `&`, `<`, em dashes, curly quotes and Italian accents intact.

`dd8a627`.

### Two things to know about this repo

**`tsc --noEmit -p tsconfig.json` checks nothing.** `frontend/tsconfig.json` is a
solution file with project references, so that invocation reports clean on code
that does not compile. Use `npm run build`, which runs `tsc -b`. This bit during
session 16 — a `-p` run said clean and the build then reported seven errors.

**`react-router` carries a high-severity advisory** (GHSA-qwww-vcr4-c8h2, RSC
mode CSRF) at the pinned 7.18.1. Pre-existing, unrelated to any session-16 work,
and not fixed here because a router upgrade deserves its own change. `npm audit
fix` in `frontend/` is the stated remedy.

### Still open

- ~~**Ε — encoding corruption at ingest.**~~ Diagnosed in session 17: it is not
  ingest, it is one-time migration damage, and the repair is ready and unapplied.
- Re-anonymise the corpus once the operator decides the ~89 calls are worth it —
  **after** applying the encoding repair, so the same calls fix both.

## Session 15 — real scores, and the buttons to produce them (2026-09-01)

### The corpus is real for the first time

**180 posts, 180 real LLM scores, zero simulated.** The 133 legacy placeholders
are gone. 81 pass the threshold, and the separation is decisive:

| source | posts | passing | avg |
|---|---|---|---|
| MASAF | 62 | 54 | 71 |
| STAR / GBfoods | 4 | 3 | 63 |
| Fratelli Branca | 35 | 11 | 34 |
| European Commission | 79 | 13 | 15 |

Judging content alone, the agriculture ministry passes almost entirely while the
Commission — which posts about everything from Ukraine to Pride — keeps 13 of 79.
Before 0019 the Commission would have dominated the queue with 75-95s for
employment posts.

**The threshold stays at 50.** Raising it to 60 was considered and rejected on
the data: the 50-59 band holds 17 posts and is a mixed bag — Italy's rice
production, the €1bn COLTIVAITALIA package, the ISMEA market report, MASAF at
Vinitaly and Carpano's 1786 heritage sit beside a satellite decommissioning and
an EU-Mexico trade note. Almost everything lands on exactly 55, because that is
the rubric's "partial relevance" band. The threshold measures magnitude, not
subject; raising it cuts the band wholesale. Editors filter per-session with the
Min relevance slider instead.

### Anonymisation: two leak classes closed, one limitation accepted

Re-scoring pulled Branca and GBfoods content into the corpus for the first time
(the July batch was chosen by simulated scores and contained almost none), and
four company names survived. Both causes were the same stage-1/stage-2 contract
gap that leaked "GBfoods" in July, in new forms — see `c3d4f8c`:

- **Hashtags.** A tag concatenates its words, so the word-boundary lookarounds
  used for prose can never fire inside `#FratelliBrancaDistillerie`.
- **Product brands.** "Carpano" and "Fernet-Branca" are derivable from nothing —
  not in the source label, and skipped by stage 2 as "the source's own name".
  `company_aliases` now replaces its keys wherever they occur, longest first.

`0020` adds **brand discovery**: an AI reads a source's own posts and proposes
the names that identify it, as proposals an editor accepts. On Fratelli Branca it
found **15 names, nine of which a careful human read had missed** — Brancamenta,
Borghetti, Stravecchio Branca, Torre Branca, Gruppo Branca International among
them. It proposed no product categories, which is what the prompt spends most of
its length preventing.

**It is not exhaustive, and that is recorded deliberately.** It consistently
misses `Saikebon` and `Tigullio`, which appear only as hashtags in one sentence,
across three prompt variations. They were added by hand. The list stays editable
for exactly this reason.

**A measurable cost of the encoding corruption**, the first that is not
cosmetic: the model normalises accents, so it proposed "Niccolò Branca" and
"Caffè Borghetti" while the stored text holds "Niccol? Branca" and "Caff?
Borghetti". Those aliases can never match. Covered by the bare surnames; the
accented entries are kept so they start working if ingest is fixed.

Current state: **18 names, 89 anonymised posts, zero survivals**, verified name
by name and by direct regex sweep. MASAF preserved in 15.

### The operator can finally drive it (0021)

"Score now" and "Anonymise now" consume work; **nothing in the UI could create
any**. Every run this week was started by hand in SQL. `0021` adds
`queue_scoring` and `requeue_anonymisation` as editor-callable RPCs, with
buttons: *Queue unscored* / *Re-score all* on Posts, *Redo all* on Clusters.
Posts now shows queue depth, so an empty queue is visible rather than inferred.

`queue_scoring` does one thing beyond wrapping: a scoring_request pins an
immutable config snapshot, so **editing themes or the domain while one is active
left scoring on the old settings, silently**. It compares hashes and rotates the
request. The scoring model and `aggregation_strategy` moved into
`configurations` at the same time — the first draft read them from "the most
recent request", which breaks on a fresh database, and both were hidden
constants besides.

### Corrections to earlier claims

- Session 14 said four hardcoded food assumptions were made configurable. There
  is a **fifth**: `cluster/prompt.ts` still carries a hardcoded CUES brief used
  to name every cluster. Recorded in `docs/presets.md`; not yet fixed.
  **Fixed since — session 17 checked.** `cluster/prompt.ts` now builds the brief
  through `buildBrief(domain, themeLabels)` from the operator's configured scope.
  This bullet stayed open in the record longer than the defect did.
- Session 14's neutrality claim otherwise holds and was re-proved this session.

### Where the pipeline stands

```
collect ✓   score ✓   anonymise ✓   cluster ← next   generate   review ✓
```

The 4 existing clusters and the one generated result are **stale** — built from
51 posts chosen by simulated scores. Clustering needs re-running over the 81
that now pass.

---

## Session 14 — scope becomes configuration (2026-08-31)

## Session 14 — scope becomes configuration (2026-08-31)

Scoring the first real posts showed the tool admitting content with no
connection to food: a European Commission traineeship ad scored **95 and
`in_generation = true`** on `talent_development: 95` with five zeros beside it,
while the model's own reason said *"no direct connection to agriculture, food
systems…"*.

The operator's position was that this is configuration — they pick the themes,
they own the result. Measured across all 8 real scorings, that is **half right**,
and the half that fails is the important half:

| post | before | dropping the `talent development` theme |
|---|---|---|
| Traineeship ad | 95 | 0 — fixed by config |
| EU social rights | 85 | 20 / 35 — fixed by config |
| **Textile waste** | 92 | **92** — scores on `sustainability` |
| **Energy decarbonisation** | 75 | **75** — `sustainability` + `innovation` |

**Themes are angles, not scope.** "Sustainability" applies to food, textiles and
energy alike, and a theme list cannot express *"sustainability, in food"*. No
keyword configuration excludes those two, because the themes they score on are
ones the operator obviously keeps.

Two further findings turned this from a scoring tweak into a structural fix:

1. **Four hardcoded food assumptions no operator could reach** — the scoring
   rubric (*"strong relevance to food, agriculture…"*), both anonymiser generics
   (`"a food-sector organization"` / `"another…"`), and the generator's default
   brief. Pointed at another sector the tool would have scored against a food
   rubric and renamed that sector's companies to "a food-sector organization".
2. **Two theme lists, nothing syncing them.** `scoring_themes` drove the scorer;
   `configurations.themes` was what the Objective screen edited and only ever
   reached the generator. **Removing a theme in the UI changed nothing about
   scoring** — so even the operator's own share of the responsibility was not
   actionable.

### What shipped

Migration `0019_editorial_domain.sql` adds `editorial_domain` and the two
generic-entity strings to `configurations`, **defaulted to today's values**, so
day-one behaviour is unchanged and the existing production row was backfilled
with the CUES preset automatically. The domain renders into the rubric through a
`{{DOMAIN}}` placeholder using the template mechanism that was already there.
Out-of-domain is expressed **in the rubric**, not as a separate score, so no
append-only table and no completion RPC signature changed. `prompt_version` is
now `scoring_v2`; historical results keep the template they were scored under.

`scoring_themes` becomes the single source of truth, edited through
`set_scoring_themes`, which **retires** dropped themes rather than deleting ids
that stored results reference, and refreshes `configurations.themes` as a mirror.
Objective gained the scope fields plus the clustering settings that already
existed in `configurations` but appeared on no screen; Posts flags a score
carried by a single theme.

### Measured after deploying — the same 7 posts, re-scored

```
textile waste           92 -> 0     was unfixable by config
energy decarbonisation  75 -> 40    was unfixable by config
traineeship ad          95 -> 15
olive oil               85 -> 88    genuine, sharpened
wheat policy            78 -> 80    genuine, sharpened
World Cup                0 -> 0
EU social rights        85 -> 70    STILL ADMITTED
```

Six of seven land correctly, including both cases no keyword change could reach.
**The rubric narrows the gap rather than closing it:** the EU social-policy post
still scores 70 on `talent_development` while the model's own reason calls it out
of scope. Retiring that theme is the operator's lever for the remainder — so the
two mechanisms are complementary, which is precisely why both are now visible to
them.

### Neutrality proof

Same post, same model, same code; only the config row changed:

```
domain = food        -> olive oil post scores 88
domain = automotive  -> the same post scores 0, all themes zero
```

Restored from `docs/presets.md` afterwards and the post returned to 88. The
theme-edit path was proved the same way: removing a theme through the Objective
screen took the scorer's pinned snapshot from 6 themes to 5 — the thing that
silently did nothing before.

### State left behind

CUES preset restored and verified; all six themes active (note
`talent development` sits at position 6 rather than 3 after the remove/re-add
test — display order only). One active production request pinned to the food
domain and `scoring_v2`. Queue empty. 140 analyzed_posts, of which **7 carry real
LLM scores**; the other 133 are still legacy `simulated`. 40 raw posts unscored.

### Two decisions waiting, both free and both the operator's

- **`talent development`** — keep or retire. The evidence is measured and
  recorded in `docs/presets.md`.
- **The domain wording** — whether *"food, agriculture and the agrifood supply
  chain"* is the right phrasing.

Settle these before scoring the remaining posts; otherwise the corpus gets
scored twice.

### The next structural gap

**Nothing in the UI can put posts into the scoring queue.** "Score now" drains a
queue that only `enqueue_scoring_job` / `enqueue_reevaluation` /
`open_production_scoring_request` can fill, and none of them is reachable from a
browser — this session filled it by hand with SQL. Until that screen exists,
scoring cannot be driven without a terminal, which contradicts the plan's
"no terminal" goal.

---

## Session 13 — scoring finally reaches the product (2026-08-27)

## Session 13 — scoring finally reaches the product (2026-08-27)

**Every score an editor can see is still fabricated.** All 133 rows in
`analyzed_posts` point at `source='simulated'`, `llm_used=false` results
inherited from the legacy system. Since `included_in_generation` derives from
them, the 51 anonymised posts, the 4 clusters and the generated copy were all
selected by numbers no model produced. Fixing that is the next real milestone,
and it was blocked by two defects that compounded:

1. **Scoring appended history but never published it.** `scoring_results` is the
   immutable log; `analyzed_posts` is the projection the UI and every downstream
   stage read, written by the separate `set_current_scoring_result` RPC — a
   deliberate two-step design from 0005. **Nothing ever called step two.**
   `score-worker` invoked only read/complete/record. Proof in cloud: 6 real
   `llm_verified` results existed with **no `analyzed_posts` row at all**.
   Draining the queue in that state would have produced 47 more invisible
   results and looked like a broken deploy.

   Fixed by migration `0018`: `complete_and_promote_scoring_job` wraps both
   writes in one transaction. It is done in the database rather than as a second
   call from the worker because `complete_scoring_job` archives the job's pgmq
   message — a second round trip that failed would strand the post unpromoted
   with no message left to re-claim.

2. **Cloud v7's blanket guard.** It rejected every non-internal caller, and could
   never be satisfied from a browser: the internal path needs
   `INGEST_INTERNAL_SECRET`, which `auth.ts` requires to be *"never present in a
   browser"*. It also contradicted `score-worker/index.ts`'s own documented
   dual-auth contract. Replaced with `MANUAL_BATCH_CAP` — browser callers get 10,
   internal keep 25, and **setting it to 0 restores internal-only in one line**.
   The concern is kept as a bound rather than a wall. Note the function takes no
   post identifier, only a count, so it cannot score on demand regardless.

`score-worker` is now cloud **v9**, built from this repo. `Posts.tsx` no longer
sends a hardcoded `batch_size` — it sent 25, which the new cap rejected with a
400; that policy belongs on the server.

Verified: all 18 migrations applied to a local stack from scratch, then
score-worker 32 steps / ingest 81 / cluster 20 / anonymize-worker 12 /
generate 10, all passing. The new assertion checks
`analyzed_posts.current_result_id` — precisely what the old suite never looked
at, which is how this shipped. Live: "Score now" returns **200** with
`jobs_read: 0` (the queue is empty, so no provider spend).

### The next action, and its cost

The cloud scoring queue is **empty** and all three `scoring_requests` are
`closed`. Nothing will score until someone creates a new request and enqueues —
a deliberate step, not a side effect of clicking. Doing so for all 180 posts
spends real OpenAI quota. **Start small** (one or two posts) and confirm the
post appears in `/posts` with a real reason string instead of *"Simulated LLM
semantic scoring"*, which is the observable proof that promotion works.

---

## Session 12 — the review/export bridge (2026-08-27)

## Session 12 — the review/export bridge (2026-08-27)

Migration `0017_generation_review.sql` and a Review/Export rewire. Generated
copy is now reviewable, editable, approvable and exportable; item 4 of session
11 below is **closed**.

- `cluster_generation_reviews` is a **mutable projection over the append-only
  results** — the 0016 immutability triggers mean review state cannot live on
  `cluster_generation_results` itself. Keyed `(result_id, output_type)`, so a
  post can ship while its carousel is still being worked on.
- Editor edits go to `edited_output`; the model's own output is never modified,
  and the Review detail shows both side by side once an edit exists.
- Rows are created by an after-insert trigger on the results table, never by an
  editor: no INSERT or DELETE grant, and a **column-level** UPDATE grant only on
  `status`/`edited_output`/`approved_by`/`approval_timestamp`/`approval_notes`.
- Verified against the deployed policy with a real editor JWT (not the service
  role): SELECT 200, granted-column UPDATE 204, `result_id` and `created_at`
  both `42501`, approving in another user's name rejected by the with-check,
  INSERT and DELETE `42501`.
- Verified end to end on the live site: edit → persists across reload → approve
  → appears in Export under `approved` → Markdown and JSON previews carry the
  copy, the cluster, the model, the status and the source posts, and flag
  reviewer edits. The Legacy tab still lists the 7 pre-cloud assets.
- **Test state was reset afterwards**: both review rows are back to `draft`,
  unedited, unapproved. Approving real copy is an editorial decision, so none
  was left standing.

~~Still open from Phase 7: regeneration-with-feedback and DOCX export.~~ Both
shipped in session 16 — see above. DOCX did **not** need an Edge Function or
Storage in the end; the reasoning is recorded there.

---

## Session 11 — production audit (2026-08-25)

> Keep writing state here. Claude Code deletes local session transcripts after
> `cleanupPeriodDays` (default 30), and the session 1–10 transcripts were lost
> that way on 2026-08-25. This file and the git history are the only durable
> record.

## Plain-language state (read this first)

**Session 11 ran no pipeline stages and changed no application code.** It was an
audit of what is actually deployed versus what is in this repo. Cloud data is
exactly what session 10 left behind. Three things came out of it that were not
previously known, and one production blocker was fixed.

| Piece | Status |
|---|---|
| `ingest` | live since Phase 2, unchanged |
| `score-worker` | cloud `v7` **provenance resolved this session** — it is this repo's code plus one deliberate internal-only guard (see below). "Score now" still 403s, now for a known and correct reason. |
| `anonymize-worker` | unchanged since session 10; all 51 eligible posts anonymised |
| `cluster` | unchanged; 1 run, 4 labeled clusters |
| `generate` | unchanged; 1 request, 1 result |
| Edge Function CORS | **fixed this session** — the production origin was rejected at preflight on all five functions |
| Frontend (repo) | all six stages bound, Generate action + history present at `8bcc9c1` |
| Frontend (deployed) | **stale — serving a pre-`814ebfc` build.** `/generate` is still the "Not built yet" placeholder in production. |

## What happened this session (11)

1. **CORS was the real production blocker, not the `score-worker` 403.**
   Every Edge Function rejected `https://cues-tca.netlify.app` at preflight —
   HTTP 403, no `Access-Control-Allow-Origin` — while accepting
   `http://localhost:5173`. The `ALLOWED_ORIGINS` secret existed but did not
   contain the production origin: step C.2 of `docs/NETLIFY_DEPLOYMENT.md` was
   never completed. Consequence: **every action button in production was dead**
   — Collect, Score, Anonymise, Run clustering, Generate. Reads were unaffected
   (PostgREST/RLS, not Edge Functions), so the app looked healthy.

   Fixed by setting the secret to a superset that preserves local dev:

   ```
   ALLOWED_ORIGINS="http://localhost:5173,http://127.0.0.1:5173,https://cues-tca.netlify.app"
   ```

   No redeploy needed — `_shared/cors.ts` reads it per request. Verified: all
   ten function×origin preflight combinations now return 204 with the correct
   `Access-Control-Allow-Origin`.

   **Deploy previews still will not work.** `isAllowedOrigin` uses an exact
   `Array.includes()`, so the `https://*--<site>.netlify.app` wildcard that
   `NETLIFY_DEPLOYMENT.md` suggests works for Supabase Auth redirect URLs but
   not for CORS. Functional previews need prefix matching in `cors.ts`.

2. **`score-worker` v7 provenance is resolved — stop treating it as unknown.**
   The deployed eszip bundles of all five functions were downloaded via the
   Management API (`GET /v1/projects/{ref}/functions/{slug}/body`), unpacked
   with `@deno/eszip`, and compared against this repo after type-erasure
   through the same compiler. (The deployed code is transpiled and reformatted,
   so a raw text diff is meaningless — it reports every single file as
   different, including functions we know were deployed from here.)

   Across all 41 deployed modules there is **exactly one semantic difference**,
   in `score-worker/index.ts`:

   ```js
   // cloud v7 — present
   const actor = await authenticate(req, body);
   if (actor.kind !== "internal") {
     throw new RequestError(403, "score-worker is driven by the queue, not by a user request.");
   }

   // this repo — absent
   await authenticate(req, body);
   ```

   Everything else differs only in bundler emit (dropped redundant parens, a
   class-field initializer moved into the constructor). Cloud v7 is this repo's
   `score-worker` plus a deliberate internal-only invocation guard. Confirmed
   end to end in production after the CORS fix — clicking "Score now" now
   reaches the function and returns
   `{"ok":false,"error":"score-worker is driven by the queue, not by a user request."}`.

   **The remaining decision is a design one, not archaeology:** either drop the
   guard so allowlisted admins can drain the queue from the UI, or keep it and
   route "Score now" through the internal-secret path. Do not re-enqueue the 47
   unscored posts until this is settled.

3. **The Netlify deploy is one commit behind, and has been since 2026-07-24.**
   The served bundle contains no reference to `cluster_generation_requests`,
   `cluster_generation_results`, `carousel`, or the generation-history view,
   and it *does* contain the string `"Not built yet — Phase 6."`. That is the
   state before `814ebfc` ("bind Generate to cluster selection and add history
   view"). Confirmed in the live UI: `/generate` renders the placeholder and no
   Generate action exists on the Clusters view.

   `origin/main` and `origin/phase6-frontend-binding` are both at `8bcc9c1`,
   equal to local HEAD — **nothing is unpushed.** The build did not run, failed,
   or is wired to something other than the expected branch. Netlify's deploy log
   is the next place to look. Note that with `base = "frontend"` in
   `netlify.toml`, Netlify can skip builds for commits touching no files under
   `frontend/`, which would explain why the docs-only tip commit `8bcc9c1`
   produced no deploy.

4. **Generated content cannot be reviewed or exported — the two halves are not
   connected.** *(Closed in session 12 — see above.)*
   `Review.tsx` and `Export.tsx` read `editorial_assets`;
   `generate` writes `cluster_generation_results`. All 15 `editorial_assets`
   rows are legacy (created 2026-06-26 → 2026-07-01, all `draft`, none
   approved), and `cluster_generation_results` has no `status`, `approved_by`,
   or `approval_notes` columns at all. The review workflow currently operates
   entirely on dead legacy data. This is the substance of Phase 7.

5. **Anonymisation leak in the Clusters view (display-only).**
   `anonymized_posts_current` has no title column — the anonymiser only
   processes `post_text` — but `Clusters.tsx:623` renders `raw_posts.post_title`
   *in preference to* the anonymised text. Exactly one of the 180 raw posts
   carries a title, and it is `"GBfoods Sustainability Initiative"`, so the
   source company name is displayed verbatim in the very list an editor uses to
   inspect anonymisation. The `anonymized_text` column itself is clean (0 of 51
   contain the name) and `generate` reads only `anonymized_posts_current`, so
   nothing leaks into generated copy. Any future titled post bypasses
   anonymisation in this view.

6. **Smaller observations from the live walkthrough** (all seven routes, signed
   in as the single allowlisted editor):
   - `/export` opens empty: the default status filter is `approved` and every
     asset is `draft`.
   - Every row on `/posts` shows the reason *"Simulated LLM semantic scoring
     (source-aware, context-based)"* — the 133 legacy analyses. No post
     currently visible to an editor carries a real LLM score.
   - The corpus encoding corruption is visible on every screen (`qualit?`,
     `L?Italia`, `????`), including the editor's own `full_name` in
     `public.editors`. **The `full_name` half of this is wrong** — session 17
     read it back as `Χαρίσιος Ζαφείρης`, intact. The observing terminal
     could not print Greek. The corpus damage is real; see session 17.
   - Stage-2 over-replacement produces ungrammatical Italian, e.g. *"Si è
     riunita oggi al MASAF la another food-sector organization"*.
   - `routes/Placeholder.tsx` is now unreferenced — `App.tsx` imports every
     route directly.

## Known issues / decisions for next session

- **`score-worker` guard** — design decision, see item 2. Blocks the 47
  unscored posts.
- **Netlify rebuild** — see item 3. Until it runs, production has no Generate.
- ~~**Phase 7 bridge**~~ — shipped in session 12 as `cluster_generation_reviews`
  (a separate table, not columns on the immutable results). Regeneration-with-
  feedback and DOCX export are still unbuilt.
- **Title anonymisation** — either anonymise titles in the worker, or stop
  preferring the raw title in `Clusters.tsx`. The second is a one-line fix.
- **Encoding corruption** — ~~unaddressed at ingest~~. Session 17: not an ingest
  fault at all, and no longer cosmetic-only once the aliases it blocks are
  counted. Repair ready, unapplied.
- **Secret hygiene** — `frontend/.env.local` still holds the Supabase PAT and
  the DB password. Gitignored, but it does not belong in the frontend
  directory. `SUPABASE_ACCESS_TOKEN` is better set as a user environment
  variable, which is also where the Supabase MCP server reads it from.

## Cloud vs local — exact state (verified 2026-08-25)

| | Cloud (`bxaovkzemfyxrxbcqask`) | Local stack |
|---|---|---|
| Migrations | 0001–0016 — identical set to `supabase/migrations/` | as of session 10 |
| Data | 180 raw_posts · 133 analyzed (47 raw unscored) · 51 anonymized (0 still eligible) · 51 embedded · 4 clusters / 10 assignments · 1 cluster generation request + 1 result · 15 legacy editorial_assets, all draft | — |
| Functions | ingest v8, score-worker v7, anonymize-worker v6, cluster v3, generate v1 — all ACTIVE, all verified against this repo | — |
| Secrets | `ALLOWED_ORIGINS` updated this session; others unchanged | — |
| Config | `min_relevance_score` 50 · `cluster_similarity_threshold` 0.75 · `min_cluster_size` 2 · 6 themes | — |
| Branches | `main` == `phase6-frontend-binding` == `8bcc9c1`, pushed | — |
| Netlify | serving a pre-`814ebfc` build | — |

## Verifying deployed functions against this repo

Worth repeating whenever a deployment's provenance is in doubt:

1. `GET https://api.supabase.com/v1/projects/{ref}/functions/{slug}/body` with
   the PAT returns an ESZIP2 archive.
2. Unpack it with `@deno/eszip`: `Parser.createInstance()` → `parseBytes()` →
   `load()` → `getModuleSource(spec)` for each `functions/…` specifier.
3. Compare against the repo only after running **both** sides through
   `ts.transpileModule` (type erasure, comments stripped) and stripping
   whitespace. Trailing commas and redundant parens still differ after that —
   normalise `,}` `,)` `,]` before concluding anything.

## How to continue

1. Get the Netlify build running; confirm the live bundle stops containing
   `"Not built yet"` and starts containing `cluster_generation_results`.
2. Settle the `score-worker` guard, then drain the 47 unscored posts.
3. Phase 7 per `MIGRATION_PLAN.md`: the review/export bridge first — it is the
   thing standing between "the pipeline runs" and "an editor can ship copy".
4. Re-run the production smoke checklist in `docs/NETLIFY_DEPLOYMENT.md` §C,
   which is now unblocked for the first time.
