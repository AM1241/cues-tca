// The per-theme scores of one post, as the classic Rating table shows them
// (routes/Posts.tsx): a bar and a number per theme, and the "1 of 6 themes"
// warning. The operator asked on 2026-11-17 to keep them in the new layout.
// Copied rather than imported so the classic screen stays untouched.

function ScoreBar({ value }: { value: number }) {
  const pct = Math.max(0, Math.min(100, value))
  return (
    <div className="flex items-center gap-1.5">
      <div className="h-1.5 w-12 overflow-hidden rounded-full bg-slate-200">
        <div className="h-full rounded-full bg-slate-900" style={{ width: `${pct}%` }} />
      </div>
      <span className="w-6 text-right text-[11px] tabular-nums text-slate-600">{Math.round(value)}</span>
    </div>
  )
}

export function ThemeScores({ scores }: { scores: Record<string, number> }) {
  return (
    <div className="grid grid-cols-2 gap-x-4 gap-y-1">
      {Object.entries(scores).map(([theme, v]) => (
        <div key={theme} className="flex items-center justify-between gap-2">
          <span className="text-[11px] leading-tight text-slate-500">{theme}</span>
          <ScoreBar value={Number(v)} />
        </div>
      ))}
    </div>
  )
}

/**
 * The overall score is the highest single theme (aggregation `max_theme_v1`), so
 * a post scoring 95 on one theme and 0 on the rest looks the same as one scoring
 * 95 everywhere. This makes that visible; it changes no decision.
 */
export function SingleThemeNotice({ scores }: { scores: Record<string, number> }) {
  const values = Object.values(scores).map(Number)
  if (values.length < 2) return null
  const top = Math.max(...values)
  if (top === 0) return null
  const carrying = values.filter((v) => v >= top * 0.5).length
  if (carrying > 1) return null
  return (
    <span className="mt-0.5 block text-[11px] text-amber-600" title="Only one theme carries this score; the rest are far lower.">
      1 of {values.length} themes
    </span>
  )
}
