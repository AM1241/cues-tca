import { useEffect, useState, type ReactNode } from 'react'
import { useNavigate } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import {
  fmtCalendarDay,
  fmtDay,
  fmtDayTime,
  placePost,
  postTitle,
  shortName,
  STAGE_LABEL,
  type JourneyContext,
} from '../lib/journey'
import { Badge, Spinner } from './ui'
import { StagePill } from './StagePill'

type Detail = {
  id: string
  post_title: string | null
  post_text: string
  published_at: string
  created_at: string
  source_url: string
  sources: { name: string } | null
  analyzed_posts: {
    overall_relevance: number
    reason_for_score: string | null
    relevance_scores: Record<string, number>
    updated_at: string
  } | null
  anonymized_posts_current: {
    current_result_id: string | null
    anonymized_text: string
    generalized_source_name: string
    replacements: { original: string; replacement: string; source: string }[] | null
    updated_at: string
  } | null
}

type AnonJob = { status: string; last_error_message: string | null } | null

type StepState = 'done' | 'stopped' | 'failed' | 'waiting'

const DOT: Record<StepState, string> = {
  done: 'bg-emerald-500 border-emerald-500',
  stopped: 'bg-white border-slate-400',
  failed: 'bg-red-500 border-red-500',
  waiting: 'bg-white border-slate-300 border-dashed',
}

function Step({
  title,
  state,
  when,
  children,
  last = false,
}: {
  title: string
  state: StepState
  when?: string | null
  children?: ReactNode
  last?: boolean
}) {
  return (
    <li className="relative pl-7">
      {!last && <span className="absolute left-[7px] top-4 h-full w-px bg-slate-200" />}
      <span className={`absolute left-0 top-1 h-4 w-4 rounded-full border-2 ${DOT[state]}`} />
      <div className="flex items-baseline justify-between gap-3">
        <p className={`text-sm font-medium ${state === 'waiting' ? 'text-slate-400' : 'text-slate-900'}`}>{title}</p>
        {when && <span className="shrink-0 text-xs text-slate-500">{when}</span>}
      </div>
      <div className="mt-1 pb-5 text-sm text-slate-600">{children}</div>
    </li>
  )
}

/**
 * One post, from collection to carousel, on one screen. This is the answer to
 * "where did this post go?": every step shows whether it was reached, when,
 * and — where the post stopped — why.
 */
