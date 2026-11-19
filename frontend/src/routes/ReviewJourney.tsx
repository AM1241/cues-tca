import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import { Spinner, EmptyState, ErrorNotice, Card, TabSwitch } from '../components/ui'
import { GeneratedDetail, LegacyReview, type ReviewRow } from './Review'
import { PER_CLUSTER_GENERATION, SHOW_LEGACY } from '../lib/features'
import { useJourney } from '../lib/journey-context'
import { combineStatus, fmtCalendarDay, fmtDay, fmtDayTime, postTitle, shortName, type ReviewStatus } from '../lib/journey'

/** ReviewRow plus what the grouped list needs; the select below asks for these. */
type Row = ReviewRow & {
  cluster_generation_results:
    | (NonNullable<ReviewRow['cluster_generation_results']> & {
        kind: string
        period_start: string | null
        period_end: string | null
        cluster_generation_requests:
          | (NonNullable<NonNullable<ReviewRow['cluster_generation_results']>['cluster_generation_requests']> & {
              created_by: string | null
            })
          | null
      })
    | null
}

/** One carousel: the post and the carousel of one generation, reviewed together. */
type Item = {
  resultId: string
  title: string
  createdAt: string
  runId: string
  periodStart: string | null
  periodEnd: string | null
  createdBy: string | null
  rawPostIds: string[]
  status: ReviewStatus
  edited: boolean
  rows: Partial<Record<'post' | 'carousel', Row>>
}

type Tab = 'draft' | 'approved' | 'rejected' | 'all'

const TABS: { key: Tab; label: string }[] = [
  { key: 'draft', label: 'To approve' },
  { key: 'approved', label: 'Approved' },
  { key: 'rejected', label: 'Rejected' },
  { key: 'all', label: 'All' },
]

const STATUS_STYLE: Record<string, string> = {
  draft: 'bg-slate-100 text-slate-600',
  approved: 'bg-emerald-100 text-emerald-700',
  rejected: 'bg-red-100 text-red-700',
  superseded: 'bg-slate-100 text-slate-400',
  published: 'bg-blue-100 text-blue-700',
}

function Status({ s, label }: { s: string; label?: string }) {
  return (
    <span className={`inline-flex items-center rounded px-1.5 py-0.5 text-xs font-medium ${STATUS_STYLE[s] ?? STATUS_STYLE.draft}`}>
      {label ? `${label}: ` : ''}
      {s === 'draft' ? 'to approve' : s}
    </span>
  )
}

type SourcePost = {
  id: string
  post_title: string | null
  post_text: string
  published_at: string
  sources: { name: string } | null
  analyzed_posts: { overall_relevance: number } | null
}

/**
 * Review, one line per carousel instead of one per output, grouped by the period
 * it covers, newest first. The editing, approval and regeneration panel is the
 * classic one (GeneratedDetail) unchanged — only how the list is organised and
 * what each line says is new.
 */
