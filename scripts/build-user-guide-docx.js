/**
 * Builds the English user handbook as a Word document.
 *
 * Same content as docs/USER_GUIDE.source.html, laid out for Word: real
 * headings so the navigation pane works, real tables, and the eight
 * screenshots captured from the live application.
 *
 * Run from the repo root:  node scripts/build-user-guide-docx.js
 */
const fs = require('fs')
const path = require('path')
const d = require('../frontend/node_modules/docx')

const {
  Document, Packer, Paragraph, TextRun, HeadingLevel, ImageRun,
  Table, TableRow, TableCell, WidthType, BorderStyle, AlignmentType, ShadingType,
} = d

const SHOTS = path.join(__dirname, '..', 'docs', 'user-guide-images')

/** PNG dimensions straight from the IHDR chunk — no dependency needed. */
function pngSize(buf) {
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) }
}

const CONTENT_WIDTH = 600 // points; ~6.25in inside 1in margins

function image(file, caption) {
  const data = fs.readFileSync(path.join(SHOTS, file))
  const { width, height } = pngSize(data)
  const w = CONTENT_WIDTH
  const h = Math.round((height / width) * w)
  return [
    new Paragraph({
      spacing: { before: 240, after: 80 },
      children: [new ImageRun({ data, type: 'png', transformation: { width: w, height: h } })],
    }),
    new Paragraph({
      spacing: { after: 240 },
      children: [new TextRun({ text: caption, italics: true, size: 18, color: '667085' })],
    }),
  ]
}

function h1(text) { return new Paragraph({ text, heading: HeadingLevel.HEADING_1, spacing: { before: 400, after: 160 } }) }
function h2(text) { return new Paragraph({ text, heading: HeadingLevel.HEADING_2, spacing: { before: 320, after: 120 } }) }
function h3(text) { return new Paragraph({ text, heading: HeadingLevel.HEADING_3, spacing: { before: 240, after: 100 } }) }

/** Inline markup: **bold**, `ui label`, *italic*. */
function runs(text) {
  const out = []
  const re = /(\*\*[^*]+\*\*|`[^`]+`|\*[^*]+\*)/g
  let last = 0, m
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) out.push(new TextRun(text.slice(last, m.index)))
    const t = m[0]
    if (t.startsWith('**')) out.push(new TextRun({ text: t.slice(2, -2), bold: true }))
    else if (t.startsWith('`')) out.push(new TextRun({ text: t.slice(1, -1), font: 'Consolas', shading: { type: ShadingType.CLEAR, fill: 'EEF1F6' } }))
    else out.push(new TextRun({ text: t.slice(1, -1), italics: true }))
    last = m.index + t.length
  }
  if (last < text.length) out.push(new TextRun(text.slice(last)))
  return out
}

function p(text) { return new Paragraph({ children: runs(text), spacing: { after: 140 } }) }
function bullet(text) { return new Paragraph({ children: runs(text), bullet: { level: 0 }, spacing: { after: 80 } }) }

/** A shaded single-cell box, for the things a reader must not miss. */
function callout(fill, border, title, lines) {
  const kids = []
  if (title) kids.push(new Paragraph({ children: [new TextRun({ text: title, bold: true, color: border })], spacing: { after: 80 } }))
  lines.forEach((l) => kids.push(new Paragraph({ children: runs(l), spacing: { after: 60 } })))
  return new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    borders: {
      top: { style: BorderStyle.SINGLE, size: 2, color: fill },
      bottom: { style: BorderStyle.SINGLE, size: 2, color: fill },
      right: { style: BorderStyle.SINGLE, size: 2, color: fill },
      left: { style: BorderStyle.SINGLE, size: 18, color: border },
      insideHorizontal: { style: BorderStyle.NONE },
      insideVertical: { style: BorderStyle.NONE },
    },
    rows: [new TableRow({
      children: [new TableCell({
        shading: { type: ShadingType.CLEAR, fill },
        margins: { top: 160, bottom: 160, left: 200, right: 200 },
        children: kids,
      })],
    })],
  })
}