export function PostJourneyPanel({
  rawPostId,
  ctx,
  onClose,
}: {
  rawPostId: string
  ctx: JourneyContext
  onClose: () => void
}) {
  const navigate = useNavigate()
  const [detail, setDetail] = useState<Detail | null>(null)
  const [anonJob, setAnonJob] = useState<AnonJob>(null)
  const [error, setError] = useState<string | null>(null)
  const [showOriginal, setShowOriginal] = useState(false)
  const [showAnonymised, setShowAnonymised] = useState(false)

  useEffect(() => {
    let cancelled = false
    setDetail(null)
    setError(null)
    Promise.all([
      supabase
        .from('raw_posts')
        .select(
          `id, post_title, post_text, published_at, created_at, source_url, sources ( name ),
           analyzed_posts ( overall_relevance, reason_for_score, relevance_scores, updated_at ),
           anonymized_posts_current ( current_result_id, anonymized_text, generalized_source_name, replacements, updated_at )`,
        )
        .eq('id', rawPostId)
        .maybeSingle(),
      supabase.from('anonymize_job_state').select('status, last_error_message').eq('raw_post_id', rawPostId).maybeSingle(),
    ]).then(([post, job]) => {
      if (cancelled) return
      if (post.error) setError(post.error.message)
      else if (!post.data) setError('Post not found.')
      else setDetail(post.data as unknown as Detail)
      setAnonJob((job.data as AnonJob) ?? null)
    })
    return () => {
      cancelled = true
    }
  }, [rawPostId])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const score = detail?.analyzed_posts ? Number(detail.analyzed_posts.overall_relevance) : null
  // A row whose current_result_id is null was reset by "Redo all": the old text
  // is kept, but it no longer counts, and clustering will not take it.
  const apc = detail?.anonymized_posts_current ?? null
  const anonymised = apc?.current_result_id ? apc : null
  const redo = apc !== null && anonymised === null
  const placed = detail ? placePost({ id: detail.id, score, anonymised: anonymised !== null, redo }, ctx) : null
  const runIds = ctx.runsByPost.get(rawPostId) ?? []
  const newestRun = runIds[0] ? ctx.runs.find((r) => r.id === runIds[0]) : undefined
  // Read straight from the grouping, not from placePost: a post whose
  // anonymisation was reset still sat in that topic, and saying otherwise
  // would rewrite its history.
  const clusterId = newestRun ? ctx.assignment.get(newestRun.id)?.get(rawPostId) : undefined
  const topicLabel = clusterId ? ctx.clusters.get(clusterId)?.label : undefined

  function go(to: string) {
    onClose()
    navigate(to)
  }

  return (
    <div className="fixed inset-0 z-20 flex justify-end bg-slate-900/30" onClick={onClose}>
      <aside
        onClick={(e) => e.stopPropagation()}
        className="h-full w-full max-w-xl overflow-y-auto bg-white shadow-2xl"
        aria-label="Post journey"
      >
        <div className="sticky top-0 z-10 flex items-start justify-between gap-4 border-b border-slate-200 bg-white px-6 py-4">
          <div className="min-w-0">
            <p className="text-xs font-medium uppercase tracking-wide text-slate-400">Where this post went</p>
            <h2 className="mt-1 text-base font-semibold text-slate-900">
              {detail ? postTitle(detail.post_title, detail.post_text) : '…'}
            </h2>
            {detail && (
              <p className="mt-1 text-xs text-slate-500">
                {detail.sources?.name ?? '—'} · published {fmtDay(detail.published_at)} ·{' '}
                <a href={detail.source_url} target="_blank" rel="noreferrer" className="underline hover:text-slate-900">
                  open on LinkedIn ↗
                </a>
              </p>
            )}
          </div>
          <button onClick={onClose} className="shrink-0 rounded-md px-2 py-1 text-slate-500 hover:bg-slate-100" aria-label="Close">
            ✕
          </button>
        </div>

        <div className="px-6 py-5">
          {error && <p className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}
          {!detail && !error && <Spinner label="Loading…" />}

          {detail && placed && (
            <>
              <div className="mb-6 rounded-lg border border-slate-200 bg-slate-50 px-4 py-3">
                <div className="flex items-center gap-2">
                  <StagePill stage={placed.stage} />
                </div>
                <p className="mt-1.5 text-sm text-slate-700">{placed.why}</p>
              </div>

              <ol>
                <Step title="Collected" state="done" when={fmtDayTime(detail.created_at)}>
                  Published on LinkedIn on {fmtDay(detail.published_at)} by {detail.sources?.name ?? 'an unknown source'}.
                </Step>

                <Step
                  title={score === null ? 'Scored — not yet' : `Scored ${Math.round(score)} / 100`}
                  state={score === null ? 'waiting' : 'done'}
                  when={detail.analyzed_posts ? fmtDayTime(detail.analyzed_posts.updated_at) : null}
                >
                  {score === null ? (
                    ctx.scoringQueued.has(rawPostId) ? (
                      'Waiting in the scoring queue. Score all in Rating scores the period, newest posts first.'
                    ) : (
                      'Not in the scoring queue. Queue unscored (Rating → Advanced) adds it.'
                    )
                  ) : (
                    <>
                      {detail.analyzed_posts?.reason_for_score && <p className="italic">“{detail.analyzed_posts.reason_for_score}”</p>}
                      <div className="mt-2 grid grid-cols-2 gap-x-6 gap-y-1">
                        {Object.entries(detail.analyzed_posts?.relevance_scores ?? {}).map(([theme, v]) => (
                          <div key={theme} className="flex items-center justify-between gap-2 text-xs">
                            <span className="text-slate-500">{theme}</span>
                            <span className="tabular-nums">{Math.round(Number(v))}</span>
                          </div>
                        ))}
                      </div>
                      <p className="mt-1 text-xs text-slate-400">The overall score is the highest theme.</p>
                    </>
                  )}
                </Step>

                <Step
                  title={
                    score === null
                      ? 'Selected — not yet'
                      : score >= ctx.threshold
                        ? 'Selected'
                        : 'Not selected — stops here'
                  }
                  state={score === null ? 'waiting' : score >= ctx.threshold ? 'done' : 'stopped'}
                >
                  {score === null
                    ? `Posts scoring ${ctx.threshold} or more go on to Topics.`
                    : score >= ctx.threshold
                      ? `${Math.round(score)} is at or above the threshold of ${ctx.threshold} (Settings).`
                      : `${Math.round(score)} is below the threshold of ${ctx.threshold} (Settings), so it does not go on to Topics.`}
                </Step>

                <Step
                  title={
                    anonymised
                      ? 'Anonymised'
                      : redo
                        ? 'Anonymised before — reset by Redo all'
                        : anonJob?.status === 'dead_letter'
                          ? 'Anonymisation failed'
                          : 'Anonymised — not yet'
                  }
                  state={anonymised ? 'done' : anonJob?.status === 'dead_letter' && !redo ? 'failed' : 'waiting'}
                  when={anonymised ? fmtDayTime(anonymised.updated_at) : null}
                >
                  {anonymised ? (
                    <>
                      Shown in Topics as <span className="font-medium">{anonymised.generalized_source_name}</span>
                      {anonymised.replacements && anonymised.replacements.length > 0
                        ? `, ${anonymised.replacements.length} name${anonymised.replacements.length === 1 ? '' : 's'} replaced.`
                        : ', no names replaced.'}{' '}
                      <button className="underline hover:text-slate-900" onClick={() => setShowAnonymised((v) => !v)}>
                        {showAnonymised ? 'hide text' : 'show text'}
                      </button>
                      {showAnonymised && (
                        <div className="mt-2 space-y-2">
                          {anonymised.replacements && anonymised.replacements.length > 0 && (
                            <div className="flex flex-wrap gap-1.5">
                              {anonymised.replacements.map((r, i) => (
                                <span key={i} className="text-xs">
                                  <Badge tone="danger" className="line-through">{r.original}</Badge> →{' '}
                                  <Badge tone="success">{r.replacement}</Badge>
                                </span>
                              ))}
                            </div>
                          )}
                          <p className="whitespace-pre-wrap rounded-md bg-slate-50 p-3 text-xs text-slate-700">
                            {anonymised.anonymized_text}
                          </p>
                        </div>
                      )}
                    </>
                  ) : redo ? (
                    'Redo all marked this post for a fresh pass, so its earlier anonymisation no longer counts and it cannot be grouped until Anonymise all in Topics processes it again.'
                  ) : anonJob?.status === 'dead_letter' ? (
                    <>Failed: {anonJob.last_error_message ?? 'no message recorded'}.</>
                  ) : score !== null && score >= ctx.threshold ? (
                    anonJob ? (
                      'In the anonymisation queue. Anonymise all in Topics processes it.'
                    ) : (
                      'Not queued yet. Anonymise all in Topics queues and processes it.'
                    )
                  ) : (
                    'Only selected posts are anonymised.'
                  )}
                </Step>

                <Step
                  title={
                    topicLabel
                      ? `Topic: ${topicLabel}`
                      : newestRun
                        ? 'Did not fit a topic'
                        : 'Grouped into a topic — not yet'
                  }
                  state={topicLabel ? 'done' : newestRun ? 'stopped' : 'waiting'}
                  when={newestRun ? fmtDayTime(newestRun.created_at) : null}
                >
                  {newestRun ? (
                    <>
                      Grouping of {fmtDay(newestRun.created_at)}, covering {fmtCalendarDay(newestRun.period_start)} –{' '}
                      {fmtCalendarDay(newestRun.period_end)}.
                      {!topicLabel && ' No other post in it was similar enough to form a topic with this one.'}
                      {runIds.length > 1 && ` It was part of ${runIds.length} groupings in all; this is the newest.`}{' '}
                      <button className="underline hover:text-slate-900" onClick={() => go(`/clusters?run=${newestRun.id}`)}>
                        open in Topics
                      </button>
                    </>
                  ) : anonymised ? (
                    'Run clustering in Topics over a period that includes this post.'
                  ) : (
                    'Only anonymised posts are grouped.'
                  )}
                </Step>

                <Step
                  title={placed.carousels.length > 0 ? `In ${placed.carousels.length} carousel version${placed.carousels.length === 1 ? '' : 's'}` : 'Carousel — not yet'}
                  state={placed.carousels.length > 0 ? 'done' : 'waiting'}
                  last
                >
                  {placed.carousels.length > 0 ? (
                    <ul className="space-y-1.5">
                      {placed.carousels.map((c) => (
                        <li key={c.id} className="flex items-start justify-between gap-3">
                          <button className="text-left underline-offset-2 hover:underline" onClick={() => go(`/review?result=${c.id}`)}>
                            «{c.title}»
                          </button>
                          <span className="shrink-0 text-xs text-slate-500">
                            {fmtDay(c.created_at)} · {shortName(c.created_by ? ctx.emailByUser.get(c.created_by) : null)} ·{' '}
                            <span className={c.status === 'approved' ? 'font-medium text-emerald-700' : ''}>{c.status}</span>
                          </span>
                        </li>
                      ))}
                    </ul>
                  ) : topicLabel ? (
                    'Its topic is ready. Create the carousel in Topics.'
                  ) : (
                    `Carousels are made from topics. This post is at “${STAGE_LABEL[placed.stage]}”.`
                  )}
                </Step>
              </ol>

              <button className="text-sm text-slate-500 underline hover:text-slate-900" onClick={() => setShowOriginal((v) => !v)}>
                {showOriginal ? 'Hide the original text' : 'Show the original text'}
              </button>
              {showOriginal && (
                <p className="mt-2 whitespace-pre-wrap rounded-md bg-slate-50 p-3 text-sm text-slate-700">{detail.post_text}</p>
              )}
            </>
          )}
        </div>
      </aside>
    </div>
  )
}
