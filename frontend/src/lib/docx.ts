/**
 * Word (.docx) export.
 *
 * Why this is in the browser rather than an Edge Function writing to Storage:
 * the outputs are a few kilobytes of text that the client already holds — it
 * renders them in the preview pane — so a round trip would add a bucket, a
 * storage policy, signed URLs that outlive RLS for their lifetime, and a
 * cleanup job, to move bytes the browser is sitting on. Markdown and JSON have
 * always been produced here; DOCX is the same export in a different container.
 *
 * The `docx` dependency is loaded with a dynamic import so it stays out of the
 * main bundle: it is the heaviest thing in package.json and nothing needs it
 * until somebody picks the format.
 *
 * Hand-rolling OOXML was the alternative and was rejected: a .docx is a ZIP of
 * XML parts, easy to produce and easy to produce ALMOST right, and a file Word
 * refuses to open is worse than no file at all.
 */
import type { PostOutput, CarouselOutput } from '../components/generation'
import type { AssetExport, GenerationExport } from './exporters'

/** Word's own hyperlink character style, present in the default style set. */
const HYPERLINK_STYLE = 'Hyperlink'

type Docx = typeof import('docx')

/**
 * Body text arrives as one string with newlines in it. Word has no concept of a
 * soft line break inside a paragraph here, so each non-empty line becomes its
 * own paragraph — blank lines are what separated them in the source anyway.
 */
function textParagraphs(d: Docx, text: string, spacingAfter = 120) {
  return text
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => new d.Paragraph({ text: line, spacing: { after: spacingAfter } }))
}

function hashtagParagraph(d: Docx, hashtags: string[]) {
  if (hashtags.length === 0) return []
  const text = hashtags.map((h) => (h.startsWith('#') ? h : `#${h}`)).join(' ')
  return [
    new d.Paragraph({
      children: [new d.TextRun({ text, color: '2563EB' })],
      spacing: { after: 240 },
    }),
  ]
}

function ctaParagraph(d: Docx, cta: string) {
  const text = cta.trim()
  if (!text) return []
  return [
    new d.Paragraph({
      children: [new d.TextRun({ text, bold: true })],
      spacing: { after: 240 },
    }),
  ]
}

/** The small grey provenance block that closes every entry. */
function metaParagraphs(d: Docx, lines: string[]) {
  return lines.map(
    (line) =>
      new d.Paragraph({
        children: [new d.TextRun({ text: line, size: 18, color: '64748B' })],
        spacing: { after: 60 },
      }),
  )
}

function sourceParagraphs(
  d: Docx,
  posts: { title: string | null; url: string }[],
) {
  if (posts.length === 0) return []
  return [
    new d.Paragraph({
      text: 'Source posts',
      heading: d.HeadingLevel.HEADING_2,
      spacing: { before: 240, after: 120 },
    }),
    ...posts.map(
      (p) =>
        new d.Paragraph({
          bullet: { level: 0 },
          children: [
            new d.ExternalHyperlink({
              children: [
                new d.TextRun({ text: p.title?.trim() || p.url, style: HYPERLINK_STYLE }),
              ],
              link: p.url,
            }),
          ],
        }),
    ),
  ]
}

