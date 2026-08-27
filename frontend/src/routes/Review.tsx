import { useCallback, useEffect, useMemo, useState } from 'react'
import { supabase } from '../lib/supabase'
import { useAuth } from '../lib/useAuth'
import { useToast } from '../components/toast-context'
import { Spinner, EmptyState, ErrorNotice } from '../components/ui'
import type { Database, Json } from '../lib/database.types'
import {
  PostOutputCard,
  CarouselOutputCard,
  PostOutputEditor,
  CarouselOutputEditor,
  type PostOutput,
  type CarouselOutput,
} from '../components/generation'

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

// One reviewable output: a row of cluster_generation_reviews joined to the
// immutable result it reviews. `output_type` decides which of the result's two
// output columns this row is about.
type ReviewRow = {
  result_id: string
  output_type: 'post' | 'carousel'
  status: string
  edited_output: unknown
  approved_by: string | null
  approval_notes: string | null
  cluster_generation_results: {
    cluster_label: string
    model: string
    created_at: string
    raw_post_ids: string[]
    post_output: unknown
    carousel_output: unknown
  } | null
}

const STATUS_STYLES: Record<string, string> = {
  draft: 'bg-slate-100 text-slate-600',
  approved: 'bg-emerald-100 text-emerald-700',
  rejected: 'bg-red-100 text-red-700',
  published: 'bg-blue-100 text-blue-700',
}

/** The output actually in force: the editor's version if there is one. */
function effectiveOutput(row: ReviewRow): PostOutput | CarouselOutput | null {
  if (row.edited_output) return row.edited_output as PostOutput | CarouselOutput
  const r = row.cluster_generation_results
  if (!r) return null
  const original = row.output_type === 'post' ? r.post_output : r.carousel_output
  return (original as PostOutput | CarouselOutput) ?? null
}

export function Review() {
  const [tab, setTab] = useState<'generated' | 'legacy'>('generated')

  return (
    <div>
      <div className="mb-6 flex items-center gap-6">
        <h1 className="text-xl font-semibold">Review</h1>
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

      {tab === 'generated' ? <GeneratedReview /> : <LegacyReview />}
    </div>
  )
}

// -----------------------------------------------------------------------------
// Generated — cluster_generation_reviews over cluster_generation_results
// -----------------------------------------------------------------------------
function GeneratedReview() {
  const [rows, setRows] = useState<ReviewRow[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [selectedKey, setSelectedKey] = useState<string | null>(null)

  const load = useCallback(async () => {
    const { data, error } = await supabase
      .from('cluster_generation_reviews')
      .select(
        `result_id, output_type, status, edited_output, approved_by, approval_notes,
         cluster_generation_results!inner (
           cluster_label, model, created_at, raw_post_ids, post_output, carousel_output
         )`,
      )
      .order('updated_at', { ascending: false })
    if (error) setError(error.message)
    else setRows((data ?? []) as unknown as ReviewRow[])
  }, [])

  useEffect(() => {
    load()
  }, [load])

  const selected = useMemo(
    () => rows?.find((r) => `${r.result_id}:${r.output_type}` === selectedKey) ?? null,
    [rows, selectedKey],
  )

  if (error) return <ErrorNotice message={error} />
  if (!rows) return <Spinner label="Loading generated copy…" />
  if (rows.length === 0)
    return (
      <EmptyState>
        Nothing generated yet — run a generation from the Clusters view.
      </EmptyState>
    )

  return (
    <div className="grid grid-cols-[1fr_1.6fr] gap-6">
      <div className="space-y-2">
        {rows.map((r) => {
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
              <div className="flex items-start justify-between gap-2">
                <span className="font-medium text-slate-900">
                  {r.cluster_generation_results?.cluster_label ?? '(cluster)'}
                </span>
                <span
                  className={`shrink-0 rounded px-1.5 py-0.5 text-xs font-medium ${
                    STATUS_STYLES[r.status] ?? 'bg-slate-100 text-slate-600'
                  }`}
                >
                  {r.status}
                </span>
              </div>
              <div className="mt-1.5 flex flex-wrap gap-1.5">
                <Badge>{r.output_type}</Badge>
                {r.edited_output != null && <Badge tone="amber">edited</Badge>}
                {r.cluster_generation_results && (
                  <Badge>{r.cluster_generation_results.model}</Badge>
                )}
              </div>
            </button>
          )
        })}
      </div>

      {selected ? (
        <GeneratedDetail
          key={`${selected.result_id}:${selected.output_type}`}
          row={selected}
          onChanged={load}
        />
      ) : (
        <div className="flex items-center">
          <EmptyState>Select an output to review</EmptyState>
        </div>
      )}
    </div>
  )
}

