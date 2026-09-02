import { useCallback, useEffect, useMemo, useState } from 'react'
import { supabase } from '../lib/supabase'
import { useToast } from '../components/toast-context'
import { Spinner, ErrorNotice } from '../components/ui'
import type { Database } from '../lib/database.types'
import type { PostOutput, CarouselOutput } from '../components/generation'
import {
  assetToMarkdown,
  assetToJson,
  assetFilename,
  generationToMarkdown,
  generationToJson,
  generationFilename,
  download,
  type TraceForExport,
  type GenerationExport,
} from '../lib/exporters'

type Asset = Database['public']['Tables']['editorial_assets']['Row']

const STATUSES = ['all', 'approved', 'published', 'draft', 'rejected'] as const
type Status = (typeof STATUSES)[number]
type Format = 'md' | 'json'

// -----------------------------------------------------------------------------

export function Export() {
  const [tab, setTab] = useState<'generated' | 'legacy'>('generated')
  const [statusFilter, setStatusFilter] = useState<Status>('approved')
  const [format, setFormat] = useState<Format>('md')

  return (
    <div>
      <div className="mb-6 flex items-end justify-between gap-6">
        <div className="flex items-center gap-6">
          <h1 className="text-xl font-semibold">Export</h1>
          <div className="inline-flex overflow-hidden rounded-md border border-slate-300 text-sm">
            {(
              [
                ['generated', 'Generated'],
                ['legacy', 'Legacy'],
              ] as const
            ).map(([key, label]) => (
              <button
                key={key}
                onClick={() => setTab(key)}
                className={`px-3 py-1.5 font-medium ${
                  tab === key
                    ? 'bg-slate-900 text-white'
                    : 'bg-white text-slate-600 hover:bg-slate-100'
                }`}
              >
                {label}
              </button>
            ))}
          </div>
        </div>
        <div className="flex items-end gap-4">
          <label className="text-sm">
            <span className="mb-1 block text-slate-600">Status</span>
            <select
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value as Status)}
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
        </div>
      </div>

      {tab === 'generated' ? (
        <GeneratedExport statusFilter={statusFilter} format={format} />
      ) : (
        <LegacyExport statusFilter={statusFilter} format={format} />
      )}
    </div>
  )
}

// -----------------------------------------------------------------------------
// Generated
// -----------------------------------------------------------------------------

type ReviewExportRow = {
  result_id: string
  output_type: 'post' | 'carousel'
  status: string
  edited_output: unknown
  cluster_generation_results: {
    cluster_label: string
    model: string
    created_at: string
    raw_post_ids: string[]
    post_output: unknown
    carousel_output: unknown
  } | null
}

