import { useEffect, useMemo, useState } from 'react'
import { supabase } from '../lib/supabase'
import { useToast } from '../components/toast-context'
import { Spinner, EmptyState, ErrorNotice } from '../components/ui'
import {
  GenerationResultCard,
  GenerationErrorList,
  type GenerationResultView,
  type GenerationErrorView,
} from '../components/generation'

// anonymized_posts_current joined to its raw_post and source, for the
// inspection list. replacements is the audit trail written by anonymize-worker.
type AnonymisedRow = {
  raw_post_id: string
  source_name: string
  generalized_source_name: string
  overall_relevance: number
  anonymized_text: string
  replacements: { original: string; replacement: string; source: string }[]
  raw_posts: {
    post_title: string | null
    post_text: string
    published_at: string
    source_url: string
  } | null
}

// A post that has NOT (yet, or ever) produced an anonymized_posts_current
// row — surfaced from anonymize_job_state so a failed/retrying/dead-lettered
// post doesn't just silently disappear from the inspection view. See
// PHASE4_REQUIREMENTS.md §1: failures must be visible in the inspection UI,
// not just in logs.
type FailedAnonymiseRow = {
  raw_post_id: string
  status: string
  failure_count: number
  last_failure_type: string | null
  last_error_message: string | null
  dead_letter_reason: string | null
  raw_posts: {
    post_title: string | null
    post_text: string
    published_at: string
    source_url: string
  } | null
}

type ClusteringRun = {
  id: string
  period_start: string
  period_end: string
  status: string
  error_message: string | null
  created_at: string
  embedding_model: string
}

// cluster_id -> { label, raw_post_ids } for the selected run, built from
// clusters + cluster_assignments (two separate queries, joined client-side —
// cluster_assignments has no direct FK to raw_posts worth a nested select here).
type ClusterInfo = { id: string; label: string; label_failed: boolean }

// A run input whose embedding call failed — sourced from
// clustering_run_posts.embedding_status, independent of the run's overall
// completed/failed status (a run can complete with some inputs embedded and
// others failed, as long as enough posts remained to cluster).
type FailedEmbeddingRow = {
  raw_post_id: string
  embedding_error_message: string | null
  raw_posts: { post_title: string | null; post_text: string } | null
}

function fmtDate(iso: string) {
  return new Date(iso).toISOString().slice(0, 10)
}

function daysAgo(n: number) {
  const d = new Date()
  d.setDate(d.getDate() - n)
  return d.toISOString().slice(0, 10)
}

