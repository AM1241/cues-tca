import { useCallback, useEffect, useMemo, useState } from 'react'
import { supabase } from '../lib/supabase'
import { useAuth } from '../lib/useAuth'
import { useToast } from '../components/toast-context'
import { Spinner, EmptyState, ErrorNotice } from '../components/ui'
import type { Database, Json } from '../lib/database.types'
import { PER_CLUSTER_GENERATION } from '../lib/features'
import {
  PostOutputCard,
  CarouselOutputCard,
  PostOutputEditor,
  CarouselOutputEditor,
  type PostOutput,
  type CarouselOutput,
} from '../components/generation'
import { SlideDownload } from '../components/SlideDownload'

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
  // Set once a regeneration has answered this draft. Status only moves to
  // 'superseded' from draft/rejected — an approval is never revoked by the
  // pipeline, so an approved row can carry this pointer and stay approved.
  superseded_by_result_id: string | null
  cluster_generation_results: {
    cluster_label: string
    model: string
    created_at: string
    raw_post_ids: string[]
    post_output: unknown
    carousel_output: unknown
    // Needed to ask for a regeneration: the function validates the pair.
    cluster_id: string
    clustering_run_id: string
    // The note that produced THIS draft, if it was itself a regeneration.
    cluster_generation_requests: {
      feedback: string | null
      regenerates_result_id: string | null
    } | null
  } | null
}