export function ReviewJourney() {
  const { ctx, openPost, refresh } = useJourney()
  const [params, setParams] = useSearchParams()
  const [rows, setRows] = useState<Row[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [tab, setTab] = useState<Tab>('draft')
  const [showSuperseded, setShowSuperseded] = useState(false)
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [output, setOutput] = useState<'carousel' | 'post'>('carousel')
  // Legacy: the 15 texts migrated from the pre-cloud system, still reviewable.
  // Not earlier carousel versions — those are the "older versions" below.
  // Only reachable while SHOW_LEGACY is on (features.ts).
  const [view, setView] = useState<'generated' | 'legacy'>('generated')
  const selectedId = params.get('result')
  const runFilter = params.get('run')
  // A selection made by clicking the list needs no focusing; one that arrives
  // in the URL (Topics' "Open it in Review", the journey panel) does.
  const fromListRef = useRef<string | null>(null)
  const focusedRef = useRef<string | null>(null)

  const load = useCallback(async () => {
    const { data, error } = await supabase
      .from('cluster_generation_reviews')
      // Same embed hints as the classic Review (Review.tsx explains why they are needed).
      .select(
        `result_id, output_type, status, edited_output, approved_by, approval_notes,
         superseded_by_result_id,
         cluster_generation_results!cluster_generation_reviews_result_id_fkey!inner (
           cluster_label, model, created_at, raw_post_ids, post_output, carousel_output,
           cluster_id, clustering_run_id, kind, source_cluster_ids, period_start, period_end,
           cluster_generation_requests!cluster_generation_results_generation_request_id_fkey (
             id, status, created_at, feedback, regenerates_result_id, created_by
           )
         )`,
      )
      .filter(
        'cluster_generation_results.kind',
        PER_CLUSTER_GENERATION ? 'in' : 'eq',
        PER_CLUSTER_GENERATION ? '(per_cluster,publication)' : 'publication',
      )
    if (error) setError(error.message)
    else setRows((data ?? []) as unknown as Row[])
  }, [])

  useEffect(() => {
    load()
  }, [load])

  const items = useMemo(() => {
    const byResult = new Map<string, Item>()
    for (const r of rows ?? []) {
      const g = r.cluster_generation_results
      if (!g) continue
      let it = byResult.get(r.result_id)
      if (!it) {
        it = {
          resultId: r.result_id,
          title: g.cluster_label,
          createdAt: g.created_at,
          runId: g.clustering_run_id,
          periodStart: g.period_start,
          periodEnd: g.period_end,
          createdBy: g.cluster_generation_requests?.created_by ?? null,
          rawPostIds: g.raw_post_ids ?? [],
          status: 'draft',
          edited: false,
          rows: {},
        }
        byResult.set(r.result_id, it)
      }
      it.rows[r.output_type] = r
      if (r.edited_output != null) it.edited = true
    }
    for (const it of byResult.values()) {
      it.status = combineStatus(Object.values(it.rows).map((r) => r!.status))
    }
    return [...byResult.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  }, [rows])

  const counts = useMemo(() => {
    const c: Record<Tab, number> = { draft: 0, approved: 0, rejected: 0, all: 0 }
    for (const it of items) {
      if (it.status === 'superseded' && !showSuperseded) continue
      c.all++
      if (it.status === 'draft' || it.status === 'approved' || it.status === 'rejected') c[it.status]++
    }
    return c
  }, [items, showSuperseded])

  // Grouped by the grouping (run) they were made from: same period, same posts.
  const groups = useMemo(() => {
    const visible = items.filter(
      (it) =>
        (showSuperseded || it.status !== 'superseded') &&
        (tab === 'all' || it.status === tab) &&
        (!runFilter || it.runId === runFilter),
    )
    const byRun = new Map<string, Item[]>()
    for (const it of visible) {
      if (!byRun.has(it.runId)) byRun.set(it.runId, [])
      byRun.get(it.runId)!.push(it)
    }
    return [...byRun.entries()].map(([runId, list]) => ({
      runId,
      list,
      all: items.filter((i) => i.runId === runId),
    }))
  }, [items, tab, showSuperseded, runFilter])

  const selected = items.find((i) => i.resultId === selectedId) ?? null
  const supersededCount = items.filter((i) => i.status === 'superseded').length

  function select(resultId: string) {
    fromListRef.current = resultId
    const next = new URLSearchParams(params)
    next.set('result', resultId)
    setParams(next, { replace: true })
  }

  // Arriving with ?result=: show that carousel wherever it sits — its status
  // tab, its group unfolded, scrolled into view.
  useEffect(() => {
    if (!selectedId || focusedRef.current === selectedId || fromListRef.current === selectedId) return
    const it = items.find((i) => i.resultId === selectedId)
    if (!it) return
    focusedRef.current = selectedId
    setView('generated')
    if (it.status === 'superseded') {
      setShowSuperseded(true)
      setTab('all')
    } else {
      setTab(it.status)
    }
    setExpanded((prev) => new Set(prev).add(it.runId))
    setTimeout(() => document.getElementById(`item-${selectedId}`)?.scrollIntoView({ block: 'center', behavior: 'smooth' }), 100)
  }, [selectedId, items])

  // Land on the carousel when it exists; a post-only result has only the post.
  const selectedOutput: 'carousel' | 'post' = selected
    ? selected.rows[output]
      ? output
      : selected.rows.carousel
        ? 'carousel'
        : 'post'
    : output

  if (error) return <ErrorNotice message={error} />
  if (!rows || !ctx) return <Spinner label="Loading carousels…" />

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-end justify-between gap-4">
        <div>
          <div className="flex items-center gap-4">
            <h1 className="text-xl font-semibold">Review & Approve</h1>
            {SHOW_LEGACY && (
              <TabSwitch
                value={view}
                onChange={setView}
                options={[
                  ['generated', 'Carousels'],
                  ['legacy', 'Legacy (old system)'],
                ]}
              />
            )}
          </div>
          <p className="mt-1 max-w-2xl text-sm text-slate-500">
            {view === 'generated'
              ? 'Each line is one carousel with its LinkedIn post. Versions made from the same topics are kept together under the period they cover — earlier versions are folded under the newest. Approved carousels can be downloaded in Export.'
              : 'Texts made by the system that came before this one. Earlier versions of your carousels are not here: they are under each carousel in the Carousels tab.'}
          </p>
        </div>
      </div>

      {view === 'legacy' ? (
        <LegacyReview />
      ) : (
      <>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
        <div className="inline-flex overflow-hidden rounded-md border border-slate-300 text-sm" role="tablist">
          {TABS.map((t) => (
            <button
              key={t.key}
              role="tab"
              aria-selected={tab === t.key}
              onClick={() => setTab(t.key)}
              className={`px-3 py-1.5 font-medium ${tab === t.key ? 'bg-slate-900 text-white' : 'bg-white text-slate-600 hover:bg-slate-100'}`}
            >
              {t.label} <span className={tab === t.key ? 'text-slate-300' : 'text-slate-400'}>{counts[t.key]}</span>
            </button>
          ))}
        </div>
        <div className="flex items-center gap-3 text-xs text-slate-500">
          {runFilter && (
            <button
              className="underline"
              onClick={() => {
                const next = new URLSearchParams(params)
                next.delete('run')
                setParams(next, { replace: true })
              }}
            >
              Showing one grouping — show all
            </button>
          )}
          {supersededCount > 0 && (
            <label className="flex cursor-pointer items-center gap-1.5">
              <input type="checkbox" checked={showSuperseded} onChange={(e) => setShowSuperseded(e.target.checked)} />
              Show {supersededCount} replaced
            </label>
          )}
        </div>
      </div>

      {items.length === 0 ? (
        <EmptyState>Nothing generated yet — create a carousel in Topics.</EmptyState>
      ) : (
        <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1.6fr)] gap-6">
          <div className="space-y-5">
            {groups.length === 0 && <EmptyState>Nothing in this tab.</EmptyState>}
            {groups.map((g) => {
              const run = ctx.runs.find((r) => r.id === g.runId)
              const isOpen = expanded.has(g.runId)
              const shown = isOpen ? g.list : g.list.slice(0, 1)
              const approved = g.all.filter((i) => i.status === 'approved').length
              return (
                <section key={g.runId}>
                  <div className="mb-1.5 flex items-baseline justify-between gap-2 px-1">
                    <h2 className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                      {run ? `Covers ${fmtCalendarDay(run.period_start)} – ${fmtCalendarDay(run.period_end)}` : 'Unknown period'}
                    </h2>
                    <span className="text-xs text-slate-400">
                      {g.all.length} version{g.all.length === 1 ? '' : 's'} · {approved} approved
                    </span>
                  </div>
                  <div className="space-y-2">
                    {shown.map((it) => (
                      <ItemCard
                        key={it.resultId}
                        item={it}
                        active={it.resultId === selectedId}
                        by={shortName(it.createdBy ? ctx.emailByUser.get(it.createdBy) : null)}
                        onClick={() => select(it.resultId)}
                      />
                    ))}
                  </div>
                  {g.list.length > 1 && (
                    <button
                      className="mt-1.5 px-1 text-xs font-medium text-slate-500 underline-offset-2 hover:underline"
                      onClick={() =>
                        setExpanded((prev) => {
                          const n = new Set(prev)
                          if (n.has(g.runId)) n.delete(g.runId)
                          else n.add(g.runId)
                          return n
                        })
                      }
                    >
                      {isOpen ? 'Show only the newest' : `Show ${g.list.length - 1} older version${g.list.length === 2 ? '' : 's'} ▸`}
                    </button>
                  )}
                </section>
              )
            })}
          </div>

          {selected ? (
            <div className="space-y-4">
              <ItemHeader
                item={selected}
                by={selected.createdBy ? (ctx.emailByUser.get(selected.createdBy) ?? null) : null}
                runCovers={(() => {
                  const r = ctx.runs.find((x) => x.id === selected.runId)
                  return r ? `${fmtCalendarDay(r.period_start)} – ${fmtCalendarDay(r.period_end)}` : null
                })()}
                onOpenPost={openPost}
              />
              {selected.rows.carousel && selected.rows.post && (
                <div className="inline-flex overflow-hidden rounded-md border border-slate-300 text-sm">
                  {(['carousel', 'post'] as const).map((k) => (
                    <button
                      key={k}
                      onClick={() => setOutput(k)}
                      className={`px-3 py-1.5 font-medium ${selectedOutput === k ? 'bg-slate-900 text-white' : 'bg-white text-slate-600 hover:bg-slate-100'}`}
                    >
                      {k === 'carousel' ? 'Carousel' : 'LinkedIn post'} · {selected.rows[k]!.status === 'draft' ? 'to approve' : selected.rows[k]!.status}
                    </button>
                  ))}
                </div>
              )}
              {selected.rows[selectedOutput] && (
                <GeneratedDetail
                  key={`${selected.resultId}:${selectedOutput}`}
                  row={selected.rows[selectedOutput]!}
                  onChanged={async () => {
                    await load()
                    await refresh()
                  }}
                  onOpenResult={(resultId) => {
                    setShowSuperseded(true)
                    select(resultId)
                  }}
                />
              )}
            </div>
          ) : (
            <div className="flex items-start pt-8">
              <EmptyState>Select a carousel to review it</EmptyState>
            </div>
          )}
        </div>
      )}
      </>
      )}
    </div>
  )
}

