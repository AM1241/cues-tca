import { useState } from 'react'
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import { useAuth } from './lib/useAuth'
import { Login } from './components/Login'
import { Layout } from './components/Layout'
import { JourneyLayout } from './components/JourneyLayout'
import { Posts } from './routes/Posts'
import { Sources } from './routes/Sources'
import { Objective } from './routes/Objective'
import { Clusters } from './routes/Clusters'
import { Review } from './routes/Review'
import { Export } from './routes/Export'
import { RatingJourney } from './routes/RatingJourney'
import { TopicsJourney } from './routes/TopicsJourney'
import { ReviewJourney } from './routes/ReviewJourney'
import { readUiVersion, writeUiVersion, type UiVersion } from './lib/uiVersion'
import { NEW_LAYOUT } from './lib/features'

function App() {
  const { session, isEditor, loading, signOut } = useAuth()
  const [ui, setUi] = useState<UiVersion>(readUiVersion)
  const switchUi = () => {
    const next: UiVersion = ui === 'journey' ? 'classic' : 'journey'
    writeUiVersion(next)
    setUi(next)
  }
  const classic = ui === 'classic'

  if (loading) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-slate-50">
        <p className="text-slate-500">Loading…</p>
      </main>
    )
  }

  if (!session) {
    return <Login />
  }

  // Authenticated but allowlist status still resolving.
  if (isEditor === null) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-slate-50">
        <p className="text-slate-500">Checking access…</p>
      </main>
    )
  }

  // Logged in but not on public.editors. RLS would return empty everywhere, so
  // say so explicitly rather than showing a blank app.
  if (!isEditor) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-slate-50 px-6">
        <div className="max-w-sm text-center">
          <h1 className="text-xl font-semibold text-slate-900">
            Awaiting access
          </h1>
          <p className="mt-2 text-slate-600">
            You’re signed in as{' '}
            <span className="font-medium">{session.user.email}</span> but not yet
            on the editors allowlist. Ask an admin to add you.
          </p>
          <button
            onClick={() => signOut()}
            className="mt-6 text-sm font-medium text-slate-500 underline hover:text-slate-700"
          >
            Sign out
          </button>
        </div>
      </main>
    )
  }

  return (
    <BrowserRouter>
      <Routes>
        <Route
          element={
            classic ? (
              <Layout email={session.user.email ?? ''} onSwitchUi={NEW_LAYOUT ? switchUi : undefined} />
            ) : (
              <JourneyLayout email={session.user.email ?? ''} onSwitchUi={switchUi} />
            )
          }
        >
          {/* Same pipeline order as the nav bar in Layout.tsx: collect,
              configure, then the stages that read the configuration. The
              same paths serve both layouts, so links and bookmarks keep
              working whichever one is chosen. */}
          <Route index element={<Navigate to="/sources" replace />} />
          <Route path="/sources" element={<Sources />} />
          <Route path="/objective" element={<Objective />} />
          <Route path="/posts" element={classic ? <Posts /> : <RatingJourney />} />
          <Route path="/clusters" element={classic ? <Clusters /> : <TopicsJourney />} />
          <Route path="/review" element={classic ? <Review /> : <ReviewJourney />} />
          <Route path="/export" element={<Export />} />
          <Route path="*" element={<Navigate to="/sources" replace />} />
        </Route>
      </Routes>
    </BrowserRouter>
  )
}

export default App