const note = (t, ls) => callout('DCEFE7', '0B6E52', t, ls)
const money = (t, ls) => callout('F7E9DC', '9A4A12', t, ls)
const stop = (t, ls) => callout('F9E4E4', '9B2C2C', t, ls)

function table(headers, rows) {
  const headerRow = new TableRow({
    tableHeader: true,
    children: headers.map((htxt) => new TableCell({
      shading: { type: ShadingType.CLEAR, fill: '0B1220' },
      margins: { top: 90, bottom: 90, left: 140, right: 140 },
      children: [new Paragraph({ children: [new TextRun({ text: htxt, bold: true, color: 'FFFFFF', size: 18 })] })],
    })),
  })
  const bodyRows = rows.map((r) => new TableRow({
    children: r.map((cell) => new TableCell({
      margins: { top: 90, bottom: 90, left: 140, right: 140 },
      children: [new Paragraph({ children: runs(cell), spacing: { after: 0 } })],
    })),
  }))
  return new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    borders: {
      top: { style: BorderStyle.SINGLE, size: 2, color: 'B9C4D4' },
      bottom: { style: BorderStyle.SINGLE, size: 2, color: 'B9C4D4' },
      left: { style: BorderStyle.NONE }, right: { style: BorderStyle.NONE },
      insideHorizontal: { style: BorderStyle.SINGLE, size: 1, color: 'D6DDE8' },
      insideVertical: { style: BorderStyle.NONE },
    },
    rows: [headerRow, ...bodyRows],
  })
}

const spacer = () => new Paragraph({ text: '', spacing: { after: 160 } })

// ===========================================================================

const body = []

// ---- cover -----------------------------------------------------------------
body.push(new Paragraph({
  spacing: { after: 60 },
  children: [new TextRun({ text: 'CUES', bold: true, size: 22, color: '55627C', characterSpacing: 60 })],
}))
body.push(new Paragraph({
  spacing: { after: 160 },
  children: [new TextRun({ text: 'Post Generator', bold: true, size: 64, color: '0B1220' })],
}))
body.push(new Paragraph({
  spacing: { after: 200 },
  children: [new TextRun({ text: 'User handbook', size: 30, color: '55627C' })],
}))
body.push(p('How to turn what food-industry organisations publish on LinkedIn into an editorial post and a carousel you have read, edited and approved yourself.'))
body.push(new Paragraph({
  spacing: { before: 200, after: 400 },
  children: [new TextRun({
    text: 'Written against the live application on 16 September 2026. Every screenshot is the real product, signed in as an ordinary user — not a mock-up.',
    italics: true, size: 18, color: '667085',
  })],
}))

// ---- 1. what it makes ------------------------------------------------------
body.push(h1('What it makes'))
body.push(p('Two things, from the same material:'))
body.push(bullet('a **post** — the LinkedIn text: a headline, the body, a closing line and hashtags;'))
body.push(bullet('a **carousel** — a set of square 1080×1080 images you swipe through, plus the words that accompany them.'))
body.push(p('They come from the same evidence: recent posts by the organisations you follow, scored for relevance, grouped into topics, and written up.'))
body.push(stop('The tool never publishes anything.', [
  'It produces files and text; you post them yourself. Nothing leaves the tool without a person pressing `Approve`.',
]))
body.push(spacer())
body.push(note('The words on the images are yours, letter for letter.', [
  'The text on every slide is drawn by the tool from the text you approved. No model rewrites it into the picture. When the AI option is used, the model produces only the *background* behind the words.',
]))

// ---- 2. signing in ---------------------------------------------------------
body.push(h1('Signing in'))
body.push(p('Open the address you were given and enter your email and password. There is no self-registration: an account is created for you.'))
body.push(...image('g1-signin.png', 'Figure 1 — The sign-in screen.'))
body.push(p('If you forget your password there is no self-service reset — ask the person who gave you the account.'))

