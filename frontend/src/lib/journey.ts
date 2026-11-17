/**
 * The "journey" of a post: how far it got through the pipeline and, when it
 * stopped, why. Tecnoalimenti's feedback (call of 2026-11-06) was that with
 * hundreds of posts nobody could tell which ones flowed into a carousel and
 * which did not. Every screen showed its own table in its own order and its own
 * time window, so the link between the steps was lost.
 *
 * Everything here is READ-ONLY and computed from tables that already exist:
 *   raw_posts -> analyzed_posts -> anonymized_posts_current
 *     -> clustering_run_posts / cluster_assignments -> cluster_generation_results.raw_post_ids
 * No schema change is needed; editors can read all of it under RLS.
 */
import { supabase } from './supabase'
import { PER_CLUSTER_GENERATION } from './features'

// -----------------------------------------------------------------------------
// Period
// -----------------------------------------------------------------------------

/** Inclusive calendar days in UTC, as YYYY-MM-DD — the same convention Topics' date inputs used. */
export type Period = { start: string; end: string }

/** What the editor picked: a rolling preset, or fixed dates. Stored, so it has to survive days passing. */
export type PeriodChoice = { kind: 'last'; days: number } | { kind: 'range'; start: string; end: string }

/** A fortnight: the publication cycle in the editorial brief, and Rating's window before this change. */
export const DEFAULT_PERIOD: PeriodChoice = { kind: 'last', days: 15 }

export function isoDay(d: Date): string {
  return d.toISOString().slice(0, 10)
}

export function daysAgo(n: number): string {
  const d = new Date()
  d.setUTCDate(d.getUTCDate() - n)
  return isoDay(d)
}

export function resolvePeriod(c: PeriodChoice): Period {
  return c.kind === 'last' ? { start: daysAgo(c.days), end: daysAgo(0) } : { start: c.start, end: c.end }
}

/** Half-open timestamp bounds for a query: [start 00:00Z, day after end 00:00Z). */
export function periodBounds(p: Period): { from: string; to: string } {
  const end = new Date(`${p.end}T00:00:00Z`)
  end.setUTCDate(end.getUTCDate() + 1)
  return { from: `${p.start}T00:00:00Z`, to: end.toISOString() }
}

export function inPeriod(iso: string, p: Period): boolean {
  const { from, to } = periodBounds(p)
  return iso >= from && iso < to
}

/** Two periods share at least one day. */
export function overlaps(aStart: string, aEnd: string, p: Period): boolean {
  const { from, to } = periodBounds(p)
  return aStart < to && aEnd >= from
}

// -----------------------------------------------------------------------------
// Dates, written the way an editor reads them
// -----------------------------------------------------------------------------

const THIS_YEAR = new Date().getUTCFullYear()

/** "1 Nov" this year, "24 Jun 2025" otherwise. */
export function fmtDay(iso: string): string {
  const d = new Date(iso)
  return d.toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'short',
    ...(d.getFullYear() === THIS_YEAR ? {} : { year: 'numeric' }),
  })
}

/** "1 Nov, 22:33". */
export function fmtDayTime(iso: string): string {
  const d = new Date(iso)
  return `${fmtDay(iso)}, ${d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}`
}

/** "Saturday 1 November" — the heading over a day's posts. */
export function fmtDayHeading(iso: string): string {
  const d = new Date(iso)
  return d.toLocaleDateString('en-GB', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    ...(d.getFullYear() === THIS_YEAR ? {} : { year: 'numeric' }),
  })
}

/** For a bare calendar day (YYYY-MM-DD or a midnight-UTC timestamp): read it in UTC so it never shifts a day. */
export function fmtCalendarDay(isoOrDay: string): string {
  const d = new Date(isoOrDay.length === 10 ? `${isoOrDay}T00:00:00Z` : isoOrDay)
  return d.toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'short',
    timeZone: 'UTC',
    ...(d.getUTCFullYear() === THIS_YEAR ? {} : { year: 'numeric' }),
  })
}

export function fmtPeriod(p: { start: string; end: string }): string {
  return `${fmtCalendarDay(p.start)} – ${fmtCalendarDay(p.end)}`
}

export function daysSince(iso: string): number {
  return Math.floor((Date.now() - Date.parse(iso)) / 86_400_000)
}

