import { useEffect, useMemo, useState } from 'react'
import { supabase } from '../lib/supabase'
import { useAuth } from '../lib/useAuth'
import { useToast } from '../components/toast-context'
import { Spinner, EmptyState, ErrorNotice } from '../components/ui'
import type { Database } from '../lib/database.types'

type Asset = Database['public']['Tables']['editorial_assets']['Row']

// A traceability link with the source posts it cites. The pipeline writes these;
// editors only read them.
type TraceLink = {
  id: string
  claim_text: string | null
  confidence: string | null
  traceability_link_posts: {
    raw_posts: { post_title: string | null; source_url: string } | null
  }[]
}

const STATUS_STYLES: Record<string, string> = {
  draft: 'bg-slate-100 text-slate-600',
  approved: 'bg-emerald-100 text-emerald-700',
  rejected: 'bg-red-100 text-red-700',
  published: 'bg-blue-100 text-blue-700',
}

export function Review() {
  const [assets, setAssets] = useState<Asset[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null)

  async function load() {
    const { data, error } = await supabase
      .from('editorial_assets')
      .select('*')
      .order('created_at', { ascending: false })
    if (error) setError(error.message)
    else setAssets(data)
  }

  useEffect(() => {
    load()
  }, [])

  const selected = useMemo(
    () => assets?.find((a) => a.id === selectedId) ?? null,
    [assets, selectedId],
  )

  if (error) return <ErrorNotice message={error} />
  if (!assets) return <Spinner label="Loading assets…" />

  return (
    <div>
      <h1 className="mb-6 text-xl font-semibold">Review</h1>

      <div className="grid grid-cols-[1fr_1.6fr] gap-6">
        <div className="space-y-2">
          {assets.map((a) => (
            <button
              key={a.id}
              onClick={() => setSelectedId(a.id)}
              className={`w-full rounded-lg border p-3 text-left transition ${
                a.id === selectedId
                  ? 'border-slate-900 bg-white'
                  : 'border-slate-200 bg-white hover:border-slate-400'
              }`}
            >
              <div className="flex items-start justify-between gap-2">
                <span className="font-medium text-slate-900">
                  {a.title || '(untitled)'}
                </span>
                <span
                  className={`shrink-0 rounded px-1.5 py-0.5 text-xs font-medium ${
                    STATUS_STYLES[a.status] ?? 'bg-slate-100 text-slate-600'
                  }`}
                >
                  {a.status}
                </span>
              </div>
              <div className="mt-1.5 flex flex-wrap gap-1.5">
                <Badge>{a.asset_type}</Badge>
                {a.is_legacy && <Badge tone="amber">legacy</Badge>}
                {a.llm_used === false && (
                  <Badge tone="red">no LLM ({a.provenance})</Badge>
                )}
              </div>
            </button>
          ))}
        </div>

        {selected ? (
          <AssetDetail
            key={selected.id}
            asset={selected}
            onChanged={load}
          />
        ) : (
          <div className="flex items-center">
            <EmptyState>Select an asset to review</EmptyState>
          </div>
        )}
      </div>
    </div>
  )
}