// ---- 3. the six screens ----------------------------------------------------
body.push(h1('The six screens'))
body.push(p('The navigation bar reads left to right, and that order *is* the process. Each screen feeds the next, so skipping one leaves the next screen empty.'))
body.push(new Paragraph({
  spacing: { before: 120, after: 200 },
  alignment: AlignmentType.CENTER,
  children: [new TextRun({ text: 'Sources  →  Settings  →  Rating  →  Topics  →  Review & Approve  →  Export', bold: true, font: 'Consolas', size: 19 })],
}))
body.push(table(['Screen', 'What you do there', 'What comes out'], [
  ['**Sources**', 'Choose which LinkedIn pages are watched, and collect their recent posts', 'Collected posts'],
  ['**Settings**', 'Set the editorial direction: themes, the relevance bar, the brief, tone and audience', 'The rules everything else follows'],
  ['**Rating**', 'Score the collected posts for relevance and see why each got its score', 'Scored posts'],
  ['**Topics**', 'Hide company names, group similar posts into topics, then create the post and carousel', 'A draft'],
  ['**Review & Approve**', 'Read it, edit it, approve or reject it, and download the images', 'An approved draft and PNG slides'],
  ['**Export**', 'Download the final text as Word, Markdown or JSON', 'Files'],
]))
body.push(spacer())
body.push(note('Two words that sound alike and are not.', [
  '*Themes* are the five or six subjects you score against, set in Settings — food safety, supply chain, and so on. *Topics* are groups of similar posts, worked out automatically, and each one becomes a section of the publication and a slide in the carousel.',
  'Themes are what you are looking for; topics are what was found.',
]))

// ---- step 1 ----------------------------------------------------------------
body.push(h1('Step one — Sources'))
body.push(p('The list of LinkedIn pages the tool reads, and where new material comes in.'))
body.push(...image('g2-sources.png', 'Figure 2 — Sources, as an ordinary user sees it.'))
body.push(h3('The columns'))
body.push(bullet('**Lookback** — how many days back this page is read when you collect. Anyone can change it.'))
body.push(bullet('**Last fetched** — when this page was last read successfully.'))
body.push(bullet('**Enabled** — the switch. A page that is off is skipped by `Collect all enabled`. Turning it off is reversible and is the polite way to pause a source.'))
body.push(h3('Collecting'))
body.push(p('Press `Collect` on one row to read that page, or `Collect all enabled` at the top right for every active page. It takes a few seconds; the button says so while it runs. You then get a short result, for example “4 new, 46 outside your lookback window” — the second number is the one to read if nothing new arrived: the posts existed, they were simply older than your lookback.'))
body.push(h3('Find names'))
body.push(p('`Find names` asks the model to read this page’s recent posts and suggest product or subsidiary names worth hiding — brands the anonymiser would not work out from the page name alone. Everything it returns is a *proposal*: nothing is hidden until you accept it.'))
body.push(money('Collect and Find names both cost money.', [
  'Collect sends a real request to the LinkedIn data provider; Find names asks a language model. Neither is free, so collect when you mean to, not to see what happens.',
]))

// ---- step 2 ----------------------------------------------------------------
body.push(h1('Step two — Settings'))
body.push(p('The editorial direction. Nothing here does anything on its own — it changes what the other screens do the next time you run them. The screen is grouped by which screen each setting actually reaches, and each group says so.'))
body.push(...image('g3-settings.png', 'Figure 3 — Settings. Changes take effect the next time you score, cluster or generate.'))
body.push(h3('What matters most'))
body.push(bullet('**Themes** — the subjects every post is scored against. Change these and you change what the tool considers relevant at all.'))
body.push(bullet('**Relevance threshold** — the bar a post must clear. It reaches two screens: a post below it is excluded from the topic grouping *and* from the final text.'))
body.push(bullet('**Editorial brief** — the instructions to the model about what this publication is and what it should say. This is the single most important field on the screen. Write it as you would brief a colleague: for example, “emphasise the factors that shape how consumers choose healthy and sustainable food”.'))
body.push(bullet('**Tone** and **Audience** — two closed lists that shift the register of the writing. They are lists rather than free text so that a typo cannot quietly change the result.'))
body.push(bullet('**Company and brand names** — the names replaced wherever they appear. This is where accepted `Find names` suggestions end up.'))
body.push(p('Press `Save` at the top right. An *unsaved changes* marker appears beside it while anything is unsaved.'))

