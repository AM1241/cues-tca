import { createContext, useContext } from 'react'
import type { JourneyContext, JourneyPost, NextStep, Period, PeriodChoice, Summary } from './journey'

export type JourneyState = {
  choice: PeriodChoice
  period: Period
  setChoice: (c: PeriodChoice) => void
  ctx: JourneyContext | null
  /** Posts PUBLISHED in the period, newest first. */
  posts: JourneyPost[] | null
  summary: Summary | null
  next: NextStep | null
  loading: boolean
  error: string | null
  /** Re-read everything. Screens call it after any action that moves posts along. */
  refresh: () => Promise<void>
  /** Opens the side panel that shows one post's whole journey. */
  openPost: (rawPostId: string) => void
}

export const JourneyStateContext = createContext<JourneyState | null>(null)

export function useJourney(): JourneyState {
  const v = useContext(JourneyStateContext)
  if (!v) throw new Error('useJourney must be used inside <JourneyProvider>')
  return v
}
