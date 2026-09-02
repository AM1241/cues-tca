# Session handoff — CUES Editorial Cloud

Last updated: 2026-09-02 (session 16 — stage 2 stops replacing things that are
not companies, the scoring model is an editable setting, an editor can hand the
model a note and get a new draft, and Export produces Word documents).
Read this first, then `MIGRATION_PLAN.md`. This file is the single "where are
we" pointer between working sessions.

## Verified state at the end of session 16 (checked 2026-09-03)

Everything below was confirmed against the live systems, not inferred from the
repo.

| | |
| --- | --- |
| Branch | `phase6-frontend-binding`, clean, in sync with `origin` |
| Head | `a3fbc21` |
| Project | `bxaovkzemfyxrxbcqask` (`cues-tca`, eu-west-1) |
| Migrations applied | through **0023**; `schema_migrations` rows match the files |
| Edge Functions | `anonymize-worker` v11, `generate` v4, `cluster` v5, `discover-brands` v5, `score-worker` v10, `ingest` v9 — all ACTIVE |
| Frontend | live bundle on cues-tca.netlify.app is `index-BYyF1U4-.js`, byte-identical to the local `npm run build` |
| Tests | `deno test supabase/functions/` → **105 passed, 0 failed**, 28 ignored (the live-stack suites, skipped without `SUPABASE_URL` / `RAPIDAPI_KEY`) |

**Data left behind by session 16's live tests.** The cluster *"Più controlli,
più sicurezza"* now carries three generation results — the original (superseded),
a no-note regeneration, and one produced from the note *"Too soft. Lead with the
enforcement angle…"*. Real rows, visible in Review. Nothing was left approved;
`cluster_generation_results` is append-only, so removing them needs deliberate
SQL and is not obviously worth it.

**The corpus still carries the OLD over-replacements.** Session 16 fixed what
the anonymiser *will* do. Existing anonymised text was produced before the fix
and still contains "Made in Italy" and ten public bodies replaced by the generic
entity. "Redo all" on Clusters re-runs it — **~89 LLM calls**, an operator
decision, not taken.

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

- **Ε — encoding corruption at ingest.**
- Re-anonymise the corpus once the operator decides the ~89 calls are worth it.

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
     `public.editors`.
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
- **Encoding corruption** — still unaddressed at ingest, still cosmetic-only for
  generated copy.
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
