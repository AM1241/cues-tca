import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import { useAuth } from './lib/useAuth'
import { Login } from './components/Login'
import { Layout } from './components/Layout'
import { Posts } from './routes/Posts'
import { Sources } from './routes/Sources'
import { Objective } from './routes/Objective'
import { Clusters } from './routes/Clusters'
import { Review } from './routes/Review'
import { Export } from './routes/Export'
import { Placeholder } from './routes/Placeholder'

function App() {
  const { session, isEditor, loading, signOut } = useAuth()

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
        <Route element={<Layout email={session.user.email ?? ''} />}>
          <Route index element={<Navigate to="/posts" replace />} />
          <Route path="/posts" element={<Posts />} />
          <Route path="/sources" element={<Sources />} />
          <Route path="/objective" element={<Objective />} />
          <Route path="/clusters" element={<Clusters />} />
          <Route path="/generate" element={<Placeholder title="Generate" />} />
          <Route path="/review" element={<Review />} />
          <Route path="/export" element={<Export />} />
          <Route path="*" element={<Navigate to="/posts" replace />} />
        </Route>
      </Routes>
    </BrowserRouter>
  )
}

export default App
