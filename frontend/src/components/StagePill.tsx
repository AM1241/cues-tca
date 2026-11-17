import { STAGE_LABEL, type Stage } from '../lib/journey'

// One colour per stage, used everywhere a post appears, so "where is it?" reads
// the same on Rating, Topics, Review and in the journey panel.
const STAGE_STYLE: Record<Stage, string> = {
  unscored: 'bg-slate-100 text-slate-500',
  below: 'bg-slate-100 text-slate-600',
  selected: 'bg-amber-100 text-amber-800',
  anonymised: 'bg-sky-100 text-sky-800',
  unclustered: 'bg-orange-100 text-orange-800',
  topic: 'bg-indigo-100 text-indigo-800',
  carousel: 'bg-emerald-100 text-emerald-800',
}

export function StagePill({ stage, className = '' }: { stage: Stage; className?: string }) {
  return (
    <span className={`inline-flex items-center whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium ${STAGE_STYLE[stage]} ${className}`}>
      {STAGE_LABEL[stage]}
    </span>
  )
}