function generationParagraphs(d: Docx, e: GenerationExport) {
  const out: InstanceType<Docx['Paragraph']>[] = []

  if (e.outputType === 'post') {
    const p = e.output as PostOutput
    out.push(new d.Paragraph({ text: p.headline, heading: d.HeadingLevel.HEADING_1 }))
    out.push(...textParagraphs(d, p.text))
    out.push(...ctaParagraph(d, p.cta))
    out.push(...hashtagParagraph(d, p.hashtags))
  } else {
    const c = e.output as CarouselOutput
    out.push(new d.Paragraph({ text: c.title, heading: d.HeadingLevel.HEADING_1 }))
    for (const s of [...c.slides].sort((a, b) => a.position - b.position)) {
      out.push(
        new d.Paragraph({
          text: `Slide ${s.position} — ${s.heading}`,
          heading: d.HeadingLevel.HEADING_2,
          spacing: { before: 200, after: 80 },
        }),
      )
      out.push(...textParagraphs(d, s.body))
    }
    out.push(...textParagraphs(d, c.caption, 200))
    out.push(...ctaParagraph(d, c.cta))
  }

  out.push(
    ...metaParagraphs(d, [
      `Cluster: ${e.clusterLabel}`,
      `Output: ${e.outputType}`,
      `Status: ${e.status}`,
      `Model: ${e.model}`,
      `Generated: ${e.generatedAt}`,
      // The reviewer's rewrite and the model's original are separate facts
      // everywhere else in this system; the export must not blur them.
      ...(e.edited ? ['Edited by a reviewer — this is not the model output'] : []),
    ]),
  )
  out.push(...sourceParagraphs(d, e.sourcePosts))
  return out
}

function assetParagraphs(d: Docx, { asset, trace }: AssetExport) {
  const out: InstanceType<Docx['Paragraph']>[] = []
  const hashtags = (asset.hashtags as string[] | null) ?? []

  out.push(
    new d.Paragraph({
      text: asset.title ?? asset.asset_type,
      heading: d.HeadingLevel.HEADING_1,
    }),
  )
  out.push(...textParagraphs(d, asset.generated_text))
  if (asset.cta_text) out.push(...ctaParagraph(d, asset.cta_text))
  out.push(...hashtagParagraph(d, hashtags))

  out.push(
    ...metaParagraphs(d, [
      `Type: ${asset.asset_type}`,
      `Status: ${asset.status}`,
      ...(asset.llm_used === false ? [`Not LLM-generated (${asset.provenance})`] : []),
      ...(asset.is_legacy ? ['Legacy asset'] : []),
    ]),
  )

  if (trace.length) {
    out.push(
      new d.Paragraph({
        text: 'Traceability',
        heading: d.HeadingLevel.HEADING_2,
        spacing: { before: 240, after: 120 },
      }),
    )
    for (const t of trace) {
      out.push(
        new d.Paragraph({
          bullet: { level: 0 },
          text: `${t.claim_text ?? '(claim)'}${t.confidence ? ` — confidence: ${t.confidence}` : ''}`,
        }),
      )
      for (const p of t.posts) {
        out.push(
          new d.Paragraph({
            bullet: { level: 1 },
            children: [
              new d.ExternalHyperlink({
                children: [
                  new d.TextRun({ text: p.title?.trim() || p.url, style: HYPERLINK_STYLE }),
                ],
                link: p.url,
              }),
            ],
          }),
        )
      }
    }
  }
  return out
}

/**
 * A page break BETWEEN entries, never before the first or after the last: a
 * trailing break leaves an empty final page, which is the sort of thing that
 * gets noticed in a document circulated to managers.
 */
function joinWithPageBreaks(
  d: Docx,
  blocks: InstanceType<Docx['Paragraph']>[][],
): InstanceType<Docx['Paragraph']>[] {
  const out: InstanceType<Docx['Paragraph']>[] = []
  blocks.forEach((block, i) => {
    if (i > 0) out.push(new d.Paragraph({ children: [new d.PageBreak()] }))
    out.push(...block)
  })
  return out
}

async function build(
  title: string,
  toBlocks: (d: Docx) => InstanceType<Docx['Paragraph']>[][],
): Promise<Blob> {
  const d = await import('docx')
  const doc = new d.Document({
    title,
    creator: 'CUES Editorial Cloud',
    description: title,
    sections: [{ children: joinWithPageBreaks(d, toBlocks(d)) }],
  })
  return d.Packer.toBlob(doc)
}

export function generationsToDocx(
  exports: GenerationExport[],
  title: string,
): Promise<Blob> {
  return build(title, (d) => exports.map((e) => generationParagraphs(d, e)))
}

export function assetsToDocx(assets: AssetExport[], title: string): Promise<Blob> {
  return build(title, (d) => assets.map((a) => assetParagraphs(d, a)))
}
