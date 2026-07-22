/**
 * Gateway tests: drive the REAL function through the local Edge Runtime.
 *
 *   npx supabase functions serve ingest --env-file supabase/functions/.env.test
 *   node scripts/verify_gateway.mjs
 *
 * The handler tests call handleIngest() directly and therefore prove nothing
 * about the platform gateway — which is exactly where `verify_jwt` would have
 * rejected the opaque internal secret before our code ran. These tests cross
 * that boundary over real HTTP.
 *
 * NO PROVIDER CALLS. Every accepted request targets a source with no
 * rapidapi_identifier (or a disabled one), so the run completes with skips and
 * zero outbound HTTP. RAPIDAPI_KEY is a dummy in the serve env, so a real call
 * would fail loudly rather than silently succeed.
 */
import { createClient } from '@supabase/supabase-js'

const FN = process.env.FUNCTION_URL ?? 'http://127.0.0.1:54321/functions/v1/ingest'
const URL_ = process.env.SUPABASE_URL ?? 'http://127.0.0.1:54321'
const ANON = process.env.SUPABASE_ANON_KEY
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY
const SECRET = process.env.INGEST_INTERNAL_SECRET

if (!ANON || !SERVICE || !SECRET) {
  console.error('SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY and INGEST_INTERNAL_SECRET are required')
  process.exit(2)
}

const db = createClient(URL_, SERVICE, { auth: { persistSession: false } })
const stamp = Date.now()
const PW = 'gateway-test-pw-123!'
const emails = {
  admin: `gw.admin.${stamp}@cues.test`,
  editor: `gw.editor.${stamp}@cues.test`,
  outsider: `gw.outsider.${stamp}@cues.test`,
}

let passed = 0
let failed = 0
const results = []

function check(name, cond, detail = '') {
  if (cond) { passed++; results.push(`  ok   ${name}`) }
  else { failed++; results.push(`  FAIL ${name}${detail ? ' :: ' + detail : ''}`) }
}

async function makeUser(email, role) {
  const { data, error } = await db.auth.admin.createUser({ email, password: PW, email_confirm: true })
  if (error) throw error
  if (role) {
    const { error: e2 } = await db.from('editors').insert({ user_id: data.user.id, email, role })
    if (e2) throw e2
  }
  const anon = createClient(URL_, ANON, { auth: { persistSession: false } })
  const { data: s, error: e3 } = await anon.auth.signInWithPassword({ email, password: PW })
  if (e3) throw e3
  return { id: data.user.id, token: s.session.access_token }
}

async function call(headers, body) {
  const res = await fetch(FN, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body ?? {}),
  })
  let json = null
  try { json = await res.json() } catch { /* non-JSON error page */ }
  return { status: res.status, json }
}

const runCount = async () => {
  const { count } = await db.from('ingest_runs').select('*', { count: 'exact', head: true })
  return count ?? 0
}

