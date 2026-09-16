import { NavLink, Outlet } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import { Button } from './ui'

// Ordered to match the pipeline itself (CLAUDE.md's "Pipeline order"), not
// alphabetically or by build date: collect, configure, then everything that
// reads the configuration. An editor working top-to-bottom through the nav
// bar now works top-to-bottom through the actual process.
const routes = [
  { to: '/sources', label: 'Sources' },
  { to: '/objective', label: 'Settings' },
  { to: '/posts', label: 'Rating' },
  { to: '/clusters', label: 'Topics' },
  { to: '/review', label: 'Review & Approve' },
  { to: '/export', label: 'Export' },
]

export function Layout({ email }: { email: string }) {
  return (
    <div className="min-h-screen bg-slate-50 text-slate-900">
      <header className="border-b border-slate-200 bg-white">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-6 py-3">
          <div className="flex items-center gap-8">
            <div>
              <p className="text-xs font-medium tracking-widest text-slate-500 uppercase">
                CUES
              </p>
              <p className="text-sm font-semibold leading-none">
                Post Generator
              </p>
              <p className="text-xs text-slate-500 leading-none mt-1">
                LinkedIn posts and carousels, ready for review
              </p>
            </div>
            <nav className="flex gap-1">
              {routes.map((r) => (
                <NavLink
                  key={r.to}
                  to={r.to}
                  className={({ isActive }: { isActive: boolean }) =>
                    `rounded-md px-3 py-1.5 text-sm font-medium transition ${
                      isActive
                        ? 'bg-slate-900 text-white'
                        : 'text-slate-600 hover:bg-slate-100'
                    }`
                  }
                >
                  {r.label}
                </NavLink>
              ))}
            </nav>
          </div>
          <div className="flex items-center gap-4">
            <span className="text-sm text-slate-600">{email}</span>
            <Button onClick={() => supabase.auth.signOut()}>Sign out</Button>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-6xl px-6 py-8">
        <Outlet />
      </main>
    </div>
  )
}