// ---- step 3 ----------------------------------------------------------------
body.push(h1('Step three — Rating'))
body.push(p('Everything collected, scored for how well it fits your themes, with the reasoning shown.'))
body.push(...image('g4-rating.png', 'Figure 4 — Rating. The orange badge at the top left counts posts still waiting to be scored.'))
body.push(h3('Reading a row'))
body.push(bullet('**Overall** — one number out of 100. It is the *highest* single theme score, not an average: a post that is excellent on one theme and irrelevant to the rest still scores high, which is deliberate.'))
body.push(bullet('**Per-theme scores** — the same post measured against each theme separately.'))
body.push(bullet('The paragraph under the title is the model’s own explanation of the score. Read it when a number surprises you.'))
body.push(bullet('**`1 of 6 themes`**, in orange — how many of your themes this post cleared the relevance threshold on. A post showing a low count is narrow, not necessarily weak.'))
body.push(bullet('**`in generation`**, in green — this post is eligible to be used in the final text.'))
body.push(h3('Scoring'))
body.push(p('Press `Score now`. One press scores **up to ten posts**. If more are waiting, press it again — the orange badge tells you how many are left. The list refreshes itself when a batch finishes.'))
body.push(p('`Re-score all` scores everything again from scratch. Use it after you change the themes or the brief, not routinely.'))
body.push(note('If the screen looks empty, do not assume something broke.', [
  'Either nothing was collected in the period you are looking at, or it was collected but not yet scored. The screen tells you which, and gives you the button that fixes it.',
]))

// ---- step 4 ----------------------------------------------------------------
body.push(h1('Step four — Topics'))
body.push(p('Three things happen here, in order, and the screen is laid out in that order.'))
body.push(...image('g5-topics.png', 'Figure 5 — Topics. The line under the heading counts what is anonymised, what is not, and how many topics the selected run found.'))
body.push(h3('First — hide the company names'))
body.push(p('Press `Anonymise now`. This rewrites the collected posts so that company and brand names are replaced with neutral descriptions, using the list in Settings. The publication is written from these rewritten posts, never from the originals.'))
body.push(p('`Redo all` repeats it for everything, including posts already done. Use it only after changing the name list in Settings.'))
body.push(h3('Second — group them into topics'))
body.push(p('Choose a **period start** and **period end** and press `Run clustering`. Posts that say similar things are grouped together; each group is a topic.'))
body.push(p('Why group at all? Because a carousel is a sequence of sections, not a list of links. Grouping is what turns scattered posts into an argument with parts. Each topic becomes one section of the post and one slide of the carousel.'))
body.push(p('The **Viewing run** dropdown lets you look back at an earlier grouping. Posts marked `unclustered` did not resemble anything else closely enough to join a group; they are simply not used this time.'))
body.push(h3('Third — create it'))
body.push(p('The blue box tells you exactly what you are about to make: the period it covers, how many themes became sections, and how many slides that is. Press `Create the carousel`.'))
body.push(p('You get **one post and one carousel** covering that period. The slide count is the number of topics plus an opening and a closing slide.'))
body.push(money('Anonymising, grouping and creating all use a language model and all cost money.', [
  'They are cheap individually. `Redo all` is the expensive one, because it repeats the work for every post.',
]))
body.push(spacer())
body.push(p('When it finishes, the draft is waiting in Review & Approve.'))