async function main() {
  // --- fixtures ---------------------------------------------------------
  const admin = await makeUser(emails.admin, 'admin')
  const editor = await makeUser(emails.editor, 'editor')
  const outsider = await makeUser(emails.outsider, null)

  const { data: src, error: srcErr } = await db
    .from('sources')
    .insert({
      name: `GW-noident-${stamp}`,
      source_type: 'linkedin',
      url: 'https://example.test',
      enabled: true,
      rapidapi_identifier: null, // guarantees zero provider calls
    })
    .select('id').single()
  if (srcErr) throw srcErr
  const sourceId = src.id

  const body = { source_ids: [sourceId] }

  // --- 1. no credentials -------------------------------------------------
  let before = await runCount()
  let r = await call({}, body)
  check('no credentials rejected', r.status === 401, `got ${r.status}`)
  check('no credentials creates no run row', (await runCount()) === before)

  // --- 2. valid admin JWT ------------------------------------------------
  r = await call({ Authorization: `Bearer ${admin.token}` }, body)
  check('valid admin user JWT accepted', r.status === 200, `got ${r.status} ${JSON.stringify(r.json)?.slice(0, 200)}`)
  check('admin run attributed as manual', r.json?.totals?.trigger_source === 'manual')
  check('admin run records the actor email', r.json?.totals?.triggered_by_email === emails.admin)
  check('no provider request was made', r.json?.totals?.provider_requests === 0)

  // --- 3. non-admin editor ----------------------------------------------
  before = await runCount()
  r = await call({ Authorization: `Bearer ${editor.token}` }, body)
  check('non-admin editor rejected', r.status === 403, `got ${r.status}`)
  check('non-admin editor creates no run row', (await runCount()) === before)

  // --- 4. non-editor -----------------------------------------------------
  before = await runCount()
  r = await call({ Authorization: `Bearer ${outsider.token}` }, body)
  check('non-editor rejected', r.status === 403, `got ${r.status}`)
  check('non-editor creates no run row', (await runCount()) === before)

  // --- 5. invalid / expired user JWT ------------------------------------
  before = await runCount()
  r = await call({ Authorization: 'Bearer not.a.real.token' }, body)
  check('malformed JWT rejected', r.status === 401, `got ${r.status}`)
  // A structurally valid but expired token (exp in the past, bogus signature).
  const expired = [
    btoa(JSON.stringify({ alg: 'HS256', typ: 'JWT' })),
    btoa(JSON.stringify({ sub: admin.id, role: 'authenticated', exp: 1000000000 })),
    'bogussignature',
  ].join('.').replace(/=/g, '')
  r = await call({ Authorization: `Bearer ${expired}` }, body)
  check('expired/forged JWT rejected', r.status === 401, `got ${r.status}`)
  check('invalid JWTs create no run rows', (await runCount()) === before)

  // --- 6. internal secret ------------------------------------------------
  r = await call({ apikey: SECRET }, body)
  check('valid internal secret accepted', r.status === 200, `got ${r.status} ${JSON.stringify(r.json)?.slice(0, 200)}`)
  check('internal run attributed as cron', r.json?.totals?.trigger_source === 'cron')
  check('internal run has no user', r.json?.totals?.triggered_by === null)

  before = await runCount()
  r = await call({ apikey: 'wrong-secret-entirely' }, body)
  check('invalid internal secret rejected', r.status === 401, `got ${r.status}`)
  check('invalid internal secret creates no run row', (await runCount()) === before)

  // The service-role key must not work as a caller credential.
  before = await runCount()
  r = await call({ apikey: SERVICE }, body)
  check('service-role key rejected as apikey', r.status === 401, `got ${r.status}`)
  r = await call({ Authorization: `Bearer ${SERVICE}` }, body)
  check('service-role key rejected as bearer', r.status === 401, `got ${r.status}`)
  check('service-role key creates no run row', (await runCount()) === before)

  // --- 7. trigger_source is not caller-controlled ------------------------
  r = await call({ Authorization: `Bearer ${admin.token}` }, { ...body, trigger_source: 'cron' })
  check('browser-supplied trigger_source ignored', r.json?.totals?.trigger_source === 'manual',
    `got ${r.json?.totals?.trigger_source}`)

  // --- 8. nothing reached the provider ----------------------------------
  const { data: runs } = await db
    .from('ingest_run_sources').select('provider_requests, error_code').eq('source_id', sourceId)
  const totalRequests = (runs ?? []).reduce((a, x) => a + (x.provider_requests ?? 0), 0)
  check('zero provider requests across every gateway run', totalRequests === 0, `got ${totalRequests}`)
  check('all gateway runs skipped for no_rapidapi_identifier',
    (runs ?? []).every((x) => x.error_code === 'no_rapidapi_identifier'))

  // --- cleanup ------------------------------------------------------------
  await db.from('ingest_run_sources').delete().eq('source_id', sourceId)
  await db.from('sources').delete().eq('id', sourceId)
  for (const u of [admin, editor, outsider]) await db.auth.admin.deleteUser(u.id)

  console.log(results.join('\n'))
  console.log(`\n${passed} passed, ${failed} failed`)
  process.exit(failed === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error('gateway verification error:', e)
  process.exit(2)
})