/** "g.rivoltella@tecnoalimenti.com" -> "g.rivoltella". The full address is in the tooltip. */
export function shortName(email: string | null | undefined): string {
  if (!email) return 'unknown'
  return email.split('@')[0]
}

// -----------------------------------------------------------------------------
// Stages
// -----------------------------------------------------------------------------

/**
 * The furthest point a post reached. Ordered: each stage implies the ones
 * before it, which is what keeps the step strip's numbers from ever growing
 * left to right.
 */
export type Stage =
  | 'unscored' //    collected, no score yet
  | 'below' //       scored under the threshold — stops here
  | 'selected' //    at or above the threshold, not anonymised yet
  | 'anonymised' //  ready for topics, never part of a grouping
  | 'unclustered' // part of the newest grouping that saw it, but fitted no topic
  | 'topic' //       in a topic, no carousel made from it yet
  | 'carousel' //    used in at least one carousel

export const STAGE_ORDER: Stage[] = ['unscored', 'below', 'selected', 'anonymised', 'unclustered', 'topic', 'carousel']

export const STAGE_LABEL: Record<Stage, string> = {
  unscored: 'Not scored yet',
  below: 'Below threshold',
  selected: 'Waiting for anonymisation',
  anonymised: 'Ready for topics',
  unclustered: 'Did not fit a topic',
  topic: 'In a topic',
  carousel: 'In a carousel',
}

/** Did the post pass Rating? Only the first two stages stop there. */
export function goesForward(s: Stage): boolean {
  return s !== 'unscored' && s !== 'below'
}

// -----------------------------------------------------------------------------
// Shared, period-independent context
// -----------------------------------------------------------------------------

export type RunInfo = {
  id: string
  period_start: string
  period_end: string
  status: string
  error_message: string | null
  created_at: string
  created_by: string | null
}

export type ClusterInfo = { id: string; label: string; label_failed: boolean; clustering_run_id: string }

export type ReviewStatus = 'draft' | 'approved' | 'rejected' | 'superseded'

export type CarouselRef = {
  id: string
  title: string
  created_at: string
  clustering_run_id: string
  raw_post_ids: string[]
  status: ReviewStatus
  created_by: string | null
}

export type CollectSession = {
  started_at: string
  finished_at: string | null
  posts_inserted: number
  sources: number
  by: string | null
}

export type JourneyContext = {
  threshold: number
  scoringQueued: Set<string>
  /** Only non-succeeded jobs: pending, processing or dead_letter. */
  anonymiseState: Map<string, string>
  runs: RunInfo[]
  /** raw_post_id -> run ids that took it as input, newest run first. */
  runsByPost: Map<string, string[]>
  /** run id -> raw_post_ids it took as input. */
  postsByRun: Map<string, string[]>
  clusters: Map<string, ClusterInfo>
  /** run id -> (raw_post_id -> cluster id). */
  assignment: Map<string, Map<string, string>>
  carousels: CarouselRef[]
  carouselsByPost: Map<string, CarouselRef[]>
  lastCollect: CollectSession | null
  emailByUser: Map<string, string>
  newestPublished: string | null
}

/**
 * An item's overall review status from its post and carousel rows. Approved
 * wins: an approved carousel is exportable whatever the post says.
 */
export function combineStatus(statuses: string[]): ReviewStatus {
  if (statuses.includes('approved')) return 'approved'
  if (statuses.length > 0 && statuses.every((s) => s === 'superseded')) return 'superseded'
  if (statuses.length > 0 && statuses.every((s) => s === 'rejected' || s === 'superseded')) return 'rejected'
  return 'draft'
}

/** PostgREST caps a response (1000 rows by default); page until a short page comes back. */
async function fetchAll<T>(
  build: (from: number, to: number) => PromiseLike<{ data: unknown; error: { message: string } | null }>,
): Promise<T[]> {
  const page = 1000
  const out: T[] = []
  for (let from = 0; ; from += page) {
    const { data, error } = await build(from, from + page - 1)
    if (error) throw new Error(error.message)
    const rows = (data ?? []) as T[]
    out.push(...rows)
    if (rows.length < page) return out
  }
}

