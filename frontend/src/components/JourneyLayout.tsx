import { NavLink, Outlet, useLocation } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import { Button } from './ui'
import { JourneyProvider } from './JourneyProvider'
import { StepStrip } from './StepStrip'

// The steps an editor repeats every cycle, numbered in the order they happen.
// Settings is configuration, not a step, so it sits apart on the right.
const steps = [
  { to: '/sources', label: 'Sources' },
  { to: '/posts', label: 'Rating' },
  { to: '/clusters', label: 'Topics' },
  { to: '/review', label: 'Review & Approve' },
  { to: '/export', label: 'Export' },
]

function navClass({ isActive }: { isActive: boolean }) {
  return `rounded-md px-3 py-1.5 text-sm font-medium transition ${
    isActive ? 'bg-slate-900 text-white' : 'text-slate-600 hover:bg-slate-100'
  }`
}

export function JourneyLayout({ email, onSwitchUi }: { email: string; onSwitchUi: () => void }) {
  const { pathname } = useLocation()
  return (
    <JourneyProvider>
      <div className="min-h-screen bg-slate-50 text-slate-900">
        <header className="border-b border-slate-200 bg-white">
          <div className="mx-auto flex max-w-6xl items-center justify-between gap-4 px-6 py-3">
            <div className="flex items-center gap-6">
              <div className="shrink-0">
                <p className="text-xs font-medium tracking-widest text-slate-500 uppercase">CUES</p>
                <p className="text-sm font-semibold leading-none">Post Generator</p>
              </div>
              <nav className="flex items-center gap-1 whitespace-nowrap">
                {steps.map((r, i) => (
                  <NavLink key={r.to} to={r.to} className={navClass}>
                    <span className="mr-1 opacity-60">{i + 1}</span>
                    {r.label}
                  </NavLink>
                ))}
              </nav>
            </div>
            <div className="flex items-center gap-3 whitespace-nowrap">
              <NavLink to="/objective" className={navClass}>
                Settings
              </NavLink>
              <span className="hidden max-w-[14rem] truncate text-sm text-slate-600 xl:inline" title={email}>
                {email}
              </span>
              <Button size="sm" onClick={() => supabase.auth.signOut()} title={email}>
                Sign out
              </Button>
            </div>
          </div>
        </header>

        <main className="mx-auto max-w-6xl px-6 py-6">
          {pathname !== '/objective' && <StepStrip />}
          <Outlet />
          <p className="mt-10 text-center text-xs text-slate-400">
            New layout ·{' '}
            <button onClick={onSwitchUi} className="underline hover:text-slate-600">
              switch to the classic screens
            </button>
          </p>
        </main>
      </div>
    </JourneyProvider>
  )
}