function GeneratedExport({
  statusFilter,
  format,
}: {
  statusFilter: Status
  format: Format
}) {
  const toast = useToast()
  const [rows, setRows] = useState<ReviewExportRow[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [selectedKey, setSelectedKey] = useState<string | null>(null)
  const [postsById, setPostsById] = useState<
    Record<string, { title: string | null; url: string }>
  >({})
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    supabase
      .from('cluster_generation_reviews')
      .select(
        // The FK hint is required since 0023: cluster_generation_reviews now has
        // two foreign keys to cluster_generation_results (result_id and
        // superseded_by_result_id) and PostgREST will not guess between them.
        `result_id, output_type, status, edited_output,
         cluster_generation_results!cluster_generation_reviews_result_id_fkey!inner (
           cluster_label, model, created_at, raw_post_ids, post_output, carousel_output
         )`,
      )
      .order('updated_at', { ascending: false })
      .then(({ data, error }) => {
        if (error) setError(error.message)
        else setRows((data ?? []) as unknown as ReviewExportRow[])
      })
  }, [])

  // Resolve every referenced source post once, so building an export (single or
  // "all") never needs another round trip.
  useEffect(() => {
    if (!rows) return
    const ids = [
      ...new Set(rows.flatMap((r) => r.cluster_generation_results?.raw_post_ids ?? [])),
    ]
    if (ids.length === 0) return
    supabase
      .from('raw_posts')
      .select('id, post_title, source_url')
      .in('id', ids)
      .then(({ data }) => {
        const map: Record<string, { title: string | null; url: string }> = {}
        for (const p of data ?? []) map[p.id] = { title: p.post_title, url: p.source_url }
        setPostsById(map)
      })
  }, [rows])

  const filtered = useMemo(() => {
    if (!rows) return []
    return statusFilter === 'all' ? rows : rows.filter((r) => r.status === statusFilter)
  }, [rows, statusFilter])

  const toExport = useCallback(
    (row: ReviewExportRow): GenerationExport | null => {
      const r = row.cluster_generation_results
      if (!r) return null
      const original = row.output_type === 'post' ? r.post_output : r.carousel_output
      const output = (row.edited_output ?? original) as PostOutput | CarouselOutput | null
      if (!output) return null
      return {
        clusterLabel: r.cluster_label,
        outputType: row.output_type,
        status: row.status,
        model: r.model,
        generatedAt: r.created_at,
        output,
        edited: row.edited_output != null,
        sourcePosts: r.raw_post_ids.map((id) => postsById[id]).filter(Boolean),
      }
    },
    [postsById],
  )

  const selected = useMemo(
    () => filtered.find((r) => `${r.result_id}:${r.output_type}` === selectedKey) ?? null,
    [filtered, selectedKey],
  )

  const preview = useMemo(() => {
    if (!selected) return ''
    const e = toExport(selected)
    if (!e) return ''
    return format === 'md' ? generationToMarkdown(e) : generationToJson(e)
  }, [selected, format, toExport])

  useEffect(() => {
    setCopied(false)
  }, [selected, format])

  function downloadAll() {
    const parts = filtered
      .map(toExport)
      .filter((e): e is GenerationExport => e !== null)
      .map((e) => (format === 'md' ? generationToMarkdown(e) : generationToJson(e)))
    const joined = format === 'md' ? parts.join('\n\n\n') : `[\n${parts.join(',\n')}\n]`
    download(
      `cues-generated-${statusFilter}.${format}`,
      joined,
      format === 'md' ? 'text/markdown' : 'application/json',
    )
    toast.success(`Exported ${parts.length} output${parts.length === 1 ? '' : 's'}`)
  }

  if (error) return <ErrorNotice message={error} />
  if (!rows) return <Spinner label="Loading…" />

  const selectedExport = selected ? toExport(selected) : null

  return (
    <>
      <div className="mb-4 flex items-center justify-between">
        <p className="text-sm text-slate-500">
          {filtered.length} output{filtered.length === 1 ? '' : 's'} · {format.toUpperCase()}
        </p>
        <button
          onClick={downloadAll}
          disabled={filtered.length === 0}
          className="rounded-md border border-slate-300 px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-100 disabled:opacity-50"
        >
          Download all
        </button>
      </div>

      <div className="grid grid-cols-[1fr_1.6fr] gap-6">
        <div className="space-y-2">
          {filtered.map((r) => {
            const key = `${r.result_id}:${r.output_type}`
            return (
              <button
                key={key}
                onClick={() => setSelectedKey(key)}
                className={`w-full rounded-lg border p-3 text-left transition ${
                  key === selectedKey
                    ? 'border-slate-900 bg-white'
                    : 'border-slate-200 bg-white hover:border-slate-400'
                }`}
              >
                <div className="font-medium text-slate-900">
                  {r.cluster_generation_results?.cluster_label ?? '(cluster)'}
                </div>
                <div className="mt-0.5 text-xs text-slate-500">
                  {r.output_type} · {r.status}
                  {r.edited_output != null ? ' · edited' : ''}
                </div>
              </button>
            )
          })}
          {filtered.length === 0 && (
            <p className="rounded-lg border border-dashed border-slate-300 p-4 text-center text-sm text-slate-400">
              No generated outputs with status “{statusFilter}”.
              {statusFilter === 'approved' && (
                <span className="mt-1 block">
                  Nothing is approved until you approve it — open Review, read a
                  draft, and press Approve. Or switch the filter to “all” to see
                  everything that has been generated.
                </span>
              )}
            </p>
          )}
        </div>

        {selectedExport ? (
          <PreviewPane
            filename={generationFilename(selectedExport, format)}
            preview={preview}
            copied={copied}
            onCopy={() => {
              navigator.clipboard.writeText(preview)
              setCopied(true)
            }}
            onDownload={() => {
              download(
                generationFilename(selectedExport, format),
                preview,
                format === 'md' ? 'text/markdown' : 'application/json',
              )
              toast.success('Downloaded')
            }}
          />
        ) : (
          <EmptyPane>Select an output to preview its export</EmptyPane>
        )}
      </div>
    </>
  )
}

