import { useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'
import { useToast } from '../components/toast-context'
import { Spinner, EmptyState, ErrorNotice } from '../components/ui'
import {
  GenerationResultCard,
  GenerationErrorList,
  type GenerationResultView,
  type GenerationErrorView,
  type PostOutput,
  type CarouselOutput,
} from '../components/generation'

// Read-only generation history (PHASE5_FRONTEND_HANDOFF.md): there is no
// approve/edit/regenerate workflow in Phase 5 — results are immutable,
// append-only rows, and a re-generation is a brand-new request. The action
// itself lives on the Clusters view; this is the audit surface.

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
const STATUS_STYLES: Record<string, string> = {
  completed: 'bg-emerald-100 text-emerald-700',
  failed: 'bg-red-100 text-red-700',
  pending: 'bg-red-100 text-red-700',
}

export function Generate() {
  const toast = useToast()

  const [requests, setRequests] = useState<RequestRow[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [results, setResults] = useState<GenerationResultView[] | null>(null)
  const [errors, setErrors] = useState<GenerationErrorView[]>([])
  const [loadingDetail, setLoadingDetail] = useState(false)

  useEffect(() => {
    async function load() {
      const { data, error } = await supabase
        .from('cluster_generation_requests')
        .select(
          'id, clustering_run_id, requested_cluster_ids, output_types, status, error_message, created_at, completed_at',
        )
        .order('created_at', { ascending: false })
      if (error) setError(error.message)
      else setRequests((data ?? []) as RequestRow[])
    }
    load()
  }, [])

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
      <div className="mb-6">
        <h1 className="text-xl font-semibold">Generation history</h1>
        <p className="mt-1 text-sm text-slate-500">
          {requests.length} request{requests.length === 1 ? '' : 's'} — trigger new generations
          from the Clusters view. Results are read-only; a re-generation is a new request.
        </p>
      </div>

      {requests.length === 0 ? (
        <EmptyState>No generation requests yet. Select clusters on the Clusters view and generate.</EmptyState>
      ) : (
        <div className="grid grid-cols-[1fr_1.6fr] gap-6">
          <div className="max-h-[75vh] space-y-2 overflow-y-auto">
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
                  <span
                    className={`rounded px-1.5 py-0.5 text-xs font-medium ${
                      STATUS_STYLES[r.status] ?? 'bg-slate-100 text-slate-600'
                    }`}
                  >
                    {r.status === 'pending' ? 'failed (crashed)' : r.status}
                  </span>
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

          <div className="max-h-[75vh] space-y-3 overflow-y-auto">
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
