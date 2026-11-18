import { useEffect, useMemo, useRef, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import { useToast } from '../components/toast-context'
import { Button, Modal, Spinner, ErrorNotice } from '../components/ui'
import { StagePill } from '../components/StagePill'
import { SingleThemeNotice, ThemeScores } from '../components/ThemeScores'
import { functionErrorMessage } from '../lib/functionError'
import { useJourney } from '../lib/journey-context'
import { fmtDay, fmtDayHeading, fmtDayTime, goesForward, type JourneyPost } from '../lib/journey'

type Tab = 'forward' | 'stopped' | 'unscored' | 'all'
type Sort = 'newest' | 'score'

const TABS: { key: Tab; label: string; hint: string }[] = [
  { key: 'forward', label: 'Going forward', hint: 'Selected: these go on to Topics' },
  { key: 'stopped', label: 'Stopped here', hint: 'Scored below the threshold' },
  { key: 'unscored', label: 'Not scored yet', hint: 'Waiting to be scored' },
  { key: 'all', label: 'All', hint: 'Everything published in the period' },
]

function inTab(p: JourneyPost, tab: Tab): boolean {
  if (tab === 'all') return true
  if (tab === 'unscored') return p.stage === 'unscored'
  if (tab === 'stopped') return p.stage === 'below'
  return goesForward(p.stage)
}

/** Local calendar day, for grouping rows under one heading. */
function dayKey(iso: string): string {
  const d = new Date(iso)
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`
}

/**
 * Rating, reorganised around the question the trial kept asking: "which posts
 * came in, and which of them go on?". Every post published in the working
 * period is here — scored or not — with its date, a NEW mark for what the last
 * Collect brought, and where it went next.
 */
export function RatingJourney() {
  const { posts, ctx, error, refresh, openPost } = useJourney()
  const toast = useToast()
  const [params, setParams] = useSearchParams()
  const tab = (params.get('tab') as Tab) || 'forward'
  const sort = (params.get('sort') as Sort) || 'newest'
  const [sourceFilter, setSourceFilter] = useState('all')
  const [onlyNew, setOnlyNew] = useState(false)

  const [scoring, setScoring] = useState(false)
  const [queueing, setQueueing] = useState(false)
  const [confirmingRescore, setConfirmingRescore] = useState(false)
  const [confirmingAll, setConfirmingAll] = useState(false)
  const [justScored, setJustScored] = useState<string[]>([])
  // Progress of "Score all"; note says how it ended.
  const [bulk, setBulk] = useState<{ done: number; total: number; note: string | null } | null>(null)
  const stopRef = useRef(false)
  // Leaving the screen stops the loop after the batch in flight.
  useEffect(() => () => {
    stopRef.current = true
  }, [])

  function setParam(key: string, value: string) {
    const next = new URLSearchParams(params)
    next.set(key, value)
    setParams(next, { replace: true })
  }

  const sources = useMemo(() => [...new Set((posts ?? []).map((p) => p.source_name))].sort(), [posts])

  const base = useMemo(
    () =>
      (posts ?? []).filter(
        (p) => (sourceFilter === 'all' || p.source_name === sourceFilter) && (!onlyNew || p.isNew),
      ),
    [posts, sourceFilter, onlyNew],
  )
  const counts = useMemo(() => {
    const c: Record<Tab, number> = { forward: 0, stopped: 0, unscored: 0, all: base.length }
    for (const p of base) {
      if (p.stage === 'unscored') c.unscored++
      else if (p.stage === 'below') c.stopped++
      else c.forward++
    }
    return c
  }, [base])

  const visible = useMemo(() => {
    const list = base.filter((p) => inTab(p, tab))
    if (sort === 'score') {
      return [...list].sort((a, b) => (b.score ?? -1) - (a.score ?? -1) || b.published_at.localeCompare(a.published_at))
    }
    return list // already newest first
  }, [base, tab, sort])

  const newCount = (posts ?? []).filter((p) => p.isNew).length
  // Score all works on the whole period, whatever the source / NEW filters show.
  const unscoredInPeriod = (posts ?? []).filter((p) => p.stage === 'unscored').length
  const scoredSet = useMemo(() => new Set(justScored), [justScored])

  // What the last Score now did, said in terms of this screen.
  const scoredSummary = useMemo(() => {
    if (justScored.length === 0 || !posts) return null
    const here = posts.filter((p) => scoredSet.has(p.id))
    const forward = here.filter((p) => goesForward(p.stage)).length
    const outside = justScored.length - here.length
    return { total: justScored.length, forward, stopped: here.length - forward, outside }
  }, [justScored, posts, scoredSet])

  // ---------------------------------------------------------------------------
  // Actions — the same calls as the classic Rating screen (routes/Posts.tsx)
  // ---------------------------------------------------------------------------

  /**
   * One call to score-worker: at most ten jobs, never-scored posts first and
   * newest first (0031). The cap is server policy (MANUAL_BATCH_CAP), so the
   * browser never sends a batch size; "Score all" below is many of these calls.
   */
  async function scoreBatch(): Promise<
    | { ok: true; jobsRead: number; scored: string[]; failed: number }
    | { ok: false; message: string }
  > {
    const { data: sessionData } = await supabase.auth.getSession()
    const token = sessionData.session?.access_token
    const { data, error } = await supabase.functions.invoke('score-worker', {
      body: {},
      headers: token ? { Authorization: `Bearer ${token}` } : undefined,
    })
    if (error) return { ok: false, message: await functionErrorMessage(error, 'Scoring failed') }
    if (data?.ok === false) return { ok: false, message: data.error ?? 'Scoring failed' }
    const t = data?.totals ?? { jobs_read: 0, dead_lettered: 0 }
    const scored = ((data?.results ?? []) as { raw_post_id: string; status: string }[])
      .filter((r) => r.status === 'scored')
      .map((r) => r.raw_post_id)
    return { ok: true, jobsRead: t.jobs_read ?? 0, scored, failed: t.dead_lettered ?? 0 }
  }

  async function scoreNow() {
    if (scoring) return
    setScoring(true)
    const r = await scoreBatch()
    setScoring(false)
    if (!r.ok) return toast.error(r.message)
    if (r.jobsRead === 0) return toast.success('Scoring queue is empty — nothing to score.')
    const summary = `${r.scored.length} scored${r.failed ? `, ${r.failed} failed` : ''}`
    if (r.scored.length > 0) toast.success(summary)
    else toast.error(summary)
    setJustScored(r.scored)
    await refresh()
  }

  /**
   * Score every unscored post of the working period, ten per call, until none
   * is left. Asked for in the call of 2026-11-06 ("do I need to click again for
   * each ten?"). It stops on its own when the period is done, when a call
   * scores nothing of this period (the queue has moved on to other posts), on
   * an error, on Stop, or when the editor leaves the screen.
   */
  async function scoreAll() {
    if (scoring || !posts) return
    const targets = new Set(posts.filter((p) => p.stage === 'unscored').map((p) => p.id))
    if (targets.size === 0) return
    stopRef.current = false
    setScoring(true)
    setBulk({ done: 0, total: targets.size, note: null })
    const scoredAll: string[] = []
    let done = 0
    let note: string | null = null
    const maxCalls = Math.ceil(targets.size / 10) + 3
    for (let i = 0; i < maxCalls; i++) {
      if (stopRef.current) {
        note = 'Stopped. The rest are still in the queue.'
        break
      }
      const r = await scoreBatch()
      if (!r.ok) {
        note = `Stopped by an error: ${r.message}`
        break
      }
      scoredAll.push(...r.scored)
      const here = r.scored.filter((id) => targets.has(id)).length
      done += here
      setBulk({ done, total: targets.size, note: null })
      if (r.jobsRead === 0) {
        note = 'The scoring queue is empty.'
        break
      }
      if (done >= targets.size) break
      if (here === 0) {
        note = 'The queue is now serving posts outside this period, so scoring stopped here.'
        break
      }
    }
    setScoring(false)
    setBulk({ done, total: targets.size, note: note ?? `Done: ${done} of ${targets.size} scored.` })
    setJustScored(scoredAll)
    await refresh()
  }

  async function queue(mode: 'unscored' | 'all') {
    if (queueing || scoring) return
    setQueueing(true)
    const { data, error } = await supabase.rpc('queue_scoring', { p_mode: mode })
    setQueueing(false)
    if (error) return toast.error(error.message)
    const r = data as { enqueued: number; config_rotated: boolean; queued_total: number } | null
    if (r?.config_rotated) {
      toast.success(`Settings changed since this was last scored — restarted under the new settings. ${r.enqueued} queued.`)
    } else if (!r?.enqueued) {
      toast.success(
        r?.queued_total
          ? `Nothing new to queue — ${r.queued_total} post(s) already waiting. Press Score all to process them.`
          : 'Nothing to queue — every post already has a score.',
      )
    } else {
      toast.success(`${r.enqueued} post(s) queued. Press Score all to process them.`)
    }
    await refresh()
  }

  if (error && !posts) return <ErrorNotice message={error} />
  if (!posts || !ctx) return <Spinner label="Loading posts…" />

  // Rows, with a heading over each day when the list is in date order.
  const rows: ({ kind: 'day'; key: string; iso: string } | { kind: 'post'; post: JourneyPost })[] = []
  let lastDay = ''
  for (const p of visible) {
    if (sort === 'newest') {
      const k = dayKey(p.published_at)
      if (k !== lastDay) rows.push({ kind: 'day', key: k, iso: p.published_at })
      lastDay = k
    }
    rows.push({ kind: 'post', post: p })
  }

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold">Rating</h1>
          <p className="mt-1 text-sm text-slate-500">
            Each post gets a score from 0 to 100. Posts scoring {ctx.threshold} or more go on to Topics.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button onClick={scoreNow} disabled={scoring || queueing} title="Scores the next ten posts in line, newest first">
            Score 10
          </Button>
          <Button
            variant="primary"
            onClick={() => setConfirmingAll(true)}
            disabled={scoring || queueing || unscoredInPeriod === 0}
            title="Scores every post of the working period that has no score yet"
          >
            {scoring && bulk && !bulk.note
              ? `Scoring ${bulk.done} of ${bulk.total}…`
              : scoring
                ? 'Scoring…'
                : `Score all ${unscoredInPeriod} in this period`}
          </Button>
        </div>
      </div>

      {bulk && (
        <div className="mb-4 rounded-md border border-slate-200 bg-white px-4 py-3 text-sm">
          <div className="flex items-center justify-between gap-4">
            <span className="text-slate-700">
              {bulk.note ?? `Scoring this period: ${bulk.done} of ${bulk.total}. Keep this screen open.`}
            </span>
            {scoring ? (
              <button className="text-xs font-medium text-slate-500 underline" onClick={() => (stopRef.current = true)}>
                stop after this batch
              </button>
            ) : (
              <button className="text-xs text-slate-500 underline" onClick={() => setBulk(null)}>
                dismiss
              </button>
            )}
          </div>
          <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-slate-100">
            <div
              className="h-full rounded-full bg-emerald-500 transition-all"
              style={{ width: `${bulk.total ? Math.round((100 * bulk.done) / bulk.total) : 0}%` }}
            />
          </div>
        </div>
      )}

      {scoredSummary && !scoring && (
        <div className="mb-4 flex items-start justify-between gap-4 rounded-md border border-emerald-200 bg-emerald-50 px-4 py-2.5 text-sm text-emerald-900">
          <p>
            <span className="font-medium">{scoredSummary.total} scored just now</span>
            {scoredSummary.total - scoredSummary.outside > 0 &&
              ` — ${scoredSummary.forward} going forward, ${scoredSummary.stopped} stopped here. They are marked below.`}
            {scoredSummary.outside > 0 &&
              ` ${scoredSummary.outside} ${scoredSummary.outside === 1 ? 'was' : 'were'} published outside the working period, so ${scoredSummary.outside === 1 ? 'it is' : 'they are'} not listed.`}
          </p>
          <button className="shrink-0 text-xs underline" onClick={() => setJustScored([])}>
            dismiss
          </button>
        </div>
      )}

      <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
        <div className="inline-flex overflow-hidden rounded-md border border-slate-300 text-sm" role="tablist">
          {TABS.map((t) => (
            <button
              key={t.key}
              role="tab"
              aria-selected={tab === t.key}
              title={t.hint}
              onClick={() => setParam('tab', t.key)}
              className={`px-3 py-1.5 font-medium ${tab === t.key ? 'bg-slate-900 text-white' : 'bg-white text-slate-600 hover:bg-slate-100'}`}
            >
              {t.label} <span className={tab === t.key ? 'text-slate-300' : 'text-slate-400'}>{counts[t.key]}</span>
            </button>
          ))}
        </div>

        <div className="flex flex-wrap items-center gap-3 text-sm">
          {newCount > 0 && (
            <label className="flex cursor-pointer items-center gap-1.5 text-slate-600">
              <input type="checkbox" checked={onlyNew} onChange={(e) => setOnlyNew(e.target.checked)} />
              Only new from the last Collect ({newCount})
            </label>
          )}
          <select
            value={sourceFilter}
            onChange={(e) => setSourceFilter(e.target.value)}
            className="rounded-md border border-slate-300 px-2 py-1.5 text-sm"
            aria-label="Source"
          >
            <option value="all">All sources</option>
            {sources.map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
          <div className="inline-flex overflow-hidden rounded-md border border-slate-300" aria-label="Sort">
            {(
              [
                ['newest', 'Newest first'],
                ['score', 'Highest score'],
              ] as const
            ).map(([k, label]) => (
              <button
                key={k}
                onClick={() => setParam('sort', k)}
                className={`px-3 py-1.5 font-medium ${sort === k ? 'bg-slate-900 text-white' : 'bg-white text-slate-600 hover:bg-slate-100'}`}
              >
                {label}
              </button>
            ))}
          </div>
        </div>
      </div>

      <div className="overflow-hidden rounded-lg border border-slate-200 bg-white">
        {rows.map((r) =>
          r.kind === 'day' ? (
            <div
              key={`d-${r.key}`}
              className="sticky top-0 z-[1] border-y border-slate-100 bg-slate-50 px-4 py-1.5 text-xs font-semibold uppercase tracking-wide text-slate-500 first:border-t-0"
            >
              {fmtDayHeading(r.iso)}
            </div>
          ) : (
            <PostRow key={r.post.id} post={r.post} justScored={scoredSet.has(r.post.id)} showDate={sort === 'score'} onOpen={() => openPost(r.post.id)} />
          ),
        )}

        {visible.length === 0 && (
          <div className="px-4 py-10 text-center text-sm text-slate-500">
            {posts.length === 0
              ? 'No post was published in the working period. Change the period above, or collect again in Sources.'
              : tab === 'forward'
                ? `No post in this period has reached ${ctx.threshold} yet.`
                : tab === 'unscored'
                  ? 'Every post in this period has a score.'
                  : 'Nothing here.'}
          </div>
        )}
      </div>

      <details className="mt-6 rounded-md border border-slate-200 bg-white">
        <summary className="cursor-pointer px-3 py-2 text-sm font-semibold text-slate-700">Advanced</summary>
        <div className="space-y-4 border-t border-slate-200 p-3 text-sm">
          <div className="flex items-start gap-4">
            <Button onClick={() => queue('unscored')} disabled={queueing || scoring} className="shrink-0">
              {queueing ? 'Queueing…' : 'Queue unscored'}
            </Button>
            <p className="text-xs text-slate-500">
              New posts join the scoring line by themselves when they are collected. Use this only if a post says it is
              not in the queue, for example after a failed attempt. It costs nothing by itself.
            </p>
          </div>
          <div className="flex items-start gap-4">
            <Button onClick={() => setConfirmingRescore(true)} disabled={queueing || scoring} className="shrink-0">
              Re-score all…
            </Button>
            <p className="text-xs text-slate-500">
              Only after changing the themes or the domain in Settings. Every post ever collected is scored again, and
              each one is a paid AI call.
            </p>
          </div>
        </div>
      </details>

      {confirmingAll && (
        <Modal onClose={() => setConfirmingAll(false)}>
          <h2 className="text-lg font-semibold text-slate-900">Score all {unscoredInPeriod} posts of this period?</h2>
          <div className="mt-3 space-y-2 text-sm text-slate-600">
            <p>
              The posts published in the working period that have no score yet are scored ten at a time, newest first,
              until none is left. Each post is one paid AI call.
            </p>
            <p>
              It takes about {Math.max(1, Math.round((Math.ceil(unscoredInPeriod / 10) * 22) / 60))} minute
              {Math.round((Math.ceil(unscoredInPeriod / 10) * 22) / 60) > 1 ? 's' : ''}. Keep this screen open; you can stop
              it after any batch.
            </p>
          </div>
          <div className="mt-6 flex justify-end gap-3">
            <Button variant="ghost" className="px-4 py-2" onClick={() => setConfirmingAll(false)}>
              Cancel
            </Button>
            <Button
              variant="primary"
              size="md"
              onClick={() => {
                setConfirmingAll(false)
                scoreAll()
              }}
            >
              Score {unscoredInPeriod} posts
            </Button>
          </div>
        </Modal>
      )}

      {confirmingRescore && (
        <Modal onClose={() => setConfirmingRescore(false)}>
          <h2 className="text-lg font-semibold text-slate-900">Re-score every post?</h2>
          <div className="mt-3 space-y-2 text-sm text-slate-600">
            <p>
              This queues <strong>every post ever collected</strong>, including those that already have a score. Each one is
              a paid AI call when it is processed.
            </p>
            <p>
              You only need this after changing Settings. To score new posts, use <strong>Score all</strong>.
            </p>
          </div>
          <div className="mt-6 flex justify-end gap-3">
            <Button variant="ghost" className="px-4 py-2" onClick={() => setConfirmingRescore(false)}>
              Cancel
            </Button>
            <Button
              variant="primary"
              size="md"
              onClick={() => {
                setConfirmingRescore(false)
                queue('all')
              }}
            >
              Re-score everything
            </Button>
          </div>
        </Modal>
      )}
    </div>
  )
}

function PostRow({
  post,
  justScored,
  showDate,
  onOpen,
}: {
  post: JourneyPost
  justScored: boolean
  showDate: boolean
  onOpen: () => void
}) {
  return (
    <div
      className={`grid grid-cols-[minmax(0,1fr)_4.5rem_22rem] items-start gap-4 border-b border-slate-100 px-4 py-3 last:border-b-0 ${
        justScored ? 'bg-emerald-50/50' : ''
      }`}
    >
      <div className="min-w-0">
        <div className="flex items-start gap-2">
          {post.isNew && (
            <span className="mt-0.5 shrink-0 rounded bg-blue-600 px-1.5 py-px text-[10px] font-bold tracking-wide text-white" title={`Collected ${fmtDayTime(post.collected_at)}`}>
              NEW
            </span>
          )}
          {justScored && (
            <span className="mt-0.5 shrink-0 rounded bg-emerald-600 px-1.5 py-px text-[10px] font-bold tracking-wide text-white">
              JUST SCORED
            </span>
          )}
          <button onClick={onOpen} className="text-left text-sm font-medium text-slate-900 hover:underline">
            {post.title}
          </button>
        </div>
        <p className="mt-1 text-xs text-slate-500">
          {post.source_name}
          {showDate && <> · {fmtDay(post.published_at)}</>}
          {' · '}
          <a href={post.source_url} target="_blank" rel="noreferrer" className="hover:underline">
            LinkedIn ↗
          </a>
        </p>
        <div className="mt-1.5 flex items-start gap-2">
          <button onClick={onOpen} title="See where this post went" className="shrink-0">
            <StagePill stage={post.stage} />
          </button>
          <p className="pt-0.5 text-xs text-slate-500">{post.why}</p>
        </div>
      </div>

      <div className="text-right">
        {post.score === null ? (
          <span className="text-sm text-slate-300">—</span>
        ) : (
          <>
            <span className="text-lg font-semibold tabular-nums text-slate-900" title="Overall score: the highest theme">
              {Math.round(post.score)}
            </span>
            {post.themeScores && <SingleThemeNotice scores={post.themeScores} />}
          </>
        )}
      </div>

      <div className="pt-1">
        {post.themeScores ? (
          <ThemeScores scores={post.themeScores} />
        ) : (
          <p className="text-xs text-slate-300">No theme scores yet</p>
        )}
      </div>
    </div>
  )
}