export function Clusters() {
  const toast = useToast()

  const [rows, setRows] = useState<AnonymisedRow[] | null>(null)
  const [failedRows, setFailedRows] = useState<FailedAnonymiseRow[]>([])
  const [error, setError] = useState<string | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null)

  const [runs, setRuns] = useState<ClusteringRun[] | null>(null)
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null)
  const [clustersById, setClustersById] = useState<Map<string, ClusterInfo>>(new Map())
  const [assignmentByPost, setAssignmentByPost] = useState<Map<string, string>>(new Map())
  const [failedEmbeddings, setFailedEmbeddings] = useState<FailedEmbeddingRow[]>([])

  const [periodStart, setPeriodStart] = useState(daysAgo(30))
  const [periodEnd, setPeriodEnd] = useState(daysAgo(0))
  const [running, setRunning] = useState(false)
  const [anonymising, setAnonymising] = useState(false)

  // Generate (Phase 5 binding — see PHASE5_FRONTEND_HANDOFF.md). Selection is
  // per-run: switching runs clears it, because cluster_ids are only valid
  // against their own clustering_run_id (422 otherwise).
  const [selectedClusterIds, setSelectedClusterIds] = useState<Set<string>>(new Set())
  const [wantPost, setWantPost] = useState(true)
  const [wantCarousel, setWantCarousel] = useState(true)
  const [generating, setGenerating] = useState(false)
  const [genResults, setGenResults] = useState<GenerationResultView[] | null>(null)
  const [genErrors, setGenErrors] = useState<GenerationErrorView[]>([])
  // Each job is one real LLM entity-extraction call. Defaults low on purpose:
  // PHASE4_COMPLETION.md requires the first real run to be bounded and read
  // before scaling up. Backfill enqueues everything eligible either way; this
  // caps only how many are drained per click.
  const [anonBatch, setAnonBatch] = useState(5)

  async function loadAnonymised() {
    const { data, error } = await supabase
      .from('anonymized_posts_current')
      .select(
        `raw_post_id, source_name, generalized_source_name, overall_relevance, anonymized_text, replacements,
         raw_posts!inner ( post_title, post_text, published_at, source_url )`,
      )
      .order('overall_relevance', { ascending: false })
    if (error) setError(error.message)
    else setRows((data ?? []) as unknown as AnonymisedRow[])
  }

  // Posts whose anonymisation is not (or not yet) successful: pending,
  // processing, or dead_letter job states. A post that succeeded has no row
  // here (its job_state row exists too, status='succeeded', but that is not
  // a failure worth surfacing separately from the anonymised list above).
  async function loadFailedAnonymise() {
    const { data, error } = await supabase
      .from('anonymize_job_state')
      .select(
        `raw_post_id, status, failure_count, last_failure_type, last_error_message,
         raw_posts!inner ( post_title, post_text, published_at, source_url )`,
      )
      .neq('status', 'succeeded')
      .order('updated_at', { ascending: false })
    if (error) {
      toast.error(error.message)
      return
    }
    const jobRows = (data ?? []) as unknown as Omit<FailedAnonymiseRow, 'dead_letter_reason'>[]

    // Dead-lettered jobs carry their fullest error detail in
    // anonymize_dead_letter, not just anonymize_job_state.last_error_message
    // (which is truncated/most-recent-attempt-only) — fetch it for display.
    const deadLetterIds = jobRows.filter((r) => r.status === 'dead_letter').map((r) => r.raw_post_id)
    const reasonByPost = new Map<string, string>()
    if (deadLetterIds.length > 0) {
      const { data: dlRows } = await supabase
        .from('anonymize_dead_letter')
        .select('raw_post_id, failure_type, error_message')
        .in('raw_post_id', deadLetterIds)
      for (const dl of dlRows ?? []) {
        reasonByPost.set(dl.raw_post_id, dl.error_message || dl.failure_type)
      }
    }

    setFailedRows(jobRows.map((r) => ({ ...r, dead_letter_reason: reasonByPost.get(r.raw_post_id) ?? null })))
  }

  async function loadRuns() {
    const { data, error } = await supabase
      .from('clustering_runs')
      .select('id, period_start, period_end, status, error_message, created_at, embedding_model')
      .order('created_at', { ascending: false })
    if (error) {
      toast.error(error.message)
      return
    }
    const list = (data ?? []) as ClusteringRun[]
    setRuns(list)
    // Default to the latest run, per PHASE4_REQUIREMENTS.md's "show the
    // latest run by default while retaining prior runs for audit/debugging".
    if (list.length > 0 && !selectedRunId) setSelectedRunId(list[0].id)
  }

  useEffect(() => {
    loadAnonymised()
    loadFailedAnonymise()
    loadRuns()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    setSelectedClusterIds(new Set())
    if (!selectedRunId) {
      setClustersById(new Map())
      setAssignmentByPost(new Map())
      setFailedEmbeddings([])
      return
    }
    let cancelled = false
    async function loadRunDetail(runId: string) {
      const { data: clusterRows, error: clusterErr } = await supabase
        .from('clusters')
        .select('id, label, label_failed')
        .eq('clustering_run_id', runId)
      if (clusterErr) {
        toast.error(clusterErr.message)
        return
      }
      const cMap = new Map<string, ClusterInfo>()
      for (const c of clusterRows ?? []) cMap.set(c.id, { id: c.id, label: c.label, label_failed: c.label_failed })

      const clusterIds = (clusterRows ?? []).map((c) => c.id)
      const aMap = new Map<string, string>()
      if (clusterIds.length > 0) {
        const { data: assignRows, error: assignErr } = await supabase
          .from('cluster_assignments')
          .select('cluster_id, raw_post_id')
          .in('cluster_id', clusterIds)
        if (assignErr) {
          toast.error(assignErr.message)
          return
        }
        for (const a of assignRows ?? []) aMap.set(a.raw_post_id, a.cluster_id)
      }

      // Minimal visibility into partial embedding failures for this run —
      // independent of the run's overall completed/failed status, since a
      // run can complete with some inputs embedded and others failed.
      const { data: failedRows, error: failedErr } = await supabase
        .from('clustering_run_posts')
        .select('raw_post_id, embedding_error_message, raw_posts ( post_title, post_text )')
        .eq('clustering_run_id', runId)
        .eq('embedding_status', 'failed')
      if (failedErr) {
        toast.error(failedErr.message)
        return
      }

      if (!cancelled) {
        setClustersById(cMap)
        setAssignmentByPost(aMap)
        setFailedEmbeddings((failedRows ?? []) as unknown as FailedEmbeddingRow[])
      }
    }
    loadRunDetail(selectedRunId)
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedRunId])

  // Enqueue eligible scored posts and drain the anonymise queue. `backfill` is
  // handled inside the function because backfill_anonymize_jobs() is
  // service_role-only and deliberately not reachable over PostgREST.
  async function anonymiseNow() {
    if (anonymising) return
    setAnonymising(true)
    const { data: sessionData } = await supabase.auth.getSession()
    const token = sessionData.session?.access_token
    const { data, error } = await supabase.functions.invoke('anonymize-worker', {
      body: { backfill: true, batch_size: anonBatch },
      headers: token ? { Authorization: `Bearer ${token}` } : undefined,
    })
    setAnonymising(false)

    if (error) {
      toast.error(error.message)
      return
    }
    if (data?.ok === false) {
      toast.error(data.error ?? 'Anonymisation failed')
      return
    }
    const t = data?.totals
    if (!t || (t.jobs_read === 0 && t.enqueued === 0)) {
      toast.success('Nothing to anonymise — no eligible scored posts.')
      return
    }
    const parts = [`${t.anonymized} anonymised`]
    if (t.dead_lettered) parts.push(`${t.dead_lettered} dead-lettered`)
    if (t.retried) parts.push(`${t.retried} retrying`)
    toast.success(`${t.enqueued} enqueued, ${t.jobs_read} read — ${parts.join(', ')}`)
    await loadAnonymised()
  }

  async function runClustering() {
    setRunning(true)
    const { data: sessionData } = await supabase.auth.getSession()
    const token = sessionData.session?.access_token
    const { data, error } = await supabase.functions.invoke('cluster', {
      body: {
        period_start: new Date(periodStart).toISOString(),
        period_end: new Date(periodEnd + 'T23:59:59Z').toISOString(),
      },
      headers: token ? { Authorization: `Bearer ${token}` } : undefined,
    })
    setRunning(false)
    if (error) {
      toast.error(error.message)
      return
    }
    if (data?.ok === false) {
      // A genuine failed run (e.g. every embedding failed) — data.error
      // carries the reason; data.run_id may still be set (the run row
      // exists, marked failed, not silently absent).
      toast.error(data.error ?? 'Clustering failed')
      if (data?.run_id) {
        await loadRuns()
        setSelectedRunId(data.run_id)
      }
      return
    }
    const totals = data?.totals
    toast.success(
      totals
        ? `Clustering complete: ${totals.clusters} cluster(s) from ${totals.eligible} post(s)`
        : 'Clustering complete',
    )
    await loadRuns()
    setSelectedRunId(data?.run_id ?? null)
  }

  // Synchronous by design — the function blocks until every requested cluster
  // is done (several seconds per cluster), so the response carries the full
  // outcome and no polling is needed.
  async function generateNow() {
    if (generating || !selectedRunId || selectedClusterIds.size === 0) return
    const output_types = [...(wantPost ? ['post'] : []), ...(wantCarousel ? ['carousel'] : [])]
    if (output_types.length === 0) {
      toast.error('Pick at least one output type.')
      return
    }
    setGenerating(true)
    setGenResults(null)
    setGenErrors([])
    const { data: sessionData } = await supabase.auth.getSession()
    const token = sessionData.session?.access_token
    const { data, error } = await supabase.functions.invoke('generate', {
      body: {
        clustering_run_id: selectedRunId,
        cluster_ids: [...selectedClusterIds],
        output_types,
      },
      headers: token ? { Authorization: `Bearer ${token}` } : undefined,
    })
    setGenerating(false)

    if (error) {
      // Upfront validation errors (400/404/422) are non-2xx: nothing was
      // created, and the real reason is in the response body, not in
      // supabase-js's generic "non-2xx status code" message.
      let message = error.message
      try {
        const body = await (error as { context?: Response }).context?.json()
        if (body?.error) message = body.error
      } catch {
        /* body already consumed or not JSON — keep the generic message */
      }
      toast.error(message)
      return
    }

    setGenResults((data?.results ?? []) as GenerationResultView[])
    setGenErrors((data?.errors ?? []) as GenerationErrorView[])
    if (data?.ok) {
      toast.success(`Generated ${data.results.length} cluster(s)`)
    } else {
      // 200 + ok:false is partial/total generation failure: a request row
      // exists, successful clusters have real results, failed ones are in
      // `errors` — show both rather than discarding the successes.
      toast.error(data?.error ?? 'Generation failed')
    }
  }

  function toggleCluster(id: string) {
    setSelectedClusterIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const selected = useMemo(
    () => rows?.find((r) => r.raw_post_id === selectedId) ?? null,
    [rows, selectedId],
  )
  const selectedFailed = useMemo(
    () => failedRows.find((r) => r.raw_post_id === selectedId) ?? null,
    [failedRows, selectedId],
  )
  const selectedRun = useMemo(
    () => runs?.find((r) => r.id === selectedRunId) ?? null,
    [runs, selectedRunId],
  )
  const postCountByCluster = useMemo(() => {
    const counts = new Map<string, number>()
    for (const clusterId of assignmentByPost.values()) {
      counts.set(clusterId, (counts.get(clusterId) ?? 0) + 1)
    }
    return counts
  }, [assignmentByPost])

  if (error) return <ErrorNotice message={error} />
  if (!rows) return <Spinner label="Loading anonymised posts…" />

  return (
    <div>
      <div className="mb-6 flex items-end justify-between gap-6">
        <div>
          <h1 className="text-xl font-semibold">Anonymised &amp; Clusters</h1>
          <p className="mt-1 text-sm text-slate-500">
            {rows.length} anonymised post{rows.length === 1 ? '' : 's'}
            {failedRows.length > 0 ? ` · ${failedRows.length} not yet anonymised` : ''}
            {selectedRunId && clustersById.size > 0
              ? ` · ${clustersById.size} cluster(s) in the selected run`
              : ''}
          </p>
        </div>

        <div className="flex items-end gap-3">
          <label className="text-sm">
            <span className="mb-1 block text-slate-600">Period start</span>
            <input
              type="date"
              value={periodStart}
              onChange={(e) => setPeriodStart(e.target.value)}
              className="rounded-md border border-slate-300 px-2 py-1.5 text-sm"
            />
          </label>
          <label className="text-sm">
            <span className="mb-1 block text-slate-600">Period end</span>
            <input
              type="date"
              value={periodEnd}
              onChange={(e) => setPeriodEnd(e.target.value)}
              className="rounded-md border border-slate-300 px-2 py-1.5 text-sm"
            />
          </label>
          <label className="text-sm">
            <span className="mb-1 block text-slate-600">Batch</span>
            <input
              type="number"
              min={1}
              max={25}
              value={anonBatch}
              onChange={(e) =>
                setAnonBatch(Math.max(1, Math.min(25, Number(e.target.value) || 1)))
              }
              className="w-16 rounded-md border border-slate-300 px-2 py-1.5 text-sm"
            />
          </label>
          <button
            onClick={anonymiseNow}
            disabled={anonymising || running}
            className="rounded-md border border-slate-300 px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50"
          >
            {anonymising ? 'Anonymising…' : 'Anonymise now'}
          </button>
          <button
            onClick={runClustering}
            disabled={running || anonymising}
            className="rounded-md bg-slate-900 px-4 py-1.5 text-sm font-medium text-white hover:bg-slate-800 disabled:opacity-50"
          >
            {running ? 'Running…' : 'Run clustering'}
          </button>
        </div>
      </div>

      {runs && runs.length > 0 && (
        <div className="mb-4 flex items-center gap-2 text-sm">
          <span className="text-slate-600">Viewing run:</span>
          <select
            value={selectedRunId ?? ''}
            onChange={(e) => setSelectedRunId(e.target.value || null)}
            className="rounded-md border border-slate-300 px-2 py-1 text-sm"
          >
            {runs.map((r) => (
              <option key={r.id} value={r.id}>
                {fmtDate(r.created_at)} — {fmtDate(r.period_start)} to {fmtDate(r.period_end)} ({r.status})
              </option>
            ))}
          </select>
          {(() => {
            const run = runs.find((r) => r.id === selectedRunId)
            return run?.status === 'failed' && run.error_message ? (
              <span className="rounded bg-red-50 px-2 py-1 text-xs text-red-700">{run.error_message}</span>
            ) : null
          })()}
        </div>
      )}

      {failedEmbeddings.length > 0 && (
        <details className="mb-4 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
          <summary className="cursor-pointer font-medium">
            {failedEmbeddings.length} input post{failedEmbeddings.length === 1 ? '' : 's'} failed embedding in this run
          </summary>
          <ul className="mt-2 space-y-1.5 text-xs">
            {failedEmbeddings.map((f) => (
              <li key={f.raw_post_id} className="flex flex-wrap gap-x-2">
                <span className="font-medium">
                  {f.raw_posts?.post_title?.trim() || f.raw_posts?.post_text.slice(0, 50).trim() + '…' || f.raw_post_id}
                </span>
                <span className="text-amber-700">— {f.embedding_error_message ?? '(no error message recorded)'}</span>
              </li>
            ))}
          </ul>
        </details>
      )}

      {/* Generate — only offered for a completed run, per the handoff: the
          backend rejects incomplete/failed runs anyway, so don't offer them. */}
      {selectedRun?.status === 'completed' && clustersById.size > 0 && (
        <div className="mb-6 rounded-lg border border-slate-200 bg-white p-4">
          <div className="flex items-start justify-between gap-4">
            <div>
              <h2 className="text-sm font-semibold text-slate-900">Generate editorial copy</h2>
              <p className="mt-0.5 text-xs text-slate-500">
                Select clusters from this run — generation takes several seconds per cluster.
              </p>
            </div>
            <div className="flex items-center gap-4">
              <label className="flex items-center gap-1.5 text-sm text-slate-700">
                <input
                  type="checkbox"
                  checked={wantPost}
                  onChange={(e) => setWantPost(e.target.checked)}
                  className="rounded border-slate-300"
                />
                Post
              </label>
              <label className="flex items-center gap-1.5 text-sm text-slate-700">
                <input
                  type="checkbox"
                  checked={wantCarousel}
                  onChange={(e) => setWantCarousel(e.target.checked)}
                  className="rounded border-slate-300"
                />
                Carousel
              </label>
              <button
                onClick={generateNow}
                disabled={generating || selectedClusterIds.size === 0}
                className="rounded-md bg-indigo-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-indigo-500 disabled:opacity-50"
              >
                {generating
                  ? 'Generating…'
                  : `Generate${selectedClusterIds.size > 0 ? ` (${selectedClusterIds.size})` : ''}`}
              </button>
            </div>
          </div>

          <div className="mt-3 flex flex-wrap gap-2">
            {[...clustersById.values()].map((c) => {
              const count = postCountByCluster.get(c.id) ?? 0
              const checked = selectedClusterIds.has(c.id)
              // label_failed clusters are not selectable: the backend rejects
              // them per-cluster, so grey them out instead of offering them.
              return (
                <button
                  key={c.id}
                  onClick={() => !c.label_failed && toggleCluster(c.id)}
                  disabled={c.label_failed || generating}
                  title={c.label_failed ? 'Labelling failed for this cluster — not eligible for generation' : undefined}
                  className={`rounded-md border px-2.5 py-1 text-xs font-medium transition ${
                    c.label_failed
                      ? 'cursor-not-allowed border-amber-200 bg-amber-50 text-amber-500'
                      : checked
                        ? 'border-indigo-600 bg-indigo-50 text-indigo-700'
                        : 'border-slate-200 bg-white text-slate-600 hover:border-slate-400'
                  }`}
                >
                  {c.label} · {count}
                </button>
              )
            })}
          </div>

          {(genResults !== null || genErrors.length > 0) && (
            <div className="mt-4 space-y-3">
              <div className="flex items-center justify-between">
                <h3 className="text-sm font-semibold text-slate-700">
                  {genResults && genResults.length > 0
                    ? `${genResults.length} result${genResults.length === 1 ? '' : 's'}`
                    : 'No results'}
                </h3>
                <button
                  onClick={() => {
                    setGenResults(null)
                    setGenErrors([])
                  }}
                  className="text-xs text-slate-500 hover:underline"
                >
                  Dismiss
                </button>
              </div>
              <GenerationErrorList
                errors={genErrors}
                labelFor={(id) => clustersById.get(id)?.label ?? id}
              />
              {genResults?.map((r) => <GenerationResultCard key={r.cluster_id} result={r} />)}
            </div>
          )}
        </div>
      )}

      <div className="grid grid-cols-[1fr_1.6fr] gap-6">
        <div className="max-h-[70vh] space-y-2 overflow-y-auto">
          {rows.map((r) => {
            const clusterId = assignmentByPost.get(r.raw_post_id)
            const cluster = clusterId ? clustersById.get(clusterId) : null
            return (
              <button
                key={r.raw_post_id}
                onClick={() => setSelectedId(r.raw_post_id)}
                className={`w-full rounded-lg border p-3 text-left transition ${
                  r.raw_post_id === selectedId
                    ? 'border-slate-900 bg-white'
                    : 'border-slate-200 bg-white hover:border-slate-400'
                }`}
              >
                <div className="flex items-start justify-between gap-2">
                  <span className="text-sm font-medium text-slate-900">
                    {r.raw_posts?.post_title?.trim() || r.anonymized_text.slice(0, 60).trim() + '…'}
                  </span>
                  <span className="shrink-0 text-xs tabular-nums text-slate-500">
                    {Math.round(r.overall_relevance)}
                  </span>
                </div>
                <div className="mt-1.5 flex flex-wrap gap-1.5">
                  <span className="rounded bg-slate-100 px-1.5 py-0.5 text-xs text-slate-600">
                    {r.generalized_source_name}
                  </span>
                  {cluster ? (
                    <span
                      className={`rounded px-1.5 py-0.5 text-xs font-medium ${
                        cluster.label_failed ? 'bg-amber-50 text-amber-700' : 'bg-indigo-50 text-indigo-700'
                      }`}
                    >
                      {cluster.label}
                    </span>
                  ) : selectedRunId ? (
                    <span className="rounded bg-slate-50 px-1.5 py-0.5 text-xs text-slate-400">
                      unclustered
                    </span>
                  ) : null}
                </div>
              </button>
            )
          })}
          {rows.length === 0 && failedRows.length === 0 && (
            <EmptyState>No anonymised posts yet.</EmptyState>
          )}

          {failedRows.length > 0 && (
            <>
              <p className="pt-2 text-xs font-medium uppercase tracking-wide text-slate-400">
                Not yet anonymised
              </p>
              {failedRows.map((r) => (
                <button
                  key={r.raw_post_id}
                  onClick={() => setSelectedId(r.raw_post_id)}
                  className={`w-full rounded-lg border p-3 text-left transition ${
                    r.raw_post_id === selectedId
                      ? 'border-slate-900 bg-white'
                      : 'border-red-200 bg-red-50/40 hover:border-red-400'
                  }`}
                >
                  <div className="flex items-start justify-between gap-2">
                    <span className="text-sm font-medium text-slate-900">
                      {r.raw_posts?.post_title?.trim() || r.raw_posts?.post_text.slice(0, 60).trim() + '…' || '(untitled)'}
                    </span>
                  </div>
                  <div className="mt-1.5 flex flex-wrap gap-1.5">
                    <span
                      className={`rounded px-1.5 py-0.5 text-xs font-medium ${
                        r.status === 'dead_letter'
                          ? 'bg-red-100 text-red-700'
                          : 'bg-amber-100 text-amber-700'
                      }`}
                    >
                      {r.status === 'dead_letter' ? 'failed' : r.status === 'processing' ? 'retrying' : 'pending'}
                    </span>
                    {r.failure_count > 0 && (
                      <span className="text-xs text-slate-400">{r.failure_count} attempt(s)</span>
                    )}
                  </div>
                </button>
              ))}
            </>
          )}
        </div>

        {selected ? (
          <PostDetail post={selected} />
        ) : selectedFailed ? (
          <FailedPostDetail post={selectedFailed} />
        ) : (
          <div className="flex items-center">
            <EmptyState>Select a post to inspect</EmptyState>
          </div>
        )}
      </div>
    </div>
  )
}