const STATUS_STYLES: Record<string, string> = {
  draft: 'bg-slate-100 text-slate-600',
  approved: 'bg-emerald-100 text-emerald-700',
  rejected: 'bg-red-100 text-red-700',
  published: 'bg-blue-100 text-blue-700',
  superseded: 'bg-slate-200 text-slate-500',
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
  // Superseded drafts are hidden by default: a regeneration answers them, and
  // leaving both in one list makes it ambiguous which copy is current. They
  // are never deleted — the toggle brings the whole history back.
  const [showSuperseded, setShowSuperseded] = useState(false)

  const load = useCallback(async () => {
    const { data, error } = await supabase
      .from('cluster_generation_reviews')
      // The FK hints are not decoration: 0023 added
      // cluster_generation_reviews.superseded_by_result_id, so there are now TWO
      // foreign keys from this table to cluster_generation_results and PostgREST
      // refuses to guess which one an embed means. Same for results <-> requests,
      // which 0023 made mutually referencing.
      .select(
        `result_id, output_type, status, edited_output, approved_by, approval_notes,
         superseded_by_result_id,
         cluster_generation_results!cluster_generation_reviews_result_id_fkey!inner (
           cluster_label, model, created_at, raw_post_ids, post_output, carousel_output,
           cluster_id, clustering_run_id, kind, source_cluster_ids, period_start, period_end,
           cluster_generation_requests!cluster_generation_results_generation_request_id_fkey (
             feedback, regenerates_result_id
           )
         )`,
      )
      // Per-cluster drafts are hidden while PER_CLUSTER_GENERATION is off:
      // showing 41 single-theme drafts beside the publication would ask the
      // editor to choose between two different products. The rows are not
      // deleted — flipping the flag brings them straight back. The embed is
      // !inner, so this filters the review rows themselves, not just the embed.
      .filter(
        'cluster_generation_results.kind',
        PER_CLUSTER_GENERATION ? 'in' : 'eq',
        PER_CLUSTER_GENERATION ? '(per_cluster,publication)' : 'publication',
      )
      .order('updated_at', { ascending: false })
    if (error) setError(error.message)
    else setRows((data ?? []) as unknown as ReviewRow[])
  }, [])

  useEffect(() => {
    load()
  }, [load])

  // The selection is resolved against ALL rows, not the visible ones: opening
  // the older draft from a "superseded by" link must work with the filter on.
  const selected = useMemo(
    () => rows?.find((r) => `${r.result_id}:${r.output_type}` === selectedKey) ?? null,
    [rows, selectedKey],
  )

  const visible = useMemo(
    () => (rows ?? []).filter((r) => showSuperseded || r.status !== 'superseded'),
    [rows, showSuperseded],
  )
  const supersededCount = (rows ?? []).filter((r) => r.status === 'superseded').length

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
        {supersededCount > 0 && (
          <label className="mb-1 flex cursor-pointer items-center gap-2 text-xs text-slate-500">
            <input
              type="checkbox"
              checked={showSuperseded}
              onChange={(e) => setShowSuperseded(e.target.checked)}
              className="rounded border-slate-300"
            />
            Show {supersededCount} superseded draft{supersededCount === 1 ? '' : 's'}
          </label>
        )}
        {visible.map((r) => {
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
          onOpenResult={(resultId) => {
            setShowSuperseded(true)
            setSelectedKey(`${resultId}:${selected.output_type}`)
          }}
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
  onOpenResult,
}: {
  row: ReviewRow
  onChanged: () => Promise<void> | void
  onOpenResult: (resultId: string) => void
}) {
  const { session, isAdmin } = useAuth()
  const toast = useToast()
  // Permanent deletion (0027), admin-only: whether the confirm dialog is open.
  const [confirmingDelete, setConfirmingDelete] = useState(false)

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
  const [feedback, setFeedback] = useState('')
  const [regenerating, setRegenerating] = useState(false)

  // The note that produced THIS draft, when it was itself a regeneration.
  const cameFrom = row.cluster_generation_results?.cluster_generation_requests ?? null

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

  /**
   * Asks for a new draft of THIS output, with the editor's note in the prompt.
   * Nothing existing is modified: generate writes a new result and points this
   * review row at it (0023). Scoped to this one output type so feedback about
   * a post never silently replaces a carousel that was already approved.
   */
  async function regenerate() {
    const r = row.cluster_generation_results
    if (!r || regenerating) return
    setRegenerating(true)
    const { data: sessionData } = await supabase.auth.getSession()
    const token = sessionData.session?.access_token
    const { data, error } = await supabase.functions.invoke('generate', {
      body: {
        clustering_run_id: r.clustering_run_id,
        cluster_ids: [r.cluster_id],
        output_types: [row.output_type],
        regenerates_result_id: row.result_id,
        feedback: feedback.trim() || null,
      },
      headers: token ? { Authorization: `Bearer ${token}` } : undefined,
    })
    setRegenerating(false)

    if (error) {
      // Upfront validation (400/404/422) is non-2xx: nothing was written and
      // the real reason is in the body, not supabase-js's generic message.
      let message = error.message
      try {
        const body = await (error as { context?: Response }).context?.json()
        if (body?.error) message = body.error
      } catch {
        /* body already consumed or not JSON */
      }
      toast.error(message)
      return
    }

    const newId = data?.results?.[0]?.generation_result_id as string | undefined
    if (!data?.ok || !newId) {
      // 200 + ok:false — a request row exists and carries the failure detail.
      toast.error(data?.error ?? 'Regeneration did not produce a draft.')
      await onChanged()
      return
    }
    setFeedback('')
    toast.success('New draft generated')
    await onChanged()
    onOpenResult(newId)
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

      {row.superseded_by_result_id && (
        <div className="mt-4 flex items-center justify-between gap-3 rounded-md bg-slate-100 px-3 py-2 text-sm text-slate-600">
          <span>
            {row.status === 'superseded'
              ? 'A newer draft has answered this one.'
              : 'A newer draft exists. This version keeps its ' + row.status + ' status.'}
          </span>
          <button
            onClick={() => onOpenResult(row.superseded_by_result_id!)}
            className="shrink-0 rounded-md border border-slate-300 bg-white px-2.5 py-1 text-xs font-medium text-slate-700 hover:bg-slate-50"
          >
            Open newer draft
          </button>
        </div>
      )}

      {cameFrom?.regenerates_result_id && (
        <div className="mt-4 rounded-md bg-slate-50 px-3 py-2 text-sm text-slate-600">
          {cameFrom.feedback ? (
            <>
              Regenerated from an earlier draft with this note:{' '}
              <span className="italic">&ldquo;{cameFrom.feedback}&rdquo;</span>
            </>
          ) : (
            'Regenerated from an earlier draft, with no note — a different take on the same evidence.'
          )}{' '}
          <button
            onClick={() => onOpenResult(cameFrom.regenerates_result_id!)}
            className="font-medium underline underline-offset-2 hover:text-slate-900"
          >
            Open the earlier draft
          </button>
        </div>
      )}

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

      <hr className="my-5 border-slate-200" />

      <h3 className="text-sm font-semibold text-slate-700">Ask for a new draft</h3>
      <p className="mt-1 text-xs text-slate-500">
        Say what to change and the model rewrites this {row.output_type} with the note and
        the current draft in front of it. Leave the box empty for a different take on the
        same evidence. The existing draft is kept — nothing here is overwritten.
      </p>
      <textarea
        value={feedback}
        onChange={(e) => setFeedback(e.target.value)}
        rows={2}
        maxLength={2000}
        placeholder="e.g. too corporate — lead with the policy angle and cut the closing question"
        className="mt-2 w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
      />
      <button
        onClick={regenerate}
        disabled={regenerating || busy}
        className="mt-2 rounded-md bg-slate-900 px-4 py-1.5 text-sm font-medium text-white hover:bg-slate-800 disabled:opacity-60"
      >
        {regenerating ? 'Generating…' : 'Regenerate'}
      </button>
      {dirty && (
        <p className="mt-2 text-xs text-amber-600">
          You have unsaved edits. Regenerating produces a separate draft and leaves them here,
          but they are still unsaved.
        </p>
      )}

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

      {/* Carousels only: a post has no slides to render. Driven by `draft`,
          which is what is on screen — including unsaved edits — so the files
          match what the operator is actually looking at rather than the last
          saved state. */}
      {draft && row.output_type === 'carousel' && (
        <>
          <hr className="my-5 border-slate-200" />
          <SlideDownload carousel={draft as CarouselOutput} />
        </>
      )}

      {/* Admin-only (0027). Separated and unmistakably red: this is the one
          action on this screen that is not append-only-safe — it can delete
          an APPROVED result, on deliberate operator instruction, which is why
          it lives apart from Approve/Reject rather than beside them. */}
      {isAdmin && (
        <>
          <hr className="my-5 border-slate-200" />
          <h3 className="text-sm font-semibold text-red-700">Danger zone</h3>
          <p className="mt-1 text-xs text-slate-500">
            Permanently deletes this generated result — both its post and
            carousel output, whichever exist, and their reviews. This works
            even on an approved result; nothing else on this screen does.
          </p>
          <button
            onClick={() => setConfirmingDelete(true)}
            className="mt-2 rounded-md border border-red-300 px-3 py-1.5 text-sm font-medium text-red-700 hover:bg-red-50"
          >
            Delete permanently…
          </button>
        </>
      )}

      {confirmingDelete && (
        <DeleteResultDialog
          row={row}
          onClose={() => setConfirmingDelete(false)}
          onDeleted={async () => {
            setConfirmingDelete(false)
            toast.success(`Deleted "${row.cluster_generation_results?.cluster_label}"`)
            await onChanged()
          }}
        />
      )}
    </div>
  )
}

/**
 * Confirmation for admin_delete_generation_result() (0027). Its own dialog
 * rather than a native confirm(): the stakes include an approved, already
 * generated result, and the operator should read a real sentence about that
 * before the red button is even clickable-by-accident.
 */
function DeleteResultDialog({
  row,
  onClose,
  onDeleted,
}: {
  row: ReviewRow
  onClose: () => void
  onDeleted: () => void
}) {
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const g = row.cluster_generation_results
  const outputs = [g?.post_output ? 'post' : null, g?.carousel_output ? 'carousel' : null]
    .filter(Boolean)
    .join(' + ')

  async function confirmDelete() {
    setBusy(true)
    setErr(null)
    const { error } = await supabase.rpc('admin_delete_generation_result', {
      p_result_id: row.result_id,
    })
    setBusy(false)
    if (error) {
      setErr(error.message)
      return
    }
    onDeleted()
  }

  return (
    <div
      className="fixed inset-0 z-10 flex items-center justify-center bg-slate-900/40 px-6"
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-lg rounded-lg bg-white p-6 shadow-xl"
      >
        <h2 className="text-lg font-semibold text-red-700">Delete this result?</h2>
        <p className="mt-3 text-sm text-slate-600">
          Permanently removes "{g?.cluster_label}" — its {outputs || 'output'} and both
          reviews. <span className="font-medium">This cannot be undone.</span>
        </p>
        {row.status === 'approved' && (
          <p className="mt-2 rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-800">
            This is currently <span className="font-medium">approved</span>. Deleting it
            removes it from Export too.
          </p>
        )}
        {err && (
          <div className="mt-4 rounded-md bg-red-50 p-3 text-xs text-red-800">{err}</div>
        )}
        <div className="mt-6 flex justify-end gap-3">
          <button
            type="button"
            onClick={onClose}
            className="rounded-md px-4 py-2 text-sm font-medium text-slate-600 hover:bg-slate-100"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={confirmDelete}
            disabled={busy}
            className="rounded-md bg-red-600 px-4 py-2 text-sm font-medium text-white hover:bg-red-700 disabled:opacity-60"
          >
            {busy ? 'Deleting…' : 'Delete permanently'}
          </button>
        </div>
      </div>
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
