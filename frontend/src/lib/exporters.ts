import type { Database } from './database.types'
import type { PostOutput, CarouselOutput } from '../components/generation'

type Asset = Database['public']['Tables']['editorial_assets']['Row']

export type TraceForExport = {
  claim_text: string | null
  confidence: string | null
  posts: { title: string | null; url: string }[]
}

export type AssetExport = {
  asset: Asset
  trace: TraceForExport[]
}

function slug(s: string) {
  return (
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/(^-|-$)/g, '')
      .slice(0, 60) || 'asset'
  )
}

export function assetToMarkdown({ asset, trace }: AssetExport): string {
  const hashtags = (asset.hashtags as string[] | null) ?? []
  const lines: string[] = []

  if (asset.title) lines.push(`# ${asset.title}`, '')
  lines.push(asset.generated_text.trim(), '')

  if (asset.cta_text) lines.push(`**${asset.cta_text.trim()}**`, '')

  if (hashtags.length) {
    lines.push(
      hashtags.map((h) => (h.startsWith('#') ? h : `#${h}`)).join(' '),
      '',
    )
  }

  lines.push('---', '', `- Type: ${asset.asset_type}`, `- Status: ${asset.status}`)
  if (asset.llm_used === false)
    lines.push(`- ⚠️ Not LLM-generated (${asset.provenance})`)
  if (asset.is_legacy) lines.push('- Legacy asset')

  if (trace.length) {
    lines.push('', '## Traceability', '')
    for (const t of trace) {
      lines.push(`- ${t.claim_text ?? '(claim)'}${t.confidence ? ` — confidence: ${t.confidence}` : ''}`)
      for (const p of t.posts) {
        lines.push(`  - [${p.title ?? 'source post'}](${p.url})`)
      }
    }
  }

  return lines.join('\n') + '\n'
}

export function assetToJson({ asset, trace }: AssetExport): string {
  return JSON.stringify(
    {
      id: asset.id,
      title: asset.title,
      asset_type: asset.asset_type,
      status: asset.status,
      generated_text: asset.generated_text,
      cta_text: asset.cta_text,
      hashtags: asset.hashtags,
      is_legacy: asset.is_legacy,
      provenance: asset.provenance,
      llm_used: asset.llm_used,
      approval_notes: asset.approval_notes,
      approval_timestamp: asset.approval_timestamp,
      traceability: trace,
    },
    null,
    2,
  )
}

// --- Generated copy (cluster_generation_reviews over cluster_generation_results)

export type GenerationExport = {
  clusterLabel: string
  outputType: 'post' | 'carousel'
  status: string
  model: string
  generatedAt: string
  /** The output in force: the reviewer's edit if there is one, else the model's. */
  output: PostOutput | CarouselOutput
  /** True when a reviewer replaced the model's output. */
  edited: boolean
  sourcePosts: { title: string | null; url: string }[]
}

export function generationToMarkdown(e: GenerationExport): string {
  const lines: string[] = []

  if (e.outputType === 'post') {
    const p = e.output as PostOutput
    lines.push(`# ${p.headline}`, '', p.text.trim(), '', `**${p.cta.trim()}**`, '')
    if (p.hashtags.length) {
      lines.push(p.hashtags.map((h) => (h.startsWith('#') ? h : `#${h}`)).join(' '), '')
    }
  } else {
    const c = e.output as CarouselOutput
    lines.push(`# ${c.title}`, '')
    for (const s of [...c.slides].sort((a, b) => a.position - b.position)) {
      lines.push(`## Slide ${s.position} — ${s.heading}`, '', s.body.trim(), '')
    }
    lines.push(c.caption.trim(), '', `**${c.cta.trim()}**`, '')
  }

  lines.push(
    '---',
    '',
    `- Cluster: ${e.clusterLabel}`,
    `- Output: ${e.outputType}`,
    `- Status: ${e.status}`,
    `- Model: ${e.model}`,
    `- Generated: ${e.generatedAt}`,
  )
  if (e.edited) lines.push('- ✎ Edited by a reviewer (the model output differs)')

  if (e.sourcePosts.length) {
    lines.push('', '## Source posts', '')
    for (const p of e.sourcePosts) {
      lines.push(`- [${p.title ?? 'source post'}](${p.url})`)
    }
  }

  return lines.join('\n') + '\n'
}

export function generationToJson(e: GenerationExport): string {
  return JSON.stringify(
    {
      cluster_label: e.clusterLabel,
      output_type: e.outputType,
      status: e.status,
      model: e.model,
      generated_at: e.generatedAt,
      edited_by_reviewer: e.edited,
      output: e.output,
      source_posts: e.sourcePosts,
    },
    null,
    2,
  )
}

export function generationFilename(e: GenerationExport, ext: string) {
  return `${slug(`${e.clusterLabel}-${e.outputType}`)}.${ext}`
}

export function downloadBlob(filename: string, blob: Blob) {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  URL.revokeObjectURL(url)
}

export function download(filename: string, content: string, mime: string) {
  downloadBlob(filename, new Blob([content], { type: mime }))
}

export function assetFilename(asset: Asset, ext: string) {
  return `${slug(asset.title ?? asset.asset_type)}.${ext}`
}