const NEW_FOR_MS = 24 * 3_600_000

function ItemCard({ item, active, by, onClick }: { item: Item; active: boolean; by: string; onClick: () => void }) {
  const isNew = Date.now() - Date.parse(item.createdAt) < NEW_FOR_MS
  return (
    <button
      id={`item-${item.resultId}`}
      onClick={onClick}
      className={`w-full rounded-lg border bg-white p-3 text-left transition ${active ? 'border-slate-900 ring-2 ring-slate-900/10' : 'border-slate-200 hover:border-slate-400'}`}
    >
      <div className="flex items-baseline justify-between gap-2 text-xs text-slate-500">
        <span>
          {isNew && (
            <span className="mr-1.5 rounded bg-blue-600 px-1.5 py-px text-[10px] font-bold tracking-wide text-white" title="Made in the last 24 hours">
              NEW
            </span>
          )}
          {fmtDayTime(item.createdAt)} · {by}
        </span>
        <span>
          {item.rawPostIds.length} post{item.rawPostIds.length === 1 ? '' : 's'}
        </span>
      </div>
      <p className="mt-1 font-medium leading-snug text-slate-900">{item.title}</p>
      <div className="mt-2 flex flex-wrap gap-1.5">
        {item.rows.carousel && <Status s={item.rows.carousel.status} label="Carousel" />}
        {item.rows.post && <Status s={item.rows.post.status} label="Post" />}
        {item.edited && <span className="rounded bg-amber-100 px-1.5 py-0.5 text-xs font-medium text-amber-700">edited</span>}
      </div>
    </button>
  )
}

