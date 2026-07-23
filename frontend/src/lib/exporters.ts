import type { Database } from './database.types'

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

export function download(filename: string, content: string, mime: string) {
  const blob = new Blob([content], { type: mime })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  URL.revokeObjectURL(url)
}

export function assetFilename(asset: Asset, ext: string) {
  return `${slug(asset.title ?? asset.asset_type)}.${ext}`
}
