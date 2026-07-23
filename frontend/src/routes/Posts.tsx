import { useEffect, useMemo, useState } from 'react'
import { supabase } from '../lib/supabase'
import { Spinner, ErrorNotice } from '../components/ui'

// analyzed_posts joined to its raw_post and that post's source. relevance_scores
// is a jsonb map { theme: 0-100 }; overall_relevance is the server-derived score.
type PostRow = {
  id: string
  overall_relevance: number
  reason_for_score: string | null
  included_in_generation: boolean
  relevance_scores: Record<string, number>
  raw_posts: {
    post_title: string | null
    post_text: string
    published_at: string
    source_url: string
    sources: { name: string } | null
  } | null
}

function ScoreBar({ value }: { value: number }) {
  const pct = Math.max(0, Math.min(100, value))
  return (
    <div className="flex items-center gap-2">
      <div className="h-1.5 w-16 overflow-hidden rounded-full bg-slate-200">
        <div
          className="h-full rounded-full bg-slate-900"
          style={{ width: `${pct}%` }}
        />
      </div>
      <span className="w-8 text-right text-xs tabular-nums text-slate-600">
        {Math.round(value)}
      </span>
    </div>
  )
}

export function Posts() {
  const [rows, setRows] = useState<PostRow[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  const [sourceFilter, setSourceFilter] = useState('all')
  const [minScore, setMinScore] = useState(0)
  const [onlyIncluded, setOnlyIncluded] = useState(false)

  useEffect(() => {
    supabase
      .from('analyzed_posts')
      .select(
        `id, overall_relevance, reason_for_score, included_in_generation, relevance_scores,
         raw_posts!inner ( post_title, post_text, published_at, source_url,
           sources!inner ( name ) )`,
      )
      .order('overall_relevance', { ascending: false })
      .then(({ data, error }) => {
        if (error) setError(error.message)
        else setRows((data ?? []) as unknown as PostRow[])
      })
  }, [])

  const sourceNames = useMemo(() => {
    if (!rows) return []
    const set = new Set<string>()
    for (const r of rows) {
      const n = r.raw_posts?.sources?.name
      if (n) set.add(n)
    }
    return [...set].sort()
  }, [rows])

  const filtered = useMemo(() => {
    if (!rows) return []
    return rows.filter((r) => {
      if (r.overall_relevance < minScore) return false
      if (onlyIncluded && !r.included_in_generation) return false
      if (sourceFilter !== 'all' && r.raw_posts?.sources?.name !== sourceFilter)
        return false
      return true
    })
  }, [rows, minScore, onlyIncluded, sourceFilter])

  if (error) return <ErrorNotice message={error} />
  if (!rows) return <Spinner label="Loading posts…" />

  return (
    <div>
      <div className="mb-6 flex items-end justify-between">
        <div>
          <h1 className="text-xl font-semibold">Posts</h1>
          <p className="mt-1 text-sm text-slate-500">
            {filtered.length} of {rows.length} analysed posts
          </p>
        </div>

        <div className="flex items-end gap-4">
          <label className="text-sm">
            <span className="mb-1 block text-slate-600">Source</span>
            <select
              value={sourceFilter}
              onChange={(e) => setSourceFilter(e.target.value)}
              className="rounded-md border border-slate-300 px-2 py-1.5 text-sm"
            >
              <option value="all">All sources</option>
              {sourceNames.map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
          </label>

          <label className="text-sm">
            <span className="mb-1 block text-slate-600">
              Min relevance: {minScore}
            </span>
            <input
              type="range"
              min={0}
              max={100}
              step={5}
              value={minScore}
              onChange={(e) => setMinScore(Number(e.target.value))}
              className="w-40"
            />
          </label>

          <label className="flex items-center gap-2 pb-1.5 text-sm text-slate-600">
            <input
              type="checkbox"
              checked={onlyIncluded}
              onChange={(e) => setOnlyIncluded(e.target.checked)}
            />
            In generation only
          </label>
        </div>
      </div>

      <div className="overflow-x-auto rounded-lg border border-slate-200 bg-white">
        <table className="w-full text-sm">
          <thead className="border-b border-slate-200 bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
            <tr>
              <th className="px-4 py-3 font-medium">Post</th>
              <th className="px-4 py-3 font-medium">Source</th>
              <th className="px-4 py-3 font-medium">Overall</th>
              <th className="px-4 py-3 font-medium">Per-theme scores</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {filtered.map((r) => {
              const rp = r.raw_posts
              const title =
                rp?.post_title?.trim() ||
                rp?.post_text.slice(0, 90).trim() + '…' ||
                '(untitled)'
              return (
                <tr key={r.id} className="align-top">
                  <td className="max-w-md px-4 py-3">
                    <a
                      href={rp?.source_url}
                      target="_blank"
                      rel="noreferrer"
                      className="font-medium text-slate-900 hover:underline"
                    >
                      {title}
                    </a>
                    {r.reason_for_score && (
                      <p className="mt-1 text-xs text-slate-500">
                        {r.reason_for_score}
                      </p>
                    )}
                    {r.included_in_generation && (
                      <span className="mt-1 inline-block rounded bg-emerald-50 px-1.5 py-0.5 text-xs font-medium text-emerald-700">
                        in generation
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-slate-600">
                    {rp?.sources?.name ?? '—'}
                  </td>
                  <td className="px-4 py-3">
                    <span className="font-semibold tabular-nums">
                      {Math.round(r.overall_relevance)}
                    </span>
                  </td>
                  <td className="px-4 py-3">
                    <div className="grid grid-cols-2 gap-x-6 gap-y-1">
                      {Object.entries(r.relevance_scores).map(([theme, v]) => (
                        <div
                          key={theme}
                          className="flex items-center justify-between gap-3"
                        >
                          <span className="text-xs text-slate-500">{theme}</span>
                          <ScoreBar value={Number(v)} />
                        </div>
                      ))}
                    </div>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>

        {filtered.length === 0 && (
          <p className="px-4 py-8 text-center text-sm text-slate-500">
            No posts match the current filters.
          </p>
        )}
      </div>
    </div>
  )
}
