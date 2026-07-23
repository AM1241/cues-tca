import { createClient } from '@supabase/supabase-js'
import type { Database } from './database.types'

// Only the project URL and the publishable key may reach the browser bundle.
// The secret (service role) key bypasses RLS and lives in `supabase secrets set`.
const url = import.meta.env.VITE_SUPABASE_URL
const publishableKey = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY

if (!url || !publishableKey) {
  throw new Error(
    'Missing VITE_SUPABASE_URL or VITE_SUPABASE_PUBLISHABLE_KEY. Copy frontend/.env.example to frontend/.env.local.',
  )
}

export const supabase = createClient<Database>(url, publishableKey)