// ---- step 5 ----------------------------------------------------------------
body.push(h1('Step five — Review & Approve'))
body.push(p('The screen where the work actually gets judged. It opens with the finished thing, not with a form.'))
body.push(...image('g6-review.png', 'Figure 6 — The draft shown as a reader will meet it: the accompanying words, then the slide, with the slide counter and swipe dots.'))
body.push(p('The list on the left holds every draft. Each entry says whether it is a `post` or a `carousel`, its status, and whether it has been `edited`.'))
body.push(h3('Looking through the carousel'))
body.push(p('Use `‹ Previous` and `Next ›`, or click any thumbnail in the strip, to move between slides. Click a slide to enlarge it.'))
body.push(h3('Editing'))
body.push(...image('g7-bench.png', 'Figure 7 — The bench edits the slide shown above it. The square on the right is the actual file, with its filename.'))
body.push(p('Under the preview you edit **the slide currently on screen** — its heading and its body. Change a word and the slide above redraws a moment later, so you see the result rather than imagining it. While it is redrawing, the download buttons are disabled: you can never save a file that does not match the words in front of you.'))
body.push(h3('Post text — the three fields underneath'))
body.push(table(['Field', 'Drawn on the images?', 'Where it appears'], [
  ['**Title**', 'Yes', 'In the footer of every slide except the first, and as the first heading in the exported file'],
  ['**Caption**', 'No', 'The words posted alongside the images, and in the export'],
  ['**CTA**', 'No', 'The closing line under the caption, and in the export'],
]))
body.push(spacer())
body.push(stop('Press Save edits.', [
  'It turns dark with white text, and an *unsaved edits* marker appears, as soon as you change anything. Nothing you type is kept until you press it — and the Export screen shows the last *saved* version.',
]))
body.push(h3('Approving or rejecting'))
body.push(p('Optionally write a line in **“Why you approved or rejected this”**. It is exactly what it says: a note to yourself, stored with your decision and visible only when you reopen this item. Nothing else reads it and it does not influence future drafts.'))
body.push(p('Then press `Approve` or `Reject`. Approving is what makes a draft available on the Export screen.'))
body.push(h3('Asking for a different draft'))
body.push(p('**Ask for a new draft** writes a fresh version with your note and the current draft in front of the model — for example “too corporate, lead with the enforcement angle”. Leave the box empty for a different take on the same evidence. The existing draft is kept: nothing is overwritten, you get a second one alongside it.'))
body.push(h3('Downloading the images'))
body.push(p('This is the step that produces what you actually upload to LinkedIn. You choose the background:'))
body.push(table(['Option', 'What it is', 'Cost'], [
  ['**Designed template**', 'A designed background drawn by the tool itself. Immediate, no AI involved.', '**Free**'],
  ['**AI background image**', 'One generated picture per slide, based on that slide’s text, with your words drawn on top.', 'Billed per image'],
]))
body.push(spacer())
body.push(p('Nothing is generated until you press the button, and the button tells you how many images it will actually buy. Once a picture exists, changing the wording redraws your text on the same picture at no extra cost — only `Redo` on a single slide buys a new one. Quality is offered as *fastest*, *medium* and *slowest*; higher quality takes longer and costs more.'))
body.push(p('Generating takes a little while and the screen says so throughout — *Drawing…*, *Generating…*, *Redrawing for your edits…*. Then `Download` saves one PNG per slide, 1080×1080, named in reading order.'))

// ---- step 6 ----------------------------------------------------------------
body.push(h1('Step six — Export'))
body.push(p('The final text, as files.'))
body.push(...image('g8-export.png', 'Figure 8 — Export defaults to approved work only. Choose a format, preview it, then download.'))
body.push(bullet('**Status** filters what you see. It starts on `approved`, because that is normally what you want to send out.'))
body.push(bullet('**MD / JSON / DOCX** choose the format — Markdown, raw data, or a Word document.'))
body.push(bullet('Select an entry to preview it, or press `Download all`.'))
body.push(note('Export shows your edits; it is the saved version that counts.', [
  'If you edited a draft in Review and pressed Save, the export contains the edited text, not the model’s original. If you edited and did *not* press Save, it contains the previous version.',
]))
body.push(spacer())
body.push(p('The images are not here. They are downloaded on the Review & Approve screen, because they are made from the text you are looking at there. Export is for the words.'))

// ---- reference -------------------------------------------------------------
body.push(h1('The four status words'))
body.push(table(['Status', 'Meaning'], [
  ['**draft**', 'Written by the tool, not yet judged by a person. The normal starting state.'],
  ['**approved**', 'A person read it and accepted it. This is what Export shows by default.'],
  ['**rejected**', 'A person read it and decided it should not go out. It is kept, not deleted.'],
  ['**superseded**', 'A newer draft answered this one — you asked for a new version. The older one is kept so the history stays readable, and is hidden by default.'],
]))
body.push(spacer())
body.push(p('Nothing is ever destroyed by these decisions. A rejected draft and the model’s original wording both remain, which is what makes it possible to see later what was written, what was changed, and by whom.'))

