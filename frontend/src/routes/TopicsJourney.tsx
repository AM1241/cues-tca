import { useEffect, useMemo, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import { useToast } from '../components/toast-context'
import { Button, Spinner, ErrorNotice, Card, Modal } from '../components/ui'
import { StagePill } from '../components/StagePill'
import { GenerationHistory } from '../components/GenerationHistory'
import { functionErrorMessage } from '../lib/functionError'
import { useJourney } from '../lib/journey-context'
import { fmtCalendarDay, fmtDay, fmtPeriod, overlaps, periodBounds, shortName, type ClusterInfo, type JourneyPost } from '../lib/journey'

/** Mirrors MAX_PUBLICATION_THEMES in supabase/functions/generate/prompt.ts (see classic Clusters.tsx). */
const MAX_PUBLICATION_THEMES = 8

type RunPost = {
  raw_post_id: string
  generalized_source_name: string
  overall_relevance: number
  anonymized_text: string
  raw_posts: { published_at: string } | null
}

function excerpt(text: string, n = 120): string {
  const t = text.replace(/\s+/g, ' ').trim()
  return t.length > n ? t.slice(0, n).trimEnd() + '…' : t
}

/**
 * Topics, organised by topic instead of as one long list. A topic is a card
 * with the posts that formed it; posts that did not make it into a topic are
 * listed separately, each with the reason. The period is the shared working
 * period, so Run clustering groups exactly what Rating just showed.
 */
export function TopicsJourney() {
  const { ctx, posts, period, error, refresh, openPost } = useJourney()
  const toast = useToast()
  const [params, setParams] = useSearchParams()
  const runParam = params.get('run')

  const [running, setRunning] = useState(false)
  const [anonymising, setAnonymising] = useState(false)
  const [publishing, setPublishing] = useState(false)
  const [anonBatch, setAnonBatch] = useState(5)
  const [created, setCreated] = useState<{ id: string; title: string } | null>(null)
  // "Redo all" un-anonymises everything at once. On production it had reset 105
  // of 110 posts by 2026-11-17, with no record of who pressed it — so it asks.
  const [confirmingRedo, setConfirmingRedo] = useState(false)
  const [currentAnonymised, setCurrentAnonymised] = useState<number | null>(null)
  useEffect(() => {
    if (!confirmingRedo) return
    supabase
      .from('anonymized_posts_current')
      .select('raw_post_id', { count: 'exact', head: true })
      .not('current_result_id', 'is', null)
      .then(({ count }) => setCurrentAnonymised(count ?? null))
  }, [confirmingRedo])
  const [runPosts, setRunPosts] = useState<Map<string, RunPost> | null>(null)
  const [failedEmbeddings, setFailedEmbeddings] = useState<{ raw_post_id: string; embedding_error_message: string | null }[]>([])

  // The grouping shown: the one asked for in the URL, else the newest one that
  // covers part of the working period, else the newest of all.
  const runId = useMemo(() => {
    if (!ctx) return null
    if (runParam && ctx.runs.some((r) => r.id === runParam)) return runParam
    return (ctx.runs.find((r) => overlaps(r.period_start, r.period_end, period)) ?? ctx.runs[0])?.id ?? null
  }, [ctx, runParam, period])
  const run = ctx?.runs.find((r) => r.id === runId) ?? null
  const runMatchesPeriod = run ? overlaps(run.period_start, run.period_end, period) : false

  function selectRun(id: string) {
    const next = new URLSearchParams(params)
    next.set('run', id)
    next.delete('request')
    setParams(next, { replace: true })
  }

  // Text and dates for the posts of the selected grouping. They may lie outside
  // the working period — an old grouping keeps its own posts.
  useEffect(() => {
    if (!ctx || !runId) {
      setRunPosts(new Map())
      return
    }
    let cancelled = false
    const ids = ctx.postsByRun.get(runId) ?? []
    setRunPosts(null)
    Promise.all([
      ids.length
        ? supabase
            .from('anonymized_posts_current')
            .select('raw_post_id, generalized_source_name, overall_relevance, anonymized_text, raw_posts!inner ( published_at )')
            .in('raw_post_id', ids)
        : Promise.resolve({ data: [], error: null }),
      supabase
        .from('clustering_run_posts')
        .select('raw_post_id, embedding_error_message')
        .eq('clustering_run_id', runId)
        .eq('embedding_status', 'failed'),
    ]).then(([rp, failed]) => {
      if (cancelled) return
      if (rp.error) toast.error(rp.error.message)
      setRunPosts(new Map(((rp.data ?? []) as unknown as RunPost[]).map((r) => [r.raw_post_id, r])))
      setFailedEmbeddings((failed.data ?? []) as { raw_post_id: string; embedding_error_message: string | null }[])
    })
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ctx, runId])

  const topics = useMemo(() => {
    if (!ctx || !runId) return []
    const assigned = ctx.assignment.get(runId) ?? new Map<string, string>()
    const byCluster = new Map<string, string[]>()
    for (const [postId, clusterId] of assigned) {
      if (!byCluster.has(clusterId)) byCluster.set(clusterId, [])
      byCluster.get(clusterId)!.push(postId)
    }
    const runCarousels = ctx.carousels.filter((c) => c.clustering_run_id === runId)
    return [...ctx.clusters.values()]
      .filter((c) => c.clustering_run_id === runId)
      .map((c) => {
        const ids = byCluster.get(c.id) ?? []
        const versions = runCarousels.filter((k) => k.raw_post_ids.some((id) => ids.includes(id)))
        return { cluster: c, postIds: ids, versions }
      })
      .sort((a, b) => b.postIds.length - a.postIds.length)
  }, [ctx, runId])

  const didNotFit = useMemo(() => {
    if (!ctx || !runId) return []
    const assigned = ctx.assignment.get(runId) ?? new Map()
    return (ctx.postsByRun.get(runId) ?? []).filter((id) => !assigned.has(id))
  }, [ctx, runId])

  const waitingAnon = (posts ?? []).filter((p) => p.stage === 'selected')
  const readyNotGrouped = (posts ?? []).filter((p) => p.stage === 'anonymised')
  const runCarousels = ctx && runId ? ctx.carousels.filter((c) => c.clustering_run_id === runId) : []
  const eligibleClusters: ClusterInfo[] = topics.map((t) => t.cluster).filter((c) => !c.label_failed)

  // ---------------------------------------------------------------------------
  // Actions — the same calls as the classic Topics screen (routes/Clusters.tsx)
  // ---------------------------------------------------------------------------

  /**
   * Anonymises the next posts of the working period only — the same window Run
   * clustering groups (0035, asked for on 2026-11-20). Posts of other dates
   * stay queued for their own period.
   */
  async function anonymiseNow() {
    if (anonymising) return
    setAnonymising(true)
    const { data: sessionData } = await supabase.auth.getSession()
    const token = sessionData.session?.access_token
    const { from, to } = periodBounds(period)
    const { data, error } = await supabase.functions.invoke('anonymize-worker', {
      body: { backfill: true, batch_size: anonBatch, period_start: from, period_end: to },
      headers: token ? { Authorization: `Bearer ${token}` } : undefined,
    })
    setAnonymising(false)
    if (error) return toast.error(await functionErrorMessage(error, 'Anonymisation failed'))
    if (data?.ok === false) return toast.error(data.error ?? 'Anonymisation failed')
    const t = data?.totals
    if (!t || t.jobs_read === 0) toast.success(`Nothing left to anonymise in ${fmtPeriod(period)}.`)
    else
      toast.success(
        `${t.anonymized} anonymised from ${fmtPeriod(period)}${t.dead_lettered ? `, ${t.dead_lettered} failed` : ''}${t.retried ? `, ${t.retried} will be retried` : ''}`,
      )
    await refresh()
  }

  async function redoAll() {
    if (anonymising) return
    setAnonymising(true)
    const { data, error } = await supabase.rpc('requeue_anonymisation')
    setAnonymising(false)
    if (error) return toast.error(error.message)
    const n = (data as { requeued: number } | null)?.requeued ?? 0
    toast.success(n === 0 ? 'Nothing anonymised yet — nothing to redo.' : `${n} post(s) marked for a fresh pass. Press Anonymise now to process them.`)
    await refresh()
  }

  async function runClustering() {
    setRunning(true)
    const { data: sessionData } = await supabase.auth.getSession()
    const token = sessionData.session?.access_token
    const { data, error } = await supabase.functions.invoke('cluster', {
      body: {
        period_start: new Date(`${period.start}T00:00:00Z`).toISOString(),
        period_end: new Date(`${period.end}T23:59:59Z`).toISOString(),
      },
      headers: token ? { Authorization: `Bearer ${token}` } : undefined,
    })
    setRunning(false)
    if (error) return toast.error(await functionErrorMessage(error, 'Clustering failed'))
    if (data?.ok === false) {
      toast.error(data.error ?? 'Clustering failed')
    } else if (!data?.run_id) {
      toast.error(
        `No anonymised post scoring ${ctx?.threshold ?? 50} or more was published in ${fmtPeriod(period)}, so there was nothing to group.`,
      )
    } else {
      const t = data.totals
      toast.success(t ? `${t.clusters} topic(s) from ${t.eligible} post(s)` : 'Clustering complete')
    }
    await refresh()
    if (data?.run_id) selectRun(data.run_id)
  }

  async function publishNow() {
    if (publishing || !run || eligibleClusters.length === 0) return
    setPublishing(true)
    const { data: sessionData } = await supabase.auth.getSession()
    const token = sessionData.session?.access_token
    const { data, error } = await supabase.functions.invoke('generate', {
      body: {
        clustering_run_id: run.id,
        cluster_ids: eligibleClusters.map((c) => c.id),
        output_types: ['post', 'carousel'],
        kind: 'publication',
        period_start: run.period_start,
        period_end: run.period_end,
      },
      headers: token ? { Authorization: `Bearer ${token}` } : undefined,
    })
    setPublishing(false)
    if (error) return toast.error(await functionErrorMessage(error, 'The post and carousel failed to generate.'))
    if (data?.ok === false) return toast.error(data.error ?? 'The post and carousel failed to generate.')
    // "Now the post will be in Review — OK, how can I find it?" (call of
    // 2026-11-06). The answer is a link to exactly this draft.
    const pub = data?.publication as { generation_result_id?: string; title?: string } | undefined
    if (pub?.generation_result_id) setCreated({ id: pub.generation_result_id, title: pub.title ?? 'New carousel' })
    toast.success('Drafted — open it in Review to edit and approve.')
    await refresh()
  }

  if (error && !ctx) return <ErrorNotice message={error} />
  if (!ctx || !posts) return <Spinner label="Loading topics…" />

  const busy = running || anonymising || publishing

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold">Topics</h1>
          <p className="mt-1 max-w-2xl text-sm text-slate-500">
            Selected posts are anonymised, then grouped by what they talk about. Each group is a topic, and the carousel is
            written from the topics.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button
            onClick={anonymiseNow}
            disabled={busy}
            title={`Anonymises up to ${anonBatch} selected posts published in ${fmtPeriod(period)}, newest first. Posts of other dates wait for their own period.`}
          >
            {anonymising ? 'Anonymising…' : `Anonymise now (${anonBatch})`}
          </Button>
          <Button variant="primary" onClick={runClustering} disabled={busy}>
            {running ? 'Grouping…' : `Run clustering for ${fmtPeriod(period)}`}
          </Button>
        </div>
      </div>

      {(waitingAnon.length > 0 || readyNotGrouped.length > 0) && (
        <Card className="mb-5">
          <h2 className="text-sm font-semibold text-slate-900">Selected posts of this period not in a topic yet</h2>
          {waitingAnon.length > 0 && (
            <PostGroup
              title={`${waitingAnon.length} waiting for anonymisation`}
              note="Anonymise now processes them. Then run clustering."
              posts={waitingAnon}
              onOpen={openPost}
            />
          )}
          {readyNotGrouped.length > 0 && (
            <PostGroup
              title={`${readyNotGrouped.length} anonymised, not grouped yet`}
              note={`Run clustering for ${fmtPeriod(period)} to group them.`}
              posts={readyNotGrouped}
              onOpen={openPost}
            />
          )}
        </Card>
      )}

      {ctx.runs.length === 0 ? (
        <Card>
          <p className="text-sm text-slate-600">No grouping has been made yet. Anonymise the selected posts, then run clustering.</p>
        </Card>
      ) : (
        <>
          <div className="mb-3 flex flex-wrap items-center gap-2 text-sm">
            <span className="font-medium text-slate-700">Grouping</span>
            <select
              value={runId ?? ''}
              onChange={(e) => selectRun(e.target.value)}
              className="max-w-full rounded-md border border-slate-300 bg-white px-2 py-1.5 text-sm"
            >
              {ctx.runs.map((r) => {
                const n = ctx.carousels.filter((c) => c.clustering_run_id === r.id).length
                const nTopics = [...ctx.clusters.values()].filter((c) => c.clustering_run_id === r.id).length
                return (
                  <option key={r.id} value={r.id}>
                    made {fmtDay(r.created_at)} · covers {fmtCalendarDay(r.period_start)} – {fmtCalendarDay(r.period_end)} · {nTopics} topic
                    {nTopics === 1 ? '' : 's'} · {n} carousel{n === 1 ? '' : 's'}
                    {r.status !== 'completed' ? ` (${r.status})` : ''}
                  </option>
                )
              })}
            </select>
            {run && (
              <span className="text-xs text-slate-500">by {shortName(run.created_by ? ctx.emailByUser.get(run.created_by) : null)}</span>
            )}
          </div>

          {run && !runMatchesPeriod && (
            <div className="mb-4 rounded-md border border-amber-200 bg-amber-50 px-4 py-2.5 text-sm text-amber-900">
              This grouping covers {fmtCalendarDay(run.period_start)} – {fmtCalendarDay(run.period_end)}, not your working period (
              {fmtPeriod(period)}). None of this period's posts are in it. Run clustering to group them.
            </div>
          )}

          {run && run.status === 'completed' && topics.length > 0 && (
            <div className="mb-5 rounded-lg border border-indigo-200 bg-indigo-50/40 p-4">
              <div className="flex flex-wrap items-start justify-between gap-4">
                <div>
                  <h2 className="text-sm font-semibold text-slate-900">Create the post and carousel</h2>
                  <p className="mt-0.5 text-xs text-slate-600">
                    One LinkedIn post and one carousel covering {fmtCalendarDay(run.period_start)} – {fmtCalendarDay(run.period_end)}, one
                    section per topic.{' '}
                    {eligibleClusters.length > MAX_PUBLICATION_THEMES
                      ? `${eligibleClusters.length} topics — the ${MAX_PUBLICATION_THEMES} largest are used.`
                      : `${eligibleClusters.length} topic${eligibleClusters.length === 1 ? '' : 's'} → ${eligibleClusters.length + 2} slides.`}
                  </p>
                  {runCarousels.length > 0 && (
                    <p className="mt-1 text-xs text-slate-600">
                      Already made from this grouping: {runCarousels.length} version{runCarousels.length === 1 ? '' : 's'}
                      {runCarousels.some((c) => c.status === 'approved') ? ', one approved' : ', none approved'}.{' '}
                      <Link to={`/review?run=${run.id}`} className="font-medium underline">
                        See them in Review
                      </Link>
                    </p>
                  )}
                </div>
                <button
                  onClick={publishNow}
                  disabled={busy || eligibleClusters.length === 0}
                  className="shrink-0 rounded-md bg-indigo-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-indigo-500 disabled:opacity-50"
                >
                  {publishing ? 'Writing…' : runCarousels.length > 0 ? 'Create another version' : 'Create the carousel'}
                </button>
              </div>
              {created && (
                <div className="mt-3 flex flex-wrap items-center justify-between gap-3 rounded-md border border-emerald-200 bg-white px-3 py-2">
                  <p className="text-sm text-slate-800">
                    <span className="font-medium text-emerald-700">Draft ready:</span> «{created.title}»
                  </p>
                  <Link
                    to={`/review?result=${created.id}`}
                    className="rounded-md bg-emerald-600 px-3 py-1 text-xs font-medium text-white hover:bg-emerald-500"
                  >
                    Open it in Review →
                  </Link>
                </div>
              )}
            </div>
          )}

          {run?.status === 'failed' && (
            <p className="mb-4 rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">This grouping failed: {run.error_message ?? 'no message'}</p>
          )}

          {runPosts === null ? (
            <Spinner label="Loading the grouping…" />
          ) : (
            <>
              {topics.length === 0 && run?.status === 'completed' && (
                <Card className="mb-4">
                  <p className="text-sm text-slate-600">
                    No topic formed: {(ctx.postsByRun.get(run.id) ?? []).length} post(s) went in, but none were similar enough to each
                    other. Widen the period, collect more, or lower the similarity threshold in Settings.
                  </p>
                </Card>
              )}

              <div className="grid gap-4 md:grid-cols-2">
                {topics.map((t) => (
                  <Card key={t.cluster.id} className="!p-0">
                    <div className="border-b border-slate-100 px-4 py-3">
                      <p className="text-xs font-medium uppercase tracking-wide text-indigo-600">Topic · {t.postIds.length} posts</p>
                      <h3 className="mt-0.5 font-semibold text-slate-900">{t.cluster.label}</h3>
                      {t.cluster.label_failed && <p className="text-xs text-amber-700">Naming failed — this topic cannot be used.</p>}
                      <p className="mt-1 text-xs text-slate-500">
                        {t.versions.length > 0
                          ? `Used in ${t.versions.length} carousel version${t.versions.length === 1 ? '' : 's'}${t.versions.some((v) => v.status === 'approved') ? ' · one approved' : ''}`
                          : 'Not used in a carousel yet'}
                      </p>
                    </div>
                    <ul className="divide-y divide-slate-100">
                      {t.postIds
                        .map((id) => ({ id, p: runPosts.get(id) }))
                        .sort((a, b) => (b.p?.raw_posts?.published_at ?? '').localeCompare(a.p?.raw_posts?.published_at ?? ''))
                        .map(({ id, p }) => (
                          <RunPostRow key={id} id={id} post={p} onOpen={openPost} />
                        ))}
                    </ul>
                  </Card>
                ))}
              </div>

              {didNotFit.length > 0 && (
                <details className="mt-4 rounded-lg border border-slate-200 bg-white">
                  <summary className="cursor-pointer px-4 py-3 text-sm font-semibold text-slate-700">
                    {didNotFit.length} post{didNotFit.length === 1 ? '' : 's'} in this grouping did not fit any topic
                    <span className="ml-2 font-normal text-slate-500">— no other post was similar enough</span>
                  </summary>
                  <ul className="divide-y divide-slate-100 border-t border-slate-100">
                    {didNotFit
                      .map((id) => ({ id, p: runPosts.get(id) }))
                      .sort((a, b) => (b.p?.raw_posts?.published_at ?? '').localeCompare(a.p?.raw_posts?.published_at ?? ''))
                      .map(({ id, p }) => (
                        <RunPostRow key={id} id={id} post={p} onOpen={openPost} />
                      ))}
                  </ul>
                </details>
              )}

              {failedEmbeddings.length > 0 && (
                <details className="mt-4 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
                  <summary className="cursor-pointer font-medium">
                    {failedEmbeddings.length} post{failedEmbeddings.length === 1 ? '' : 's'} could not be read for grouping
                  </summary>
                  <ul className="mt-2 space-y-1 text-xs">
                    {failedEmbeddings.map((f) => (
                      <li key={f.raw_post_id}>
                        <button className="underline" onClick={() => openPost(f.raw_post_id)}>
                          open
                        </button>{' '}
                        — {f.embedding_error_message ?? 'no message'}
                      </li>
                    ))}
                  </ul>
                </details>
              )}
            </>
          )}
        </>
      )}

      <details className="mt-6 rounded-md border border-slate-200 bg-white">
        <summary className="cursor-pointer px-3 py-2 text-sm font-semibold text-slate-700">Advanced</summary>
        <div className="flex flex-wrap items-end gap-4 border-t border-slate-200 p-3 text-sm">
          <label>
            <span className="mb-1 block text-slate-600">Posts per Anonymise now</span>
            <input
              type="number"
              min={1}
              max={25}
              value={anonBatch}
              onChange={(e) => setAnonBatch(Math.max(1, Math.min(25, Number(e.target.value) || 1)))}
              className="w-20 rounded-md border border-slate-300 px-2 py-1.5"
            />
          </label>
          <div>
            <Button onClick={() => setConfirmingRedo(true)} disabled={busy}>
              Redo all anonymisation…
            </Button>
            <p className="mt-1 text-xs text-slate-500">Only after accepting new brand names. Every post is processed again, at a cost.</p>
          </div>
        </div>
      </details>

      {confirmingRedo && (
        <Modal onClose={() => setConfirmingRedo(false)}>
          <h2 className="text-lg font-semibold text-slate-900">Redo every anonymisation?</h2>
          <div className="mt-3 space-y-2 text-sm text-slate-600">
            <p>
              Every post anonymised so far ({currentAnonymised ?? '…'}) stops counting as anonymised. Until Anonymise now has processed
              each one again, none of them can be grouped into topics, and each one is a paid AI call.
            </p>
            <p>You only need this after accepting new brand names on Sources.</p>
          </div>
          <div className="mt-6 flex justify-end gap-3">
            <Button variant="ghost" className="px-4 py-2" onClick={() => setConfirmingRedo(false)}>
              Cancel
            </Button>
            <Button
              variant="danger"
              size="md"
              onClick={() => {
                setConfirmingRedo(false)
                redoAll()
              }}
            >
              Redo all
            </Button>
          </div>
        </Modal>
      )}

      <details className="mt-3 rounded-md border border-slate-200 bg-white">
        <summary className="cursor-pointer px-3 py-2 text-sm font-semibold text-slate-700">Generation history</summary>
        <div className="border-t border-slate-200 p-3">
          <GenerationHistory runId={runId} highlightRequestId={params.get('request')} />
        </div>
      </details>
    </div>
  )
}