/** Consecutive Collect runs less than this far apart are one press of "Collect all". */
const COLLECT_SESSION_GAP_MS = 10 * 60_000

export async function loadContext(): Promise<JourneyContext> {
  const [config, scoring, anon, runs, runPosts, clusters, assignments, results, ingest, editors, newest] =
    await Promise.all([
      supabase.from('configurations').select('min_relevance_score').eq('id', 'default').maybeSingle(),
      fetchAll<{ raw_post_id: string }>((a, b) =>
        supabase.from('scoring_job_state').select('raw_post_id').in('status', ['pending', 'processing']).range(a, b),
      ),
      fetchAll<{ raw_post_id: string; status: string }>((a, b) =>
        supabase.from('anonymize_job_state').select('raw_post_id, status').neq('status', 'succeeded').range(a, b),
      ),
      supabase
        .from('clustering_runs')
        .select('id, period_start, period_end, status, error_message, created_at, created_by')
        .order('created_at', { ascending: false }),
      fetchAll<{ clustering_run_id: string; raw_post_id: string }>((a, b) =>
        supabase.from('clustering_run_posts').select('clustering_run_id, raw_post_id').range(a, b),
      ),
      fetchAll<ClusterInfo>((a, b) =>
        supabase.from('clusters').select('id, label, label_failed, clustering_run_id').range(a, b),
      ),
      fetchAll<{ cluster_id: string; raw_post_id: string }>((a, b) =>
        supabase.from('cluster_assignments').select('cluster_id, raw_post_id').range(a, b),
      ),
      fetchAll<{
        id: string
        cluster_label: string
        created_at: string
        clustering_run_id: string
        raw_post_ids: string[] | null
        cluster_generation_reviews: { output_type: string; status: string }[]
        cluster_generation_requests: { created_by: string | null } | null
      }>((a, b) =>
        supabase
          .from('cluster_generation_results')
          .select(
            `id, cluster_label, created_at, clustering_run_id, raw_post_ids,
             cluster_generation_reviews!cluster_generation_reviews_result_id_fkey ( output_type, status ),
             cluster_generation_requests!cluster_generation_results_generation_request_id_fkey ( created_by )`,
          )
          .in('kind', PER_CLUSTER_GENERATION ? ['per_cluster', 'publication'] : ['publication'])
          .order('created_at', { ascending: false })
          .range(a, b),
      ),
      supabase
        .from('ingest_runs')
        .select('started_at, finished_at, posts_inserted, status, triggered_by_email, dry_run')
        .eq('dry_run', false)
        .order('started_at', { ascending: false })
        .limit(80),
      supabase.from('editors').select('user_id, email'),
      supabase.from('raw_posts').select('published_at').order('published_at', { ascending: false }).limit(1),
    ])
  for (const r of [config, runs, ingest, editors, newest]) {
    if (r.error) throw new Error(r.error.message)
  }

  const runsByPost = new Map<string, string[]>()
  const postsByRun = new Map<string, string[]>()
  const runRows = (runs.data ?? []) as RunInfo[]
  const runRank = new Map(runRows.map((r, i) => [r.id, i]))
  for (const rp of runPosts) {
    if (!runsByPost.has(rp.raw_post_id)) runsByPost.set(rp.raw_post_id, [])
    runsByPost.get(rp.raw_post_id)!.push(rp.clustering_run_id)
    if (!postsByRun.has(rp.clustering_run_id)) postsByRun.set(rp.clustering_run_id, [])
    postsByRun.get(rp.clustering_run_id)!.push(rp.raw_post_id)
  }
  for (const list of runsByPost.values()) list.sort((a, b) => (runRank.get(a) ?? 0) - (runRank.get(b) ?? 0))

  const clusterMap = new Map(clusters.map((c) => [c.id, c]))
  const assignment = new Map<string, Map<string, string>>()
  for (const a of assignments) {
    const c = clusterMap.get(a.cluster_id)
    if (!c) continue
    if (!assignment.has(c.clustering_run_id)) assignment.set(c.clustering_run_id, new Map())
    assignment.get(c.clustering_run_id)!.set(a.raw_post_id, a.cluster_id)
  }

  const carousels: CarouselRef[] = results.map((r) => ({
    id: r.id,
    title: r.cluster_label,
    created_at: r.created_at,
    clustering_run_id: r.clustering_run_id,
    raw_post_ids: r.raw_post_ids ?? [],
    status: combineStatus((r.cluster_generation_reviews ?? []).map((v) => v.status)),
    created_by: r.cluster_generation_requests?.created_by ?? null,
  }))
  const carouselsByPost = new Map<string, CarouselRef[]>()
  for (const c of carousels) {
    for (const id of c.raw_post_ids) {
      if (!carouselsByPost.has(id)) carouselsByPost.set(id, [])
      carouselsByPost.get(id)!.push(c)
    }
  }

  // The newest Collect, as the editor experienced it: "Collect all" sends one
  // request per source (Sources.tsx), so one press is a burst of runs.
  type Ingest = {
    started_at: string
    finished_at: string | null
    posts_inserted: number | null
    triggered_by_email: string | null
  }
  const ingestRows = (ingest.data ?? []) as Ingest[]
  let lastCollect: CollectSession | null = null
  if (ingestRows.length > 0) {
    let start = ingestRows[0]
    let inserted = 0
    let sources = 0
    for (const r of ingestRows) {
      // Start-to-start, not end-to-start: a run left stuck is closed by the next
      // Collect (production's 2026-10-19 run got finished_at 2026-11-01), so its
      // end time would glue two unrelated presses into one.
      const gap = Date.parse(start.started_at) - Date.parse(r.started_at)
      if (r !== ingestRows[0] && gap > COLLECT_SESSION_GAP_MS) break
      start = r
      inserted += r.posts_inserted ?? 0
      sources += 1
    }
    lastCollect = {
      started_at: start.started_at,
      finished_at: ingestRows[0].finished_at,
      posts_inserted: inserted,
      sources,
      by: ingestRows[0].triggered_by_email,
    }
  }

  return {
    threshold: Number(config.data?.min_relevance_score ?? 50),
    scoringQueued: new Set(scoring.map((s) => s.raw_post_id)),
    anonymiseState: new Map(anon.map((s) => [s.raw_post_id, s.status])),
    runs: runRows,
    runsByPost,
    postsByRun,
    clusters: clusterMap,
    assignment,
    carousels,
    carouselsByPost,
    lastCollect,
    emailByUser: new Map(((editors.data ?? []) as { user_id: string; email: string }[]).map((e) => [e.user_id, e.email])),
    newestPublished: (newest.data?.[0] as { published_at: string } | undefined)?.published_at ?? null,
  }
}

