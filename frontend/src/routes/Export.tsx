import { useEffect, useMemo, useState } from 'react'
import { supabase } from '../lib/supabase'
import { useToast } from '../components/toast-context'
import { Spinner, ErrorNotice } from '../components/ui'
import type { Database } from '../lib/database.types'
import {
  assetToMarkdown,
  assetToJson,
  assetFilename,
  download,
  type TraceForExport,
} from '../lib/exporters'

type Asset = Database['public']['Tables']['editorial_assets']['Row']

const STATUSES = ['all', 'approved', 'published', 'draft', 'rejected'] as const

async function fetchTrace(assetId: string): Promise<TraceForExport[]> {
  const { data } = await supabase
    .from('traceability_links')
    .select(
      `claim_text, confidence,
       traceability_link_posts ( raw_posts ( post_title, source_url ) )`,
    )
    .eq('asset_id', assetId)
  type Row = {
    claim_text: string | null
    confidence: string | null
    traceability_link_posts: {
      raw_posts: { post_title: string | null; source_url: string } | null
    }[]
  }
  return ((data ?? []) as unknown as Row[]).map((l) => ({
    claim_text: l.claim_text,
    confidence: l.confidence,
    posts: l.traceability_link_posts
      .map((p) => p.raw_posts)
      .filter((p): p is NonNullable<typeof p> => p !== null)
      .map((p) => ({ title: p.post_title, url: p.source_url })),
  }))
}

export function Export() {
  const toast = useToast()
  const [assets, setAssets] = useState<Asset[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [statusFilter, setStatusFilter] =
    useState<(typeof STATUSES)[number]>('approved')
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [format, setFormat] = useState<'md' | 'json'>('md')
  const [preview, setPreview] = useState<string>('')
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    supabase
      .from('editorial_assets')
      .select('*')
      .order('created_at', { ascending: false })
      .then(({ data, error }) => {
        if (error) setError(error.message)
        else setAssets(data)
      })
  }, [])

  const filtered = useMemo(() => {
    if (!assets) return []
    return statusFilter === 'all'
      ? assets
      : assets.filter((a) => a.status === statusFilter)
  }, [assets, statusFilter])

  const selected = useMemo(
    () => assets?.find((a) => a.id === selectedId) ?? null,
    [assets, selectedId],
  )

  // Rebuild the preview whenever the selected asset or format changes.
  useEffect(() => {
    setCopied(false)
    if (!selected) {
      setPreview('')
      return
    }
    let cancelled = false
    fetchTrace(selected.id).then((trace) => {
      if (cancelled) return
      const bundle = { asset: selected, trace }
      setPreview(
        format === 'md' ? assetToMarkdown(bundle) : assetToJson(bundle),
      )
    })
    return () => {
      cancelled = true
    }
  }, [selected, format])

  async function downloadSelected() {
    if (!selected) return
    download(
      assetFilename(selected, format),
      preview,
      format === 'md' ? 'text/markdown' : 'application/json',
    )
    toast.success('Downloaded')
  }

  async function downloadAll() {
    // Concatenate every filtered asset into a single file, trace included.
    const parts: string[] = []
    for (const a of filtered) {
      const trace = await fetchTrace(a.id)
      const bundle = { asset: a, trace }
      parts.push(
        format === 'md' ? assetToMarkdown(bundle) : assetToJson(bundle),
      )
    }
    const joined =
      format === 'md'
        ? parts.join('\n\n\n')
        : `[\n${parts.join(',\n')}\n]`
    download(
      `cues-export-${statusFilter}.${format}`,
      joined,
      format === 'md' ? 'text/markdown' : 'application/json',
    )
    toast.success(`Exported ${filtered.length} asset${filtered.length === 1 ? '' : 's'}`)
  }

  if (error) return <ErrorNotice message={error} />
  if (!assets) return <Spinner label="Loading…" />

  return (
    <div>
      <div className="mb-6 flex items-end justify-between">
        <div>
          <h1 className="text-xl font-semibold">Export</h1>
          <p className="mt-1 text-sm text-slate-500">
            {filtered.length} asset{filtered.length === 1 ? '' : 's'} · {format.toUpperCase()}
          </p>
        </div>
        <div className="flex items-end gap-4">
          <label className="text-sm">
            <span className="mb-1 block text-slate-600">Status</span>
            <select
              value={statusFilter}
              onChange={(e) =>
                setStatusFilter(e.target.value as (typeof STATUSES)[number])
              }
              className="rounded-md border border-slate-300 px-2 py-1.5 text-sm"
            >
              {STATUSES.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
          </label>
          <div className="inline-flex overflow-hidden rounded-md border border-slate-300 text-sm">
            {(['md', 'json'] as const).map((f) => (
              <button
                key={f}
                onClick={() => setFormat(f)}
                className={`px-3 py-1.5 font-medium ${
                  format === f
                    ? 'bg-slate-900 text-white'
                    : 'bg-white text-slate-600 hover:bg-slate-100'
                }`}
              >
                {f.toUpperCase()}
              </button>
            ))}
          </div>
          <button
            onClick={downloadAll}
            disabled={filtered.length === 0}
            className="rounded-md border border-slate-300 px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-100 disabled:opacity-50"
          >
            Download all
          </button>
        </div>
      </div>

      <div className="grid grid-cols-[1fr_1.6fr] gap-6">
        <div className="space-y-2">
          {filtered.map((a) => (
            <button
              key={a.id}
              onClick={() => setSelectedId(a.id)}
              className={`w-full rounded-lg border p-3 text-left transition ${
                a.id === selectedId
                  ? 'border-slate-900 bg-white'
                  : 'border-slate-200 bg-white hover:border-slate-400'
              }`}
            >
              <div className="font-medium text-slate-900">
                {a.title || '(untitled)'}
              </div>
              <div className="mt-0.5 text-xs text-slate-500">
                {a.asset_type} · {a.status}
              </div>
            </button>
          ))}
          {filtered.length === 0 && (
            <p className="rounded-lg border border-dashed border-slate-300 p-4 text-center text-sm text-slate-400">
              No assets with status “{statusFilter}”.
            </p>
          )}
        </div>

        {selected ? (
          <div className="rounded-lg border border-slate-200 bg-white">
            <div className="flex items-center justify-between border-b border-slate-200 px-4 py-2">
              <span className="text-sm font-medium text-slate-700">
                {assetFilename(selected, format)}
              </span>
              <div className="flex gap-2">
                <button
                  onClick={() => {
                    navigator.clipboard.writeText(preview)
                    setCopied(true)
                  }}
                  className="rounded-md px-2.5 py-1 text-xs font-medium text-slate-600 hover:bg-slate-100"
                >
                  {copied ? 'Copied' : 'Copy'}
                </button>
                <button
                  onClick={downloadSelected}
                  className="rounded-md bg-slate-900 px-2.5 py-1 text-xs font-medium text-white hover:bg-slate-800"
                >
                  Download
                </button>
              </div>
            </div>
            <pre className="max-h-[70vh] overflow-auto px-4 py-3 text-xs leading-relaxed whitespace-pre-wrap text-slate-800">
              {preview || 'Building preview…'}
            </pre>
          </div>
        ) : (
          <div className="flex items-center justify-center rounded-lg border border-dashed border-slate-300 text-slate-400">
            Select an asset to preview its export
          </div>
        )}
      </div>
    </div>
  )
}