function PostDetail({ post }: { post: AnonymisedRow }) {
  return (
    <div className="rounded-lg border border-slate-200 bg-white p-5">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-slate-700">Original</h3>
        {post.raw_posts?.source_url && (
          <a
            href={post.raw_posts.source_url}
            target="_blank"
            rel="noreferrer"
            className="text-xs text-slate-500 hover:underline"
          >
            source
          </a>
        )}
      </div>
      <p className="mt-2 whitespace-pre-wrap rounded-md bg-slate-50 p-3 text-sm text-slate-700">
        {post.raw_posts?.post_text ?? '(original text unavailable)'}
      </p>

      <h3 className="mt-5 text-sm font-semibold text-slate-700">Anonymised</h3>
      <p className="mt-2 whitespace-pre-wrap rounded-md bg-slate-50 p-3 text-sm text-slate-700">
        {post.anonymized_text}
      </p>

      <h3 className="mt-5 text-sm font-semibold text-slate-700">
        Replacements{post.replacements?.length ? ` (${post.replacements.length})` : ''}
      </h3>
      {post.replacements && post.replacements.length > 0 ? (
        <ul className="mt-2 space-y-1.5">
          {post.replacements.map((rep, i) => (
            <li key={i} className="flex items-center gap-2 text-sm">
              <span className="rounded bg-red-50 px-1.5 py-0.5 text-xs text-red-700 line-through">
                {rep.original}
              </span>
              <span className="text-slate-400">→</span>
              <span className="rounded bg-emerald-50 px-1.5 py-0.5 text-xs text-emerald-700">
                {rep.replacement}
              </span>
              <span className="text-xs text-slate-400">({rep.source})</span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="mt-2 text-sm text-slate-400">No replacements recorded.</p>
      )}

      <div className="mt-5 flex flex-wrap gap-x-6 gap-y-1 text-xs text-slate-500">
        <span>Overall relevance: {Math.round(post.overall_relevance)}</span>
        {post.raw_posts?.published_at && (
          <span>Published: {new Date(post.raw_posts.published_at).toISOString().slice(0, 10)}</span>
        )}
      </div>
    </div>
  )
}

function FailedPostDetail({ post }: { post: FailedAnonymiseRow }) {
  const isDeadLetter = post.status === 'dead_letter'
  return (
    <div className="rounded-lg border border-slate-200 bg-white p-5">
      <div
        className={`mb-4 rounded-md px-3 py-2 text-sm ${
          isDeadLetter ? 'bg-red-50 text-red-800' : 'bg-amber-50 text-amber-800'
        }`}
      >
        {isDeadLetter
          ? 'Anonymisation failed permanently for this post. It has no anonymised output and does not appear in any clustering run.'
          : `Anonymisation is still retrying for this post (attempt ${post.failure_count + 1}).`}
      </div>

      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-slate-700">Original</h3>
        {post.raw_posts?.source_url && (
          <a
            href={post.raw_posts.source_url}
            target="_blank"
            rel="noreferrer"
            className="text-xs text-slate-500 hover:underline"
          >
            source
          </a>
        )}
      </div>
      <p className="mt-2 whitespace-pre-wrap rounded-md bg-slate-50 p-3 text-sm text-slate-700">
        {post.raw_posts?.post_text ?? '(original text unavailable)'}
      </p>

      <h3 className="mt-5 text-sm font-semibold text-slate-700">Failure detail</h3>
      <dl className="mt-2 space-y-1 text-sm">
        <div className="flex gap-2">
          <dt className="text-slate-500">Status:</dt>
          <dd className="font-medium text-slate-700">{post.status}</dd>
        </div>
        <div className="flex gap-2">
          <dt className="text-slate-500">Attempts:</dt>
          <dd className="text-slate-700">{post.failure_count}</dd>
        </div>
        {post.last_failure_type && (
          <div className="flex gap-2">
            <dt className="text-slate-500">Last failure type:</dt>
            <dd className="text-slate-700">{post.last_failure_type}</dd>
          </div>
        )}
        {(post.dead_letter_reason || post.last_error_message) && (
          <div className="flex gap-2">
            <dt className="shrink-0 text-slate-500">Reason:</dt>
            <dd className="text-slate-700">{post.dead_letter_reason ?? post.last_error_message}</dd>
          </div>
        )}
      </dl>
    </div>
  )
}