// -----------------------------------------------------------------------------
// Posts in a period
// -----------------------------------------------------------------------------

export type JourneyPost = {
  id: string
  title: string
  published_at: string
  collected_at: string
  source_url: string
  source_name: string
  score: number | null
  reason: string | null
  themeScores: Record<string, number> | null
  anonymised: boolean
  isNew: boolean
  stage: Stage
  /** The topic in the newest grouping that took this post, if it fitted one. */
  topic: { label: string; runId: string } | null
  carousels: CarouselRef[]
  /** One plain sentence: where the post is, or why it stopped. */
  why: string
}

type RawRow = {
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
  } | null
  // current_result_id, not the row: "Redo all" (requeue_anonymisation) keeps the
  // row and nulls this column, and clustering only takes posts where it is set.
  anonymized_posts_current: { current_result_id: string | null } | null
}

export function postTitle(title: string | null | undefined, text: string | null | undefined): string {
  const t = title?.trim()
  if (t) return t
  const body = (text ?? '').replace(/\s+/g, ' ').trim()
  if (!body) return '(untitled)'
  return body.length > 110 ? body.slice(0, 110).trimEnd() + '…' : body
}

export function topTheme(scores: Record<string, number> | null): { theme: string; value: number } | null {
  if (!scores) return null
  let best: { theme: string; value: number } | null = null
  for (const [theme, v] of Object.entries(scores)) {
    const value = Number(v)
    if (!best || value > best.value) best = { theme, value }
  }
  return best
}