function ItemHeader({
  item,
  by,
  runCovers,
  onOpenPost,
}: {
  item: Item
  by: string | null
  runCovers: string | null
  onOpenPost: (id: string) => void
}) {
  const [posts, setPosts] = useState<SourcePost[] | null>(null)
  useEffect(() => {
    let cancelled = false
    if (item.rawPostIds.length === 0) {
      setPosts([])
      return
    }
    setPosts(null)
    supabase
      .from('raw_posts')
      .select('id, post_title, post_text, published_at, sources ( name ), analyzed_posts ( overall_relevance )')
      .in('id', item.rawPostIds)
      .then(({ data }) => {
        if (cancelled) return
        const list = (data ?? []) as unknown as SourcePost[]
        setPosts(list.sort((a, b) => b.published_at.localeCompare(a.published_at)))
      })
    return () => {
      cancelled = true
    }
  }, [item.resultId, item.rawPostIds])

  return (
    <Card>
      <p className="text-xs text-slate-500">
        Made {fmtDayTime(item.createdAt)} by <span title={by ?? undefined}>{shortName(by)}</span>
        {runCovers && <> · covers {runCovers}</>}
      </p>
      <h2 className="mt-1 text-lg font-semibold text-slate-900">{item.title}</h2>
      <p className="mt-3 text-xs font-medium uppercase tracking-wide text-slate-400">
        Made from {item.rawPostIds.length} post{item.rawPostIds.length === 1 ? '' : 's'}
      </p>
      {!posts ? (
        <p className="mt-1 text-sm text-slate-400">Loading…</p>
      ) : (
        <ul className="mt-1 divide-y divide-slate-100">
          {posts.map((p) => (
            <li key={p.id}>
              <button onClick={() => onOpenPost(p.id)} className="flex w-full items-baseline justify-between gap-3 py-1.5 text-left hover:bg-slate-50">
                <span className="min-w-0">
                  <span className="text-xs text-slate-500">
                    {fmtDay(p.published_at)} · {p.sources?.name ?? '—'}
                  </span>
                  <span className="block truncate text-sm text-slate-800">{postTitle(p.post_title, p.post_text)}</span>
                </span>
                <span className="shrink-0 text-sm font-medium tabular-nums text-slate-700">
                  {p.analyzed_posts ? Math.round(Number(p.analyzed_posts.overall_relevance)) : '—'}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </Card>
  )
}