function GeneratedDetail({
  row,
  onChanged,
}: {
  row: ReviewRow
  onChanged: () => void
}) {
  const { session } = useAuth()
  const toast = useToast()

  const original = useMemo(() => {
    const r = row.cluster_generation_results
    if (!r) return null
    return (row.output_type === 'post' ? r.post_output : r.carousel_output) as
      | PostOutput
      | CarouselOutput
      | null
  }, [row])

  const [draft, setDraft] = useState<PostOutput | CarouselOutput | null>(
    () => effectiveOutput(row),
  )
  const [notes, setNotes] = useState(row.approval_notes ?? '')
  const [busy, setBusy] = useState(false)

  const dirty = JSON.stringify(draft) !== JSON.stringify(effectiveOutput(row))

  // Source posts behind this cluster. raw_post_ids is the exact, at-generation
  // -time snapshot on the result, so no join back through "current" state.
  const [posts, setPosts] = useState<
    { id: string; post_title: string | null; source_url: string }[] | null
  >(null)
  useEffect(() => {
    const ids = row.cluster_generation_results?.raw_post_ids ?? []
    if (ids.length === 0) {
      setPosts([])
      return
    }
    supabase
      .from('raw_posts')
      .select('id, post_title, source_url')
      .in('id', ids)
      .then(({ data }) => setPosts(data ?? []))
  }, [row])

  async function patch(
    update: Database['public']['Tables']['cluster_generation_reviews']['Update'],
    successMessage: string,
  ) {
    setBusy(true)
    const { error } = await supabase
      .from('cluster_generation_reviews')
      .update(update)
      .eq('result_id', row.result_id)
      .eq('output_type', row.output_type)
    setBusy(false)
    if (error) toast.error(error.message)
    else {
      toast.success(successMessage)
      onChanged()
    }
  }

  const decide = (status: 'approved' | 'rejected') =>
    patch(
      {
        status,
        approved_by: session?.user.id ?? null,
        approval_timestamp: new Date().toISOString(),
        approval_notes: notes.trim() || null,
      },
      status === 'approved' ? 'Output approved' : 'Output rejected',
    )

  return (
    <div className="rounded-lg border border-slate-200 bg-white p-5">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="font-semibold text-slate-900">
            {row.cluster_generation_results?.cluster_label}
          </h2>
          <p className="mt-0.5 text-xs text-slate-500">
            {row.output_type} · {row.cluster_generation_results?.model} ·{' '}
            {row.cluster_generation_results
              ? new Date(row.cluster_generation_results.created_at).toLocaleString()
              : ''}
          </p>
        </div>
        {row.edited_output != null && (
          <button
            onClick={() => patch({ edited_output: null }, 'Reverted to the generated original')}
            disabled={busy}
            className="shrink-0 rounded-md border border-slate-300 px-2.5 py-1 text-xs font-medium text-slate-600 hover:bg-slate-100 disabled:opacity-50"
          >
            Revert to original
          </button>
        )}
      </div>

      {row.edited_output != null && (
        <div className="mt-4 rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-800">
          Edited by a reviewer. The model's original is preserved and shown below.
        </div>
      )}

      <div className="mt-4">
        {draft && row.output_type === 'post' && (
          <PostOutputEditor
            post={draft as PostOutput}
            onChange={(next) => setDraft(next)}
          />
        )}
        {draft && row.output_type === 'carousel' && (
          <CarouselOutputEditor
            carousel={draft as CarouselOutput}
            onChange={(next) => setDraft(next)}
          />
        )}
      </div>

      <div className="mt-4 flex items-center gap-3">
        <button
          onClick={() =>
            // PostOutput/CarouselOutput are structurally valid JSON, but a named
            // interface is not assignable to the index-signature `Json` type.
            patch({ edited_output: draft as unknown as Json }, 'Edits saved')
          }
          disabled={busy || !dirty}
          className="rounded-md border border-slate-300 px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-100 disabled:opacity-50"
        >
          Save edits
        </button>
        {dirty && <span className="text-xs text-amber-600">unsaved edits</span>}
      </div>

      <hr className="my-5 border-slate-200" />

      <label className="block text-sm">
        <span className="mb-1 block font-medium text-slate-700">Review notes</span>
        <textarea
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          rows={2}
          className="w-full rounded-md border border-slate-300 px-3 py-2"
        />
      </label>

      <div className="mt-3 flex gap-3">
        <button
          onClick={() => decide('approved')}
          disabled={busy}
          className="rounded-md bg-emerald-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-emerald-700 disabled:opacity-60"
        >
          Approve
        </button>
        <button
          onClick={() => decide('rejected')}
          disabled={busy}
          className="rounded-md bg-red-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-red-700 disabled:opacity-60"
        >
          Reject
        </button>
        <span className="self-center text-sm text-slate-500">
          Current: <span className="font-medium">{row.status}</span>
        </span>
      </div>

      {row.edited_output != null && original && (
        <>
          <hr className="my-5 border-slate-200" />
          <h3 className="mb-2 text-sm font-semibold text-slate-700">
            Generated original
          </h3>
          {row.output_type === 'post' ? (
            <PostOutputCard post={original as PostOutput} />
          ) : (
            <CarouselOutputCard carousel={original as CarouselOutput} />
          )}
        </>
      )}

      <hr className="my-5 border-slate-200" />

      <h3 className="text-sm font-semibold text-slate-700">
        Source posts{posts ? ` (${posts.length})` : ''}
      </h3>
      {!posts ? (
        <p className="mt-2 text-sm text-slate-400">Loading…</p>
      ) : posts.length === 0 ? (
        <p className="mt-2 text-sm text-slate-400">No source posts recorded.</p>
      ) : (
        <ul className="mt-2 space-y-1">
          {posts.map((p) => (
            <li key={p.id}>
              <a
                href={p.source_url}
                target="_blank"
                rel="noreferrer"
                className="text-sm text-slate-500 hover:underline"
              >
                {p.post_title?.trim() || p.source_url}
              </a>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

// -----------------------------------------------------------------------------
// Legacy — the pre-cloud editorial_assets, unchanged
// -----------------------------------------------------------------------------
function LegacyReview() {
  const [assets, setAssets] = useState<Asset[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null)

  const load = useCallback(async () => {
    const { data, error } = await supabase
      .from('editorial_assets')
      .select('*')
      .order('created_at', { ascending: false })
    if (error) setError(error.message)
    else setAssets(data)
  }, [])

  useEffect(() => {
    load()
  }, [load])

  const selected = useMemo(
    () => assets?.find((a) => a.id === selectedId) ?? null,
    [assets, selectedId],
  )

  if (error) return <ErrorNotice message={error} />
  if (!assets) return <Spinner label="Loading assets…" />

  return (
    <>
      <p className="mb-4 text-sm text-slate-500">
        Assets migrated from the pre-cloud system. Nothing in the current pipeline
        writes here.
      </p>
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
          <AssetDetail key={selected.id} asset={selected} onChanged={load} />
        ) : (
          <div className="flex items-center">
            <EmptyState>Select an asset to review</EmptyState>
          </div>
        )}
      </div>
    </>
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