/** Stage and explanation for one post, from its own facts plus the shared context. */
export function placePost(
  /** redo: anonymised once, then marked for a fresh pass by "Redo all". */
  p: { id: string; score: number | null; anonymised: boolean; redo?: boolean },
  ctx: JourneyContext,
): { stage: Stage; topic: JourneyPost['topic']; carousels: CarouselRef[]; why: string } {
  const carousels = ctx.carouselsByPost.get(p.id) ?? []
  const newestRun = (ctx.runsByPost.get(p.id) ?? [])[0]
  const clusterId = newestRun ? ctx.assignment.get(newestRun)?.get(p.id) : undefined
  const cluster = clusterId ? ctx.clusters.get(clusterId) : undefined
  const topic = cluster && newestRun ? { label: cluster.label, runId: newestRun } : null
  const run = newestRun ? ctx.runs.find((r) => r.id === newestRun) : undefined

  if (carousels.length > 0) {
    const latest = carousels[0]
    const approved = carousels.some((c) => c.status === 'approved')
    const more = carousels.length > 1 ? ` (and ${carousels.length - 1} other version${carousels.length === 2 ? '' : 's'})` : ''
    return {
      stage: 'carousel',
      topic,
      carousels,
      why: `Used in the carousel «${latest.title}»${more}${approved ? ' · an approved version exists' : ''}`,
    }
  }
  if (p.score === null) {
    return {
      stage: 'unscored',
      topic: null,
      carousels,
      why: ctx.scoringQueued.has(p.id)
        ? 'Not scored yet — waiting in the scoring queue. Press Score now in Rating.'
        : 'Not scored yet, and not in the queue. Press Queue unscored in Rating.',
    }
  }
  if (p.score < ctx.threshold) {
    return {
      stage: 'below',
      topic: null,
      carousels,
      why: `Score ${Math.round(p.score)} is below the threshold of ${ctx.threshold}, so it stops at Rating.`,
    }
  }
  if (!p.anonymised) {
    const st = ctx.anonymiseState.get(p.id)
    return {
      stage: 'selected',
      topic: null,
      carousels,
      why:
        st === 'dead_letter'
          ? p.redo
            ? 'Selected. Its anonymisation was reset by Redo all and must run again. Press Anonymise now in Topics.'
            : 'Selected, but anonymisation failed. Open it to see why.'
          : p.redo
            ? 'Selected. Its anonymisation was reset by Redo all and is waiting to run again (Anonymise now in Topics).'
            : 'Selected — next it needs anonymising. Press Anonymise now in Topics.',
    }
  }
  if (!newestRun) {
    return {
      stage: 'anonymised',
      topic: null,
      carousels,
      why: 'Ready, but not grouped into topics yet. Run clustering over a period that includes it.',
    }
  }
  if (!topic) {
    return {
      stage: 'unclustered',
      topic: null,
      carousels,
      why: `Did not fit any topic in the grouping of ${run ? fmtDay(run.created_at) : '?'}: no other post was similar enough.`,
    }
  }
  return {
    stage: 'topic',
    topic,
    carousels,
    why: `In the topic «${topic.label}». No carousel has been made from it yet.`,
  }
}

export async function loadPeriodPosts(period: Period, ctx: JourneyContext): Promise<JourneyPost[]> {
  const { from, to } = periodBounds(period)
  const rows = await fetchAll<RawRow>((a, b) =>
    supabase
      .from('raw_posts')
      .select(
        `id, post_title, post_text, published_at, created_at, source_url,
         sources ( name ),
         analyzed_posts ( overall_relevance, reason_for_score, relevance_scores ),
         anonymized_posts_current ( current_result_id )`,
      )
      .gte('published_at', from)
      .lt('published_at', to)
      .order('published_at', { ascending: false })
      .range(a, b),
  )
  const newSince = ctx.lastCollect ? Date.parse(ctx.lastCollect.started_at) - 1000 : Infinity
  return rows.map((r) => {
    const score = r.analyzed_posts ? Number(r.analyzed_posts.overall_relevance) : null
    const anonymised = Boolean(r.anonymized_posts_current?.current_result_id)
    const redo = r.anonymized_posts_current !== null && !anonymised
    const placed = placePost({ id: r.id, score, anonymised, redo }, ctx)
    return {
      id: r.id,
      title: postTitle(r.post_title, r.post_text),
      published_at: r.published_at,
      collected_at: r.created_at,
      source_url: r.source_url,
      source_name: r.sources?.name ?? '—',
      score,
      reason: r.analyzed_posts?.reason_for_score ?? null,
      themeScores: r.analyzed_posts?.relevance_scores ?? null,
      anonymised,
      isNew: Date.parse(r.created_at) >= newSince,
      ...placed,
    }
  })
}

