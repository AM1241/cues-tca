import { useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'
import { useToast } from './toast-context'
import { Spinner, EmptyState, ErrorNotice, Badge, type BadgeTone } from './ui'
import {
  GenerationResultCard,
  GenerationErrorList,
  type GenerationResultView,
  type GenerationErrorView,
  type PostOutput,
  type CarouselOutput,
} from './generation'

// Read-only generation history, formerly its own Generate tab (FLOW-01). It
// lists generation requests with timestamp and status and shows the model's
// originals read back from cluster_generation_results. The action itself lives
// on the Topics (Clusters) view; this is the audit surface.

type RequestRow = {
  id: string
  clustering_run_id: string
  requested_cluster_ids: string[]
  output_types: string[]
  status: string
  error_message: string | null
  created_at: string
  completed_at: string | null
}

type ResultRow = {
  cluster_id: string
  cluster_label: string
  post_output: PostOutput | null
  carousel_output: CarouselOutput | null
}

function fmtDateTime(iso: string) {
  return new Date(iso).toISOString().slice(0, 16).replace('T', ' ')
}

// `pending` should never be user-visible (the function is synchronous), so a
// row stuck there means the function died mid-request — display as failed.
const STATUS_TONES: Record<string, BadgeTone> = {
  completed: 'success',
  failed: 'danger',
  pending: 'danger',
}

export function GenerationHistory({
  runId,
  highlightRequestId,
}: {
  runId?: string | null
  highlightRequestId?: string | null
}) {
  const toast = useToast()

  const [requests, setRequests] = useState<RequestRow[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(highlightRequestId ?? null)
  const [results, setResults] = useState<GenerationResultView[] | null>(null)
  const [errors, setErrors] = useState<GenerationErrorView[]>([])
  const [loadingDetail, setLoadingDetail] = useState(false)

  useEffect(() => {
    let cancelled = false
    async function load() {
      let query = supabase
        .from('cluster_generation_requests')
        .select(
          'id, clustering_run_id, requested_cluster_ids, output_types, status, error_message, created_at, completed_at',
        )
        .order('created_at', { ascending: false })
      if (runId) query = query.eq('clustering_run_id', runId)
      const { data, error } = await query
      if (cancelled) return
      if (error) setError(error.message)
      else setRequests((data ?? []) as RequestRow[])
    }
    load()
    return () => {
      cancelled = true
    }
  }, [runId])

  useEffect(() => {
    if (!selectedId) {
      setResults(null)
      setErrors([])
      return
    }
    let cancelled = false
    async function loadDetail(requestId: string) {
      setLoadingDetail(true)
      const [resultsRes, errorsRes] = await Promise.all([
        supabase
          .from('cluster_generation_results')
          .select('cluster_id, cluster_label, post_output, carousel_output')
          .eq('generation_request_id', requestId)
          .order('created_at', { ascending: true }),
        supabase
          .from('cluster_generation_request_errors')
          .select('cluster_id, error_type, error_message')
          .eq('generation_request_id', requestId),
      ])
      if (cancelled) return
      setLoadingDetail(false)
      if (resultsRes.error || errorsRes.error) {
        toast.error((resultsRes.error ?? errorsRes.error)!.message)
        return
      }
      setResults(
        ((resultsRes.data ?? []) as unknown as ResultRow[]).map((r) => ({
          cluster_id: r.cluster_id,
          cluster_label: r.cluster_label,
          post: r.post_output,
          carousel: r.carousel_output,
        })),
      )
      setErrors((errorsRes.data ?? []) as GenerationErrorView[])
    }
    loadDetail(selectedId)
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId])

  if (error) return <ErrorNotice message={error} />
  if (!requests) return <Spinner label="Loading generation history…" />

  return (
    <div>
      <p className="text-sm text-slate-500">
        {requests.length} request{requests.length === 1 ? '' : 's'}
        {runId ? ' for the selected run' : ''} — results are read-only; a re-generation is a
        new request.
      </p>

      {requests.length === 0 ? (
        <EmptyState>No generation requests yet. Select topics on this view and generate.</EmptyState>
      ) : (
        <div className="grid grid-cols-[1fr_1.6fr] gap-6">
          <div className="max-h-[60vh] space-y-2 overflow-y-auto">
            {requests.map((r) => (
              <button
                key={r.id}
                onClick={() => setSelectedId(r.id)}
                className={`w-full rounded-lg border p-3 text-left transition ${
                  r.id === selectedId
                    ? 'border-slate-900 bg-white'
                    : 'border-slate-200 bg-white hover:border-slate-400'
                }`}
              >
                <div className="flex items-start justify-between gap-2">
                  <span className="text-sm font-medium text-slate-900">
                    {fmtDateTime(r.created_at)}
                  </span>
                  <Badge tone={STATUS_TONES[r.status] ?? 'neutral'}>
                    {r.status === 'pending' ? 'failed (crashed)' : r.status}
                  </Badge>
                </div>
                <div className="mt-1.5 flex flex-wrap gap-1.5 text-xs text-slate-500">
                  <span>
                    {r.requested_cluster_ids.length} cluster
                    {r.requested_cluster_ids.length === 1 ? '' : 's'}
                  </span>
                  <span>· {r.output_types.join(' + ')}</span>
                </div>
                {r.error_message && (
                  <p className="mt-1.5 text-xs text-red-700">{r.error_message}</p>
                )}
              </button>
            ))}
          </div>

          <div className="max-h-[60vh] space-y-3 overflow-y-auto">
            {!selectedId ? (
              <div className="flex items-center">
                <EmptyState>Select a request to see its results</EmptyState>
              </div>
            ) : loadingDetail ? (
              <Spinner label="Loading results…" />
            ) : (
              <>
                <GenerationErrorList errors={errors} labelFor={(id) => id} />
                {results && results.length > 0
                  ? results.map((r) => <GenerationResultCard key={r.cluster_id} result={r} />)
                  : errors.length === 0 && (
                      <EmptyState>No results were produced for this request.</EmptyState>
                    )}
              </>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
