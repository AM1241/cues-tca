/**
 * First controlled REAL ingest: dry_run = false, single source, lookback 1.
 *
 * This WRITES to raw_posts. It is deliberately awkward to trigger:
 *   - dry_run is hardcoded false, source and lookback are hardcoded single/1;
 *   - it refuses to run unless REALRUN_CONFIRM === 'INSERT-FOR-REAL';
 *   - it prints, before calling, exactly which source it will insert into.
 *
 * It calls RapidAPI (consuming quota, like any real run) and inserts the
 * in-window posts for one source. It does NOT enable cron or touch other
 * sources.
 *
 * Run (PowerShell), from the repo root:
 *
 *   $env:SMOKE_SOURCE_ID   = '1f8022ec-e875-4127-a6da-be3ccbaafc6e'  # European Commission
 *   $env:REALRUN_CONFIRM   = 'INSERT-FOR-REAL'
 *   $env:SMOKE_ADMIN_EMAIL = Read-Host 'admin email'
 *   $env:SMOKE_ADMIN_PASSWORD = [Runtime.InteropServices.Marshal]::PtrToStringAuto(
 *     [Runtime.InteropServices.Marshal]::SecureStringToBSTR((Read-Host 'admin password' -AsSecureString)))
 *   node scripts/live_realrun.mjs
 *   Remove-Item Env:\SMOKE_ADMIN_PASSWORD, Env:\SMOKE_ADMIN_EMAIL, Env:\SMOKE_SOURCE_ID, Env:\REALRUN_CONFIRM
 */
import { createClient } from '@supabase/supabase-js'
import { readFileSync } from 'node:fs'

// --- hardcoded, non-overridable call shape ---------------------------------
const DRY_RUN = false
const LOOKBACK_DAYS = 1

if (process.env.REALRUN_CONFIRM !== 'INSERT-FOR-REAL') {
  console.error('Refusing to run: set REALRUN_CONFIRM=INSERT-FOR-REAL to confirm a real insert.')
  process.exit(2)
}

const PROJECT_URL = process.env.SUPABASE_URL ?? 'https://bxaovkzemfyxrxbcqask.supabase.co'
const FN = `${PROJECT_URL}/functions/v1/ingest`
const SOURCE_ID = process.env.SMOKE_SOURCE_ID
const EMAIL = process.env.SMOKE_ADMIN_EMAIL
const PASSWORD = process.env.SMOKE_ADMIN_PASSWORD

let ANON = process.env.SUPABASE_ANON_KEY
if (!ANON) {
  try {
    const env = readFileSync(new URL('../frontend/.env.local', import.meta.url), 'utf8')
    ANON = env.match(/VITE_SUPABASE_PUBLISHABLE_KEY=(.+)/)?.[1]?.trim()
  } catch { /* checked below */ }
}

if (!SOURCE_ID || !EMAIL || !PASSWORD || !ANON) {
  console.error('Required: SMOKE_SOURCE_ID, SMOKE_ADMIN_EMAIL, SMOKE_ADMIN_PASSWORD (env), and a publishable key.')
  process.exit(2)
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
if (!UUID_RE.test(SOURCE_ID)) {
  console.error(`SMOKE_SOURCE_ID is not a uuid: ${SOURCE_ID}`)
  process.exit(2)
}

async function main() {
  const anon = createClient(PROJECT_URL, ANON, { auth: { persistSession: false } })
  const { data: session, error: signInErr } = await anon.auth.signInWithPassword({ email: EMAIL, password: PASSWORD })
  if (signInErr || !session?.session) {
    console.error('Sign-in failed:', signInErr?.message ?? 'no session')
    process.exit(1)
  }
  const token = session.session.access_token // never printed

  const asUser = createClient(PROJECT_URL, ANON, {
    global: { headers: { Authorization: `Bearer ${token}` } },
    auth: { persistSession: false },
  })
  const { data: src, error: srcErr } = await asUser
    .from('sources')
    .select('id, name, rapidapi_identifier, lookback_days, enabled')
    .eq('id', SOURCE_ID)
    .maybeSingle()
  if (srcErr) { console.error('Could not read source:', srcErr.message); process.exit(1) }
  if (!src) { console.error('Source not found for that id.'); process.exit(1) }

  console.log('*** REAL RUN — dry_run=false — this WILL insert posts ***')
  console.log(`  source        : ${src.name}`)
  console.log(`  identifier    : ${src.rapidapi_identifier}`)
  console.log(`  enabled       : ${src.enabled}`)
  console.log(`  lookback_days : ${LOOKBACK_DAYS}`)
  console.log('')

  const started = Date.now()
  const res = await fetch(FN, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ source_ids: [SOURCE_ID], lookback_days: LOOKBACK_DAYS, dry_run: DRY_RUN }),
  })
  let body = null
  try { body = await res.json() } catch { /* non-JSON */ }

  const t = body?.totals ?? {}
  console.log(`HTTP ${res.status}  (${Date.now() - started} ms)`)
  console.log(`run_id            : ${body?.run_id}`)
  console.log(`status            : ${body?.status}`)
  console.log(`dry_run           : ${body?.dry_run}`)
  console.log(`provider_requests : ${t.provider_requests}`)
  console.log(`pages_fetched     : ${t.pages_fetched}`)
  console.log(`posts_fetched     : ${t.posts_fetched}`)
  console.log(`out_of_window     : ${t.posts_skipped_out_of_window}`)
  console.log(`posts_inserted    : ${t.posts_inserted}`)
  console.log(`metadata_refreshed: ${t.posts_metadata_refreshed}`)
  console.log(`content_changed   : ${t.posts_content_changed}`)
  console.log('')
  console.log(`>>> run_id for verification SQL: ${body?.run_id}`)
  console.log(`>>> record provider_requests = ${t.provider_requests} vs the RapidAPI dashboard delta`)
}

main().catch((e) => { console.error('real-run error:', e); process.exit(1) })
