import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useLocation } from 'react-router-dom'
import {
  DEFAULT_PERIOD,
  loadContext,
  loadPeriodPosts,
  nextStep,
  resolvePeriod,
  summarise,
  type JourneyContext,
  type JourneyPost,
  type PeriodChoice,
} from '../lib/journey'
import { JourneyStateContext, type JourneyState } from '../lib/journey-context'
import { PostJourneyPanel } from './PostJourneyPanel'

const PERIOD_KEY = 'cues.journey.period'

// The period is a per-viewer convenience, so browser storage is enough; it must
// still work when storage is blocked, hence every access is guarded.
function readChoice(): PeriodChoice {
  try {
    const raw = localStorage.getItem(PERIOD_KEY)
    if (!raw) return DEFAULT_PERIOD
    const v = JSON.parse(raw) as PeriodChoice
    if (v.kind === 'last' && Number.isFinite(v.days) && v.days > 0) return v
    if (v.kind === 'range' && /^\d{4}-\d{2}-\d{2}$/.test(v.start) && /^\d{4}-\d{2}-\d{2}$/.test(v.end)) return v
  } catch {
    // fall through to the default
  }
  return DEFAULT_PERIOD
}

function writeChoice(c: PeriodChoice) {
  try {
    localStorage.setItem(PERIOD_KEY, JSON.stringify(c))
  } catch {
    // storage unavailable — the choice still holds for this visit
  }
}

/**
 * One working period and one reading of the pipeline, shared by every screen.
 * Before this, Rating looked at 15 days, Topics at 30 and Review at everything,
 * so the same post could be on one screen and missing from the next.
 */
export function JourneyProvider({ children }: { children: ReactNode }) {
  const location = useLocation()
  const [choice, setChoiceState] = useState<PeriodChoice>(readChoice)
  const period = useMemo(() => resolvePeriod(choice), [choice])
  const [ctx, setCtx] = useState<JourneyContext | null>(null)
  const [posts, setPosts] = useState<JourneyPost[] | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [openId, setOpenId] = useState<string | null>(null)
  // Only the newest request may write: changing the period twice quickly must
  // not let the slower, older answer land last.
  const seq = useRef(0)

  const refresh = useCallback(async () => {
    const mine = ++seq.current
    setLoading(true)
    try {
      const c = await loadContext()
      const p = await loadPeriodPosts(period, c)
      if (mine !== seq.current) return
      setCtx(c)
      setPosts(p)
      setError(null)
    } catch (e) {
      if (mine === seq.current) setError(e instanceof Error ? e.message : String(e))
    } finally {
      if (mine === seq.current) setLoading(false)
    }
  }, [period])

  // Re-read on every screen change too: an action on one screen (Collect,
  // Score now) moves posts that the strip on the next screen counts.
  useEffect(() => {
    refresh()
  }, [refresh, location.pathname])

  const setChoice = useCallback((c: PeriodChoice) => {
    writeChoice(c)
    setChoiceState(c)
  }, [])

  const summary = useMemo(() => (ctx && posts ? summarise(posts, ctx, period) : null), [ctx, posts, period])
  const next = useMemo(() => (ctx && summary ? nextStep(summary, ctx, period) : null), [ctx, summary, period])

  const value: JourneyState = {
    choice,
    period,
    setChoice,
    ctx,
    posts,
    summary,
    next,
    loading,
    error,
    refresh,
    openPost: setOpenId,
  }

  return (
    <JourneyStateContext.Provider value={value}>
      {children}
      {openId && ctx && <PostJourneyPanel rawPostId={openId} ctx={ctx} onClose={() => setOpenId(null)} />}
    </JourneyStateContext.Provider>
  )
}