function RunPostRow({ id, post, onOpen }: { id: string; post: RunPost | undefined; onOpen: (id: string) => void }) {
  return (
    <li>
      <button onClick={() => onOpen(id)} className="block w-full px-4 py-2.5 text-left hover:bg-slate-50">
        <div className="flex items-baseline justify-between gap-3 text-xs text-slate-500">
          <span>
            {post?.raw_posts ? fmtDay(post.raw_posts.published_at) : '—'} · {post?.generalized_source_name ?? '—'}
          </span>
          <span className="tabular-nums font-medium text-slate-700">{post ? Math.round(post.overall_relevance) : ''}</span>
        </div>
        <p className="mt-0.5 text-sm text-slate-800">{post ? excerpt(post.anonymized_text) : 'Text no longer available.'}</p>
      </button>
    </li>
  )
}

function PostGroup({
  title,
  note,
  posts,
  onOpen,
}: {
  title: string
  note: string
  posts: JourneyPost[]
  onOpen: (id: string) => void
}) {
  const [open, setOpen] = useState(false)
  return (
    <div className="mt-3">
      <button onClick={() => setOpen((v) => !v)} className="flex w-full items-center justify-between text-left text-sm">
        <span>
          <span className="font-medium text-slate-800">{title}</span>
          <span className="ml-2 text-slate-500">{note}</span>
        </span>
        <span className="text-xs text-slate-500">{open ? 'hide' : 'show'}</span>
      </button>
      {open && (
        <ul className="mt-2 divide-y divide-slate-100 rounded-md border border-slate-100">
          {posts.map((p) => (
            <li key={p.id}>
              <button onClick={() => onOpen(p.id)} className="flex w-full items-center justify-between gap-3 px-3 py-2 text-left hover:bg-slate-50">
                <span className="min-w-0">
                  <span className="block text-xs text-slate-500">
                    {fmtDay(p.published_at)} · {p.source_name} · {p.score !== null ? Math.round(p.score) : '—'}
                  </span>
                  <span className="block truncate text-sm text-slate-800">{p.title}</span>
                </span>
                <StagePill stage={p.stage} />
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
