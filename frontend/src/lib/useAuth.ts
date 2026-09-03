import { useEffect, useState } from 'react'
import type { Session } from '@supabase/supabase-js'
import { supabase } from './supabase'

export type AuthState = {
  session: Session | null
  // Whether the signed-in user is on the public.editors allowlist. Being
  // authenticated is not enough: RLS gates every table on is_editor(), so a
  // logged-in non-editor sees empty results, not errors. null while unknown.
  isEditor: boolean | null
  // Whether editors.role = 'admin' for this user. Drives which parts of the
  // Sources form the UI offers — the database (0025, is_admin() + a trigger)
  // is the real boundary; this only decides what to show, so a stale or wrong
  // client-side value can never grant an edit the backend would refuse.
  isAdmin: boolean
  loading: boolean
}

export function useAuth() {
  const [session, setSession] = useState<Session | null>(null)
  const [isEditor, setIsEditor] = useState<boolean | null>(null)
  const [isAdmin, setIsAdmin] = useState(false)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session)
      setLoading(false)
    })

    const { data: sub } = supabase.auth.onAuthStateChange((_event, next) => {
      setSession(next)
    })

    return () => sub.subscription.unsubscribe()
  }, [])

  // Resolve allowlist membership whenever the user changes. A single row read
  // of the caller's own editors record: RLS returns it only if is_editor().
  useEffect(() => {
    const userId = session?.user.id
    if (!userId) {
      setIsEditor(null)
      setIsAdmin(false)
      return
    }
    let cancelled = false
    setIsEditor(null)
    supabase
      .from('editors')
      .select('user_id, role')
      .eq('user_id', userId)
      .maybeSingle()
      .then(({ data }) => {
        if (cancelled) return
        setIsEditor(data !== null)
        setIsAdmin(data?.role === 'admin')
      })
    return () => {
      cancelled = true
    }
  }, [session?.user.id])

  function signIn(email: string, password: string) {
    return supabase.auth.signInWithPassword({ email, password })
  }

  function signOut() {
    return supabase.auth.signOut()
  }

  return { session, isEditor, isAdmin, loading, signIn, signOut }
}
