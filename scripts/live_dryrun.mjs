/**
 * First controlled live-provider validation: a single-source dry run.
 *
 * IMPORTANT: dry_run = true STILL CALLS RAPIDAPI AND CONSUMES QUOTA. It skips
 * only the database writes (no raw_posts inserted). This is the real first
 * provider call; it exists to measure provider_requests against the RapidAPI
 * dashboard.
 *
 * Safe by construction: dry_run, lookback_days and the single-source shape are
 * hardcoded below. This script cannot perform a dry_run=false or multi-source
 * call, whatever the environment says.
 *
 * Reads the publishable key from frontend/.env.local. The admin email/password
 * come from the environment (set via secure PowerShell prompts) and are never
 * printed; neither is the access token.
 *
 * Run (PowerShell), from the repo root:
 *
 *   $env:SMOKE_SOURCE_ID   = '1f8022ec-e875-4127-a6da-be3ccbaafc6e'  # European Commission (confirm via SQL)
 *   $env:SMOKE_ADMIN_EMAIL = Read-Host 'admin email'
 *   $env:SMOKE_ADMIN_PASSWORD = [Runtime.InteropServices.Marshal]::PtrToStringAuto(
 *     [Runtime.InteropServices.Marshal]::SecureStringToBSTR((Read-Host 'admin password' -AsSecureString)))
 *   node scripts/live_dryrun.mjs
 *   Remove-Item Env:\SMOKE_ADMIN_PASSWORD, Env:\SMOKE_ADMIN_EMAIL, Env:\SMOKE_SOURCE_ID
 */
import { createClient } from '@supabase/supabase-js'
import { readFileSync } from 'node:fs'

// --- hardcoded, non-overridable call shape ---------------------------------
const DRY_RUN = true
const LOOKBACK_DAYS = 1

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
  const { data: session, error: signInErr } = await anon.auth.signInWithPassword({
    email: EMAIL, password: PASSWORD,
  })
  if (signInErr || !session?.session) {
    console.error('Sign-in failed:', signInErr?.message ?? 'no session')
    process.exit(1)
  }
  const token = session.session.access_token // never printed

  // Confirm the source this call will hit, so there is no doubt which company
  // is about to be fetched.
  const asUser = createClient(PROJECT_URL, ANON, {
    global: { headers: { Authorization: `Bearer ${token}` } },
    auth: { persistSession: false },
  })
  const { data: src, error: srcErr } = await asUser
    .from('sources')
    .select('id, name, rapidapi_identifier, lookback_days, enabled')
    .eq('id', SOURCE_ID)
    .maybeSingle()

  if (srcErr) { console.error('Could not read source (RLS/allowlist?):', srcErr.message); process.exit(1) }
  if (!src) { console.error('Source not found for that id.'); process.exit(1) }

  console.log('About to DRY-RUN (this WILL call RapidAPI, no posts written):')
  console.log(`  source        : ${src.name}`)
  console.log(`  identifier    : ${src.rapidapi_identifier}`)
  console.log(`  enabled       : ${src.enabled}`)
  console.log(`  lookback_days : ${LOOKBACK_DAYS} (override; source default ${src.lookback_days})`)
  console.log('')

  const started = Date.now()
  const res = await fetch(FN, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ source_ids: [SOURCE_ID], lookback_days: LOOKBACK_DAYS, dry_run: DRY_RUN }),
  })
  let body = null
  try { body = await res.json() } catch { /* non-JSON */ }

  console.log(`HTTP ${res.status}  (${Date.now() - started} ms)`)
  console.log(`run_id        : ${body?.run_id ?? '(none)'}`)
  console.log(`status        : ${body?.status ?? '(none)'}`)
  console.log(`dry_run       : ${body?.dry_run}`)
  console.log('')
  console.log('per-source results:')
  for (const r of body?.results ?? []) {
    console.log(`  ${r.name}: status=${r.status} provider_requests=${r.provider_requests} ` +
      `pages_fetched=${r.pages_fetched} posts_fetched=${r.posts_fetched} ` +
      `inserted=${r.posts_inserted} out_of_window=${r.posts_skipped_out_of_window} ` +
      `no_id=${r.posts_skipped_no_id} malformed=${r.posts_skipped_malformed} truncated=${r.truncated}`)
  }
  const t = body?.totals ?? {}
  console.log('')
  console.log('run totals:')
  console.log(`  trigger_source    : ${t.trigger_source}`)
  console.log(`  provider_requests : ${t.provider_requests}`)
  console.log(`  pages_fetched     : ${t.pages_fetched}`)
  console.log(`  posts_fetched     : ${t.posts_fetched}`)
  console.log(`  posts_inserted    : ${t.posts_inserted}  (must be 0 for a dry run)`)
  console.log(`  sources_ok        : ${t.sources_ok}`)
  console.log(`  sources_failed    : ${t.sources_failed}`)
  console.log('')
  console.log(`>>> Record provider_requests = ${t.provider_requests} and compare to the RapidAPI dashboard delta.`)
  console.log(`>>> run_id for the Step 5 SQL: ${body?.run_id}`)
}

main().catch((e) => { console.error('dry-run error:', e); process.exit(1) })
