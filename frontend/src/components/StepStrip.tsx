import { Link, useLocation } from 'react-router-dom'
import { fmtDayTime, fmtPeriod, type PeriodChoice } from '../lib/journey'
import { useJourney } from '../lib/journey-context'

// 3 days: "we need recent posts, e.g. only the last three days" (call of 2026-11-06).
const PRESETS = [3, 7, 15, 30, 90]

function PeriodPicker() {
  const { choice, period, setChoice } = useJourney()
  const value = choice.kind === 'last' && PRESETS.includes(choice.days) ? `last:${choice.days}` : 'range'

  function onSelect(v: string) {
    if (v === 'range') setChoice({ kind: 'range', start: period.start, end: period.end })
    else setChoice({ kind: 'last', days: Number(v.split(':')[1]) } as PeriodChoice)
  }

  return (
    <div className="flex flex-wrap items-center gap-2 text-sm">
      <span className="font-medium text-slate-700">Working period</span>
      <select
        value={value}
        onChange={(e) => onSelect(e.target.value)}
        className="rounded-md border border-slate-300 bg-white px-2 py-1 text-sm"
        aria-label="Working period"
      >
        {PRESETS.map((d) => (
          <option key={d} value={`last:${d}`}>
            Last {d} days
          </option>
        ))}
        <option value="range">Choose dates…</option>
      </select>
      {choice.kind === 'range' ? (
        <>
          <input
            type="date"
            value={choice.start}
            max={choice.end}
            onChange={(e) => e.target.value && setChoice({ ...choice, start: e.target.value })}
            className="rounded-md border border-slate-300 px-2 py-1 text-sm"
            aria-label="From"
          />
          <span className="text-slate-400">to</span>
          <input
            type="date"
            value={choice.end}
            min={choice.start}
            onChange={(e) => e.target.value && setChoice({ ...choice, end: e.target.value })}
            className="rounded-md border border-slate-300 px-2 py-1 text-sm"
            aria-label="To"
          />
        </>
      ) : (
        <span className="text-slate-500">{fmtPeriod(period)}</span>
      )}
    </div>
  )
}

/**
 * The map of the whole process, above every screen: how many of the period's
 * posts reached each step, and the one thing to do next. Every number is a way
 * in to the posts behind it.
 */
export function StepStrip() {
  const { summary, next, ctx, loading, error } = useJourney()
  const { pathname } = useLocation()

  const steps = summary
    ? [
        { label: 'Collected', count: summary.collected, to: '/posts?tab=all', screen: '/posts', hint: 'published in the period' },
        { label: 'Scored', count: summary.scored, to: '/posts?tab=all', screen: '/posts', hint: 'have a score' },
        {
          label: 'Selected',
          count: summary.selected,
          to: '/posts?tab=forward',
          screen: '/posts',
          hint: `score ${ctx?.threshold ?? 50} or more`,
        },
        { label: 'Anonymised', count: summary.anonymised, to: '/clusters', screen: '/clusters', hint: 'ready for topics' },
        { label: 'In a topic', count: summary.inTopics, to: '/clusters', screen: '/clusters', hint: 'grouped' },
        { label: 'In a carousel', count: summary.inCarousels, to: '/review', screen: '/review', hint: 'used in a draft' },
      ]
    : []

  return (
    <div className="mb-6 rounded-lg border border-slate-200 bg-white">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-100 px-4 py-2.5">
        <PeriodPicker />
        <div className="flex items-center gap-3 text-xs text-slate-500">
          {loading && <span className="h-3 w-3 animate-spin rounded-full border-2 border-slate-300 border-t-slate-600" />}
          {/* Who collected is left out on purpose (operator, 2026-11-20): the
              strip says when and how much, not by whom. */}
          {ctx?.lastCollect && (
            <span>
              Last Collect: {fmtDayTime(ctx.lastCollect.started_at)} ·{' '}
              <span className="font-medium text-slate-700">{ctx.lastCollect.posts_inserted} new posts</span>
            </span>
          )}
        </div>
      </div>

      {error && <p className="px-4 py-3 text-sm text-red-700">Could not read the pipeline: {error}</p>}

      {summary && (
        <ol className="grid grid-cols-6 divide-x divide-slate-100">
          {steps.map((s, i) => {
            const here = pathname.startsWith(s.screen)
            return (
              <li key={s.label} className="relative">
                <Link
                  to={s.to}
                  className={`block px-3 py-3 transition hover:bg-slate-50 ${here ? 'bg-slate-50' : ''}`}
                  title={`${s.count} ${s.hint}`}
                >
                  <span className={`block text-xs ${here ? 'font-semibold text-slate-900' : 'text-slate-500'}`}>
                    {i + 1}. {s.label}
                  </span>
                  <span
                    className={`mt-0.5 block text-2xl font-semibold tabular-nums ${
                      s.count === 0 ? 'text-slate-300' : 'text-slate-900'
                    }`}
                  >
                    {s.count}
                  </span>
                  <span className="block text-[11px] text-slate-400">{s.hint}</span>
                </Link>
                {i < steps.length - 1 && (
                  <span className="pointer-events-none absolute -right-2 top-1/2 z-[1] -translate-y-1/2 rounded-full bg-white px-0.5 text-slate-300">
                    ›
                  </span>
                )}
              </li>
            )
          })}
        </ol>
      )}

      {next && (
        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-slate-100 bg-indigo-50/60 px-4 py-2.5 text-sm">
          <p className="text-slate-800">
            <span className="mr-1.5 font-semibold text-indigo-700">Next:</span>
            {next.text}
          </p>
          {pathname.startsWith(next.to) ? (
            <span className="text-xs font-medium text-indigo-700">↓ on this screen</span>
          ) : (
            <Link
              to={next.to}
              className="rounded-md bg-indigo-600 px-3 py-1 text-xs font-medium text-white hover:bg-indigo-500"
            >
              {next.action} →
            </Link>
          )}
        </div>
      )}
    </div>
  )
}