body.push(h1('What you can change'))
body.push(p('There are two levels of access. Both see everything and both can run the whole process end to end. The difference is a short list of actions that add, rename or permanently delete.'))
body.push(table(['Action', 'Ordinary user'], [
  ['Collect, score, anonymise, group, create, review, approve, download, export', 'Yes'],
  ['Change any setting on the Settings screen', 'Yes'],
  ['Change a source’s lookback, or switch it on and off', 'Yes'],
  ['Add a new source', 'No — ask the team'],
  ['Rename a source or change its address', 'No'],
  ['Delete a source, or delete generated text', 'No'],
]))
body.push(spacer())
body.push(p('During the trial, sources are added for you. If you want a page watched, ask — it takes a minute.'))

body.push(h1('What costs money'))
body.push(p('Not everything does, and it is worth knowing which is which before you explore.'))
body.push(table(['Action', 'Charged?'], [
  ['Collect, Collect all enabled', 'Yes — the LinkedIn data provider'],
  ['Find names', 'Yes — a language model'],
  ['Score now, Re-score all', 'Yes, per post'],
  ['Anonymise now, Redo all', 'Yes, per post'],
  ['Run clustering, Create the carousel', 'Yes'],
  ['Ask for a new draft', 'Yes'],
  ['AI background images', 'Yes, per image'],
  ['**Designed template slides**', '**No** — drawn by the tool'],
  ['**Reading, editing, approving, downloading, exporting**', '**No**'],
]))
body.push(spacer())
body.push(p('Editing text and redrawing template slides is free and unlimited. Explore there as much as you like.'))

body.push(h1('If something looks wrong'))
body.push(h3('A screen is empty'))
body.push(p('Almost always the previous step has not been run, or the period you are looking at has nothing in it. Each screen says which of the two it is. Widen the period, or go back one screen.'))
body.push(h3('A red message appears'))
body.push(p('Read it — it says what happened. If it mentions permissions, it is one of the admin-only actions in the table above. If it mentions the provider, the request did not get through and trying again later is reasonable. Messages disappear after a few seconds; if you missed one, repeat the action and read it this time.'))
body.push(h3('Nothing new was collected'))
body.push(p('Look at the second half of the result message. “46 outside your lookback window” means posts were found but were older than the lookback set for that source. Raise the lookback and collect again.'))
body.push(h3('Find names returned nothing'))
body.push(p('That is a normal answer, not a fault. It means nothing new was proposed beyond what is already in the list — or there were no collected posts in that source’s window to read.'))
body.push(h3('The images do not match what I just typed'))
body.push(p('They will, a moment after you stop typing. While a redraw is pending the screen says *Redrawing for your edits…* and the download buttons are disabled on purpose. Wait for the count to read *ready*.'))

body.push(new Paragraph({
  spacing: { before: 400 },
  children: [new TextRun({
    text: 'Written for the TechnoAlimenti trial. Screens, labels and behaviour described here were checked against the live application on 16 September 2026, signed in as an ordinary user. If the product changes, this document will drift — report anything that no longer matches.',
    italics: true, size: 18, color: '667085',
  })],
}))

// ===========================================================================

const doc = new Document({
  creator: 'CUES Post Generator',
  title: 'CUES Post Generator — User handbook',
  description: 'English user handbook for the CUES Post Generator',
  styles: {
    default: {
      document: { run: { font: 'Calibri', size: 22, color: '1A2233' }, paragraph: { spacing: { line: 288 } } },
      heading1: { run: { font: 'Calibri Light', size: 40, bold: true, color: '0B1220' } },
      heading2: { run: { font: 'Calibri Light', size: 30, bold: true, color: '0B1220' } },
      heading3: { run: { font: 'Calibri', size: 24, bold: true, color: '0B6E52' } },
    },
  },
  sections: [{
    properties: { page: { margin: { top: 1000, bottom: 1000, left: 1000, right: 1000 } } },
    children: body,
  }],
})

Packer.toBuffer(doc).then((buf) => {
  const out = path.join(__dirname, '..', 'CUES_Post_Generator_User_Guide_EN.docx')
  fs.writeFileSync(out, buf)
  console.log('written:', out)
  console.log('size: %s KB', Math.round(buf.length / 1024))
})