// -----------------------------------------------------------------------------
// The step strip: counts and the one thing to do next
// -----------------------------------------------------------------------------

export type Summary = {
  collected: number
  scored: number
  selected: number
  anonymised: number
  inTopics: number
  inCarousels: number
  unscored: number
  waitingAnonymise: number
  notGrouped: number
  draftsForPeriod: number
  approvedForPeriod: number
}

export function summarise(posts: JourneyPost[], ctx: JourneyContext, period: Period): Summary {
  const at = (s: Stage) => STAGE_ORDER.indexOf(s)
  const count = (min: Stage) => posts.filter((p) => at(p.stage) >= at(min)).length
  // Carousels "for this period": made from a grouping whose dates overlap it.
  const runIds = new Set(ctx.runs.filter((r) => overlaps(r.period_start, r.period_end, period)).map((r) => r.id))
  const forPeriod = ctx.carousels.filter((c) => runIds.has(c.clustering_run_id))
  return {
    collected: posts.length,
    scored: count('below'),
    selected: count('selected'),
    anonymised: count('anonymised'),
    inTopics: count('topic'),
    inCarousels: count('carousel'),
    unscored: posts.filter((p) => p.stage === 'unscored').length,
    waitingAnonymise: posts.filter((p) => p.stage === 'selected').length,
    notGrouped: posts.filter((p) => p.stage === 'anonymised').length,
    draftsForPeriod: forPeriod.filter((c) => c.status === 'draft').length,
    approvedForPeriod: forPeriod.filter((c) => c.status === 'approved').length,
  }
}

export type NextStep = { text: string; to: string; action: string }

export function nextStep(s: Summary, ctx: JourneyContext, period: Period): NextStep {
  if (s.collected === 0) {
    const newest = ctx.newestPublished
    return {
      text: newest
        ? `Nothing collected was published in ${fmtPeriod(period)}. The newest post is from ${fmtDay(newest)} (${daysSince(newest)} days ago) — collect again, or widen the period.`
        : 'Nothing has been collected yet.',
      to: '/sources',
      action: 'Go to Sources',
    }
  }
  if (s.unscored > 0) {
    return {
      text: `${s.unscored} post${s.unscored === 1 ? ' is' : 's are'} not scored yet. Each Score now scores 10, newest first.`,
      to: '/posts',
      action: 'Score in Rating',
    }
  }
  if (s.waitingAnonymise > 0) {
    return {
      text: `${s.waitingAnonymise} selected post${s.waitingAnonymise === 1 ? ' needs' : 's need'} anonymising before they can be grouped into topics.`,
      to: '/clusters',
      action: 'Anonymise in Topics',
    }
  }
  if (s.notGrouped > 0) {
    return {
      text: `${s.notGrouped} post${s.notGrouped === 1 ? ' is' : 's are'} ready but not grouped yet. Run clustering for this period.`,
      to: '/clusters',
      action: 'Group in Topics',
    }
  }
  if (s.selected === 0) {
    return {
      text: `No post in this period reached the threshold of ${ctx.threshold}. Widen the period, or lower the threshold in Settings.`,
      to: '/posts',
      action: 'See Rating',
    }
  }
  if (s.inTopics > 0 && s.inCarousels === 0) {
    return { text: 'Topics are ready. Create the carousel from them.', to: '/clusters', action: 'Create in Topics' }
  }
  if (s.draftsForPeriod > 0) {
    return {
      text: `${s.draftsForPeriod} carousel version${s.draftsForPeriod === 1 ? '' : 's'} for this period ${s.draftsForPeriod === 1 ? 'is' : 'are'} waiting for approval.`,
      to: '/review',
      action: 'Open Review',
    }
  }
  if (s.approvedForPeriod > 0) {
    return { text: 'An approved carousel is ready to download.', to: '/export', action: 'Open Export' }
  }
  return { text: 'Nothing left to do for this period.', to: '/review', action: 'Open Review' }
}