// -----------------------------------------------------------------------------
// Legacy
// -----------------------------------------------------------------------------

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

function LegacyExport({
  statusFilter,
  format,
}: {
  statusFilter: Status
  format: Format
}) {
  const toast = useToast()
  const [assets, setAssets] = useState<Asset[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null)
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
      setPreview(format === 'md' ? assetToMarkdown(bundle) : assetToJson(bundle))
    })
    return () => {
      cancelled = true
    }
  }, [selected, format])

  async function downloadAll() {
    const parts: string[] = []
    for (const a of filtered) {
      const trace = await fetchTrace(a.id)
      const bundle = { asset: a, trace }
      parts.push(format === 'md' ? assetToMarkdown(bundle) : assetToJson(bundle))
    }
    const joined = format === 'md' ? parts.join('\n\n\n') : `[\n${parts.join(',\n')}\n]`
    download(
      `cues-legacy-${statusFilter}.${format}`,
      joined,
      format === 'md' ? 'text/markdown' : 'application/json',
    )
    toast.success(`Exported ${filtered.length} asset${filtered.length === 1 ? '' : 's'}`)
  }

  if (error) return <ErrorNotice message={error} />
  if (!assets) return <Spinner label="Loading…" />

  return (
    <>
      <div className="mb-4 flex items-center justify-between">
        <p className="text-sm text-slate-500">
          {filtered.length} asset{filtered.length === 1 ? '' : 's'} · {format.toUpperCase()}
        </p>
        <button
          onClick={downloadAll}
          disabled={filtered.length === 0}
          className="rounded-md border border-slate-300 px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-100 disabled:opacity-50"
        >
          Download all
        </button>
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
          <PreviewPane
            filename={assetFilename(selected, format)}
            preview={preview}
            copied={copied}
            onCopy={() => {
              navigator.clipboard.writeText(preview)
              setCopied(true)
            }}
            onDownload={() => {
              download(
                assetFilename(selected, format),
                preview,
                format === 'md' ? 'text/markdown' : 'application/json',
              )
              toast.success('Downloaded')
            }}
          />
        ) : (
          <EmptyPane>Select an asset to preview its export</EmptyPane>
        )}
      </div>
    </>
  )
}

// -----------------------------------------------------------------------------
// Shared panes
// -----------------------------------------------------------------------------

function PreviewPane({
  filename,
  preview,
  copied,
  onCopy,
  onDownload,
}: {
  filename: string
  preview: string
  copied: boolean
  onCopy: () => void
  onDownload: () => void
}) {
  return (
    <div className="rounded-lg border border-slate-200 bg-white">
      <div className="flex items-center justify-between border-b border-slate-200 px-4 py-2">
        <span className="text-sm font-medium text-slate-700">{filename}</span>
        <div className="flex gap-2">
          <button
            onClick={onCopy}
            className="rounded-md px-2.5 py-1 text-xs font-medium text-slate-600 hover:bg-slate-100"
          >
            {copied ? 'Copied' : 'Copy'}
          </button>
          <button
            onClick={onDownload}
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
  )
}

function EmptyPane({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-center rounded-lg border border-dashed border-slate-300 text-slate-400">
      {children}
    </div>
  )
}
