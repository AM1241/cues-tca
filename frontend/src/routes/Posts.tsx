import { useCallback, useEffect, useMemo, useState } from 'react'
import { supabase } from '../lib/supabase'
import { Spinner, ErrorNotice } from '../components/ui'
import { useToast } from '../components/toast-context'

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

/**
 * The window the screen opens on. A fortnight, because that is the publication
 * cycle the editorial brief describes — an editor arriving to work on the next
 * publication should see its material, not four years of archive.
 */
const DEFAULT_LOOKBACK_DAYS = 15
/** Matches sources.lookback_days (0003), so the two controls cannot disagree. */
const MAX_LOOKBACK_DAYS = 90

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

  const [scoring, setScoring] = useState(false)
  const [queueing, setQueueing] = useState(false)
  // Pending + processing jobs. "Score now" drains this; until 0021 nothing in
  // the UI could add to it, so the button answered "the queue is empty" while
  // 47 posts sat unscored and the operator had no way to see why.
  const [queued, setQueued] = useState<number | null>(null)
  const toast = useToast()

  const [sourceFilter, setSourceFilter] = useState('all')
  const [minScore, setMinScore] = useState(0)
  const [onlyIncluded, setOnlyIncluded] = useState(false)

  // How far back to look, by publication date. Unlike the filters below this
  // one is applied in the QUERY, not to rows already in the browser: the corpus
  // only grows, and an editor working on the last fortnight should not wait for
  // every post ever collected to come down the wire first.
  const [lookbackDays, setLookbackDays] = useState(DEFAULT_LOOKBACK_DAYS)
  const [showAll, setShowAll] = useState(false)
  const [reloading, setReloading] = useState(false)
  // Only for the empty state: when the window returns nothing, the useful fact
  // is how stale the corpus is, and that cannot come from a query that matched
  // no rows.
  const [newestPost, setNewestPost] = useState<string | null>(null)
  // Posts already collected inside the current window but not yet scored — the
  // gap that made "Collect now worked, Posts looks empty" read as a bug. Posts
  // only ever shows analyzed_posts, so a fresh collect is invisible here until
  // someone presses Score now; this is what tells the editor that's why.
  const [unscoredInWindow, setUnscoredInWindow] = useState<number | null>(null)

  const load = useCallback(async () => {
    // Deliberately NOT setRows(null): the days box fires on every keystroke, and
    // replacing the table with a spinner each time makes the screen flash and
    // costs the editor their scroll position. The old rows stay, dimmed, until
    // the new ones land.
    setReloading(true)
    let query = supabase
      .from('analyzed_posts')
      .select(
        `id, overall_relevance, reason_for_score, included_in_generation, relevance_scores,
         raw_posts!inner ( post_title, post_text, published_at, source_url,
           sources!inner ( name ) )`,
      )
    if (!showAll) {
      // published_at lives on raw_posts, and the embed is !inner, so this
      // filters the analyzed_posts rows themselves rather than just the embed.
      const cutoff = new Date(Date.now() - lookbackDays * 86_400_000).toISOString()
      query = query.gte('raw_posts.published_at', cutoff)
    }
    const { data, error } = await query.order('overall_relevance', { ascending: false })
    setReloading(false)
    if (error) setError(error.message)
    else setRows((data ?? []) as unknown as PostRow[])
  }, [lookbackDays, showAll])

  const loadNewest = useCallback(async () => {
    const { data } = await supabase
      .from('raw_posts')
      .select('published_at')
      .order('published_at', { ascending: false })
      .limit(1)
      .maybeSingle()
    setNewestPost((data as { published_at: string } | null)?.published_at ?? null)
  }, [])

  // Counts raw_posts in the window with NO analyzed_posts row at all — not
  // "scored low", not "excluded", genuinely never scored. Skipped entirely
  // when showAll, since the point is explaining why the WINDOWED view looks
  // emptier than what was just collected.
  const loadUnscoredInWindow = useCallback(async () => {
    if (showAll) {
      setUnscoredInWindow(null)
      return
    }
    const cutoff = new Date(Date.now() - lookbackDays * 86_400_000).toISOString()
    // The filter targets the embedded object itself, not a column inside it —
    // `analyzed_posts.id=is.null` is silently ignored by PostgREST for a to-one
    // embed (verified against the live API: it returns the same count with or
    // without the filter). `analyzed_posts=is.null` is the form that actually
    // excludes rows with a match.
    const { count } = await supabase
      .from('raw_posts')
      .select('id, analyzed_posts!left(id)', { count: 'exact', head: true })
      .gte('published_at', cutoff)
      .is('analyzed_posts', null)
    setUnscoredInWindow(count ?? 0)
  }, [lookbackDays, showAll])

  const loadQueue = useCallback(async () => {
    const { count } = await supabase
      .from('scoring_job_state')
      .select('*', { count: 'exact', head: true })
      .in('status', ['pending', 'processing'])
    setQueued(count ?? 0)
  }, [])

  useEffect(() => {
    load()
    loadQueue()
    loadNewest()
    loadUnscoredInWindow()
  }, [load, loadQueue, loadNewest, loadUnscoredInWindow])

  // Put posts INTO the scoring queue. queue_scoring also rotates the production
  // scoring request when the objective has changed since it was opened —
  // a request pins an immutable config snapshot, so without that an edit on the
  // Objective screen would never reach the scorer.
  async function queue(mode: 'unscored' | 'all') {
    if (queueing || scoring) return
    setQueueing(true)
    const { data, error } = await supabase.rpc('queue_scoring', { p_mode: mode })
    setQueueing(false)
    if (error) return toast.error(error.message)

    const r = data as { enqueued: number; config_rotated: boolean } | null
    await loadQueue()
    if (r?.config_rotated) {
      toast.success(
        `Objective changed — scoring restarted under the new settings. ${r.enqueued} queued.`,
      )
    } else if (!r?.enqueued) {
      toast.success('Nothing to queue — every post already has a score.')
    } else {
      toast.success(`${r.enqueued} post(s) queued. Press Score now to process them.`)
    }
  }

  // Drain the scoring queue. Jobs are enqueued by a trigger on raw_posts
  // insert, so this never creates work — it only processes what ingest left
  // behind.
  //
  // batch_size is deliberately NOT sent: how much provider spend one click may
  // commit is server policy (MANUAL_BATCH_CAP in score-worker), and a number
  // hardcoded here would silently duplicate it — as it did, sending 25 after
  // the browser cap dropped to 10, turning every click into a 400.
  async function scoreNow() {
    if (scoring) return
    setScoring(true)
    const { data: sessionData } = await supabase.auth.getSession()
    const token = sessionData.session?.access_token
    const { data, error } = await supabase.functions.invoke('score-worker', {
      body: {},
      headers: token ? { Authorization: `Bearer ${token}` } : undefined,
    })
    setScoring(false)

    if (error) {
      toast.error(error.message)
      return
    }
    if (data?.ok === false) {
      toast.error(data.error ?? 'Scoring failed')
      return
    }
    const t = data?.totals
    if (!t || t.jobs_read === 0) {
      toast.success('Scoring queue is empty — nothing to score.')
      return
    }
    const parts = [`${t.scored} scored`]
    if (t.dead_lettered) parts.push(`${t.dead_lettered} dead-lettered`)
    if (t.retried) parts.push(`${t.retried} retrying`)
    if (t.circuit_break) parts.push(`${t.circuit_break} circuit-broken`)
    toast.success(`${t.jobs_read} job(s) read — ${parts.join(', ')}`)
    await load()
    await loadQueue()
    await loadUnscoredInWindow()
  }

  const sourceNames = useMemo(() => {
    if (!rows) return []
    const set = new Set<string>()
    for (const r of rows) {
      const n = r.raw_posts?.sources?.name
      if (n) set.add(n)
    }
    return [...set].sort()
  }, [rows])

  const daysSinceNewest = useMemo(() => {
    if (!newestPost) return null
    return Math.floor((Date.now() - Date.parse(newestPost)) / 86_400_000)
  }, [newestPost])

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
            <span className="text-slate-400">
              {' '}· {showAll ? 'all time' : `published in the last ${lookbackDays} days`}
            </span>
            {queued !== null && queued > 0 && (
              <span className="ml-2 rounded bg-amber-100 px-1.5 py-0.5 text-xs font-medium text-amber-700">
                {queued} waiting to be scored
              </span>
            )}
          </p>
        </div>

        <div className="flex items-end gap-4">
          <div className="flex gap-2">
            <button
              onClick={() => queue('unscored')}
              disabled={queueing || scoring}
              title="Queue every post that has never been scored"
              className="rounded-md border border-slate-300 px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50"
            >
              {queueing ? 'Queueing…' : 'Queue unscored'}
            </button>
            <button
              onClick={() => queue('all')}
              disabled={queueing || scoring}
              title="Re-score every post — use after changing the objective"
              className="rounded-md border border-slate-300 px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50"
            >
              Re-score all
            </button>
          </div>
          <button
            onClick={scoreNow}
            disabled={scoring || queueing}
            className="rounded-md bg-slate-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-slate-800 disabled:opacity-50"
          >
            {scoring ? 'Scoring…' : 'Score now'}
          </button>
          {/* Period. Sits first because it is the only filter that changes what
              is fetched — the others narrow what is already on screen, and an
              editor who does not notice the difference wonders where their
              posts went. */}
          <div className="text-sm">
            <span className="mb-1 block text-slate-600">Period</span>
            <div className="flex items-stretch gap-1.5">
              <div
                className={`flex items-center gap-1.5 rounded-md border px-2 py-1.5 ${
                  showAll ? 'border-slate-200 bg-slate-50 text-slate-400' : 'border-slate-300'
                }`}
              >
                <span className="text-slate-500">Last</span>
                <input
                  type="number"
                  min={1}
                  max={MAX_LOOKBACK_DAYS}
                  value={lookbackDays}
                  disabled={showAll}
                  onChange={(e) => {
                    // Clamp rather than reject: an out-of-range number left in
                    // the box would silently keep showing the previous window.
                    const n = Number(e.target.value)
                    if (!Number.isFinite(n)) return
                    setLookbackDays(Math.min(MAX_LOOKBACK_DAYS, Math.max(1, Math.round(n))))
                  }}
                  className="w-14 bg-transparent text-center tabular-nums outline-none disabled:cursor-not-allowed"
                />
                <span className="text-slate-500">days</span>
              </div>
              <button
                onClick={() => setShowAll((v) => !v)}
                aria-pressed={showAll}
                className={`rounded-md border px-3 text-sm font-medium ${
                  showAll
                    ? 'border-slate-900 bg-slate-900 text-white'
                    : 'border-slate-300 text-slate-700 hover:bg-slate-100'
                }`}
              >
                All
              </button>
            </div>
          </div>

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

      <div
        className={`overflow-x-auto rounded-lg border border-slate-200 bg-white transition-opacity ${
          reloading ? 'opacity-50' : ''
        }`}
      >
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
                    <SingleThemeNotice scores={r.relevance_scores} />
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
          <div className="px-4 py-8 text-center text-sm text-slate-500">
            {/* An empty window is a correct answer, not a fault, and it is worth
                saying which it is. With nothing collected for six weeks a
                fortnight's window is legitimately empty, and a bare "no posts
                match" reads as a broken screen. */}
            {!showAll && rows.length === 0 && unscoredInWindow !== null && unscoredInWindow > 0 ? (
              // The case that made "Collect now didn't work" look true when it
              // had: posts landed in this window, the queue has them, nobody
              // has pressed Score now yet. This screen only ever shows scored
              // posts, so a fresh collect is otherwise invisible here.
              <>
                <p className="font-medium text-slate-700">
                  {unscoredInWindow} post{unscoredInWindow === 1 ? '' : 's'} collected in this
                  window, not yet scored.
                </p>
                <p className="mt-1">
                  They will appear here once scoring runs.
                  {queued !== null && queued > 0 && ` ${queued} job(s) are queued.`}
                </p>
                <button
                  onClick={scoreNow}
                  disabled={scoring}
                  className="mt-3 rounded-md bg-slate-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-slate-800 disabled:opacity-50"
                >
                  {scoring ? 'Scoring…' : 'Score now'}
                </button>
              </>
            ) : !showAll && rows.length === 0 && newestPost ? (
              <>
                <p className="font-medium text-slate-700">
                  Nothing was published in the last {lookbackDays} days.
                </p>
                <p className="mt-1">
                  The most recent post in the database is from {newestPost.slice(0, 10)}
                  {daysSinceNewest !== null && ` — ${daysSinceNewest} days ago`}. Collect
                  from Sources, widen the window, or press All.
                </p>
                <button
                  onClick={() => setShowAll(true)}
                  className="mt-3 rounded-md border border-slate-300 px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-100"
                >
                  Show all posts
                </button>
              </>
            ) : (
              <p>No posts match the current filters.</p>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

/**
 * The overall score is the highest single theme (aggregation `max_theme_v1`), so
 * a post scoring 95 on one theme and 0 on the other five looks identical to one
 * scoring 95 across the board. That is what let an off-domain post reach the top
 * of this table with the model itself noting it was irrelevant. This does not
 * change any decision — it just makes the configured aggregation visible.
 */
function SingleThemeNotice({ scores }: { scores: Record<string, number> }) {
  const values = Object.values(scores)
  if (values.length < 2) return null
  const top = Math.max(...values)
  if (top === 0) return null
  const carrying = values.filter((v) => v >= top * 0.5).length
  if (carrying > 1) return null
  return (
    <span
      className="mt-1 block text-xs text-amber-600"
      title="Only one theme carries this score; the rest are far lower."
    >
      1 of {values.length} themes
    </span>
  )
}