function AssetDetail({
  asset,
  onChanged,
}: {
  asset: Asset
  onChanged: () => void
}) {
  const { session } = useAuth()
  const toast = useToast()
  const [title, setTitle] = useState(asset.title ?? '')
  const [text, setText] = useState(asset.generated_text)
  const [cta, setCta] = useState(asset.cta_text ?? '')
  const [notes, setNotes] = useState(asset.approval_notes ?? '')
  const [busy, setBusy] = useState(false)

  const [links, setLinks] = useState<TraceLink[] | null>(null)
  useEffect(() => {
    supabase
      .from('traceability_links')
      .select(
        `id, claim_text, confidence,
         traceability_link_posts ( raw_posts ( post_title, source_url ) )`,
      )
      .eq('asset_id', asset.id)
      .then(({ data }) => setLinks((data ?? []) as unknown as TraceLink[]))
  }, [asset.id])

  const dirty =
    title !== (asset.title ?? '') ||
    text !== asset.generated_text ||
    cta !== (asset.cta_text ?? '')

  async function update(
    patch: Database['public']['Tables']['editorial_assets']['Update'],
    successMessage: string,
  ) {
    setBusy(true)
    const { error } = await supabase
      .from('editorial_assets')
      .update(patch)
      .eq('id', asset.id)
    setBusy(false)
    if (error) toast.error(error.message)
    else {
      toast.success(successMessage)
      onChanged()
    }
  }

  function saveEdits() {
    return update(
      {
        title: title.trim() || null,
        generated_text: text,
        cta_text: cta.trim() || null,
      },
      'Edits saved',
    )
  }

  function approve() {
    return update(
      {
        status: 'approved',
        approved_by: session?.user.id ?? null,
        approval_timestamp: new Date().toISOString(),
        approval_notes: notes.trim() || null,
      },
      'Asset approved',
    )
  }

  function reject() {
    return update(
      {
        status: 'rejected',
        approved_by: session?.user.id ?? null,
        approval_timestamp: new Date().toISOString(),
        approval_notes: notes.trim() || null,
      },
      'Asset rejected',
    )
  }

  const hashtags = (asset.hashtags as string[] | null) ?? []

  return (
    <div className="rounded-lg border border-slate-200 bg-white p-5">
      {(asset.is_legacy || asset.llm_used === false) && (
        <div className="mb-4 rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-800">
          {asset.llm_used === false
            ? `This asset was not produced by a live LLM call (${asset.provenance}). Treat its copy as unverified.`
            : 'Legacy asset migrated from the old system.'}
        </div>
      )}

      <label className="block text-sm">
        <span className="mb-1 block font-medium text-slate-700">Title</span>
        <input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          className="w-full rounded-md border border-slate-300 px-3 py-2"
        />
      </label>

      <label className="mt-4 block text-sm">
        <span className="mb-1 block font-medium text-slate-700">
          Generated text
        </span>
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          rows={12}
          className="w-full rounded-md border border-slate-300 px-3 py-2 font-mono text-xs leading-relaxed"
        />
      </label>

      <label className="mt-4 block text-sm">
        <span className="mb-1 block font-medium text-slate-700">CTA</span>
        <input
          value={cta}
          onChange={(e) => setCta(e.target.value)}
          className="w-full rounded-md border border-slate-300 px-3 py-2"
        />
      </label>

      {hashtags.length > 0 && (
        <div className="mt-3 flex flex-wrap gap-1.5">
          {hashtags.map((h) => (
            <span
              key={h}
              className="rounded bg-slate-100 px-2 py-0.5 text-xs text-slate-600"
            >
              {h.startsWith('#') ? h : `#${h}`}
            </span>
          ))}
        </div>
      )}

      <div className="mt-4 flex items-center gap-3">
        <button
          onClick={saveEdits}
          disabled={busy || !dirty}
          className="rounded-md border border-slate-300 px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-100 disabled:opacity-50"
        >
          Save edits
        </button>
        {dirty && <span className="text-xs text-amber-600">unsaved edits</span>}
      </div>

      <hr className="my-5 border-slate-200" />

      <label className="block text-sm">
        <span className="mb-1 block font-medium text-slate-700">
          Review notes
        </span>
        <textarea
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          rows={2}
          className="w-full rounded-md border border-slate-300 px-3 py-2"
        />
      </label>

      <div className="mt-3 flex gap-3">
        <button
          onClick={approve}
          disabled={busy}
          className="rounded-md bg-emerald-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-emerald-700 disabled:opacity-60"
        >
          Approve
        </button>
        <button
          onClick={reject}
          disabled={busy}
          className="rounded-md bg-red-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-red-700 disabled:opacity-60"
        >
          Reject
        </button>
        <span className="self-center text-sm text-slate-500">
          Current: <span className="font-medium">{asset.status}</span>
        </span>
      </div>

      <hr className="my-5 border-slate-200" />

      <h3 className="text-sm font-semibold text-slate-700">
        Traceability{links ? ` (${links.length})` : ''}
      </h3>
      {!links ? (
        <p className="mt-2 text-sm text-slate-400">Loading…</p>
      ) : links.length === 0 ? (
        <p className="mt-2 text-sm text-slate-400">No traceability links.</p>
      ) : (
        <ul className="mt-2 space-y-2">
          {links.map((l) => (
            <li key={l.id} className="rounded-md bg-slate-50 p-3 text-sm">
              {l.claim_text && (
                <p className="text-slate-700">{l.claim_text}</p>
              )}
              <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1">
                {l.confidence && (
                  <span className="text-xs text-slate-500">
                    confidence: {l.confidence}
                  </span>
                )}
                {l.traceability_link_posts.map((p, i) =>
                  p.raw_posts ? (
                    <a
                      key={i}
                      href={p.raw_posts.source_url}
                      target="_blank"
                      rel="noreferrer"
                      className="text-xs text-slate-500 hover:underline"
                    >
                      {p.raw_posts.post_title?.slice(0, 40) || 'source post'}
                    </a>
                  ) : null,
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

function Badge({
  children,
  tone = 'slate',
}: {
  children: React.ReactNode
  tone?: 'slate' | 'amber' | 'red'
}) {
  const styles = {
    slate: 'bg-slate-100 text-slate-600',
    amber: 'bg-amber-100 text-amber-700',
    red: 'bg-red-100 text-red-700',
  }[tone]
  return (
    <span className={`rounded px-1.5 py-0.5 text-xs font-medium ${styles}`}>
      {children}
    </span>
  )
}
