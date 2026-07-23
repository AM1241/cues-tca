/**
 * Cloud authentication smoke tests for the deployed `ingest` function.
 *
 * Proves the auth boundary on the real platform WITHOUT calling RapidAPI: every
 * authenticated request uses an unknown source UUID, so the handler stops at the
 * "Unknown source_ids" 400 — before RAPIDAPI_KEY is used and long before any
 * provider fetch.
 *
 * Nothing here is committed with secrets. It reads them from the environment,
 * which the runner populates via secure prompts. No secret value is printed.
 *
 * Run (PowerShell), from the repo root:
 *
 *   $env:SUPABASE_SERVICE_ROLE_KEY = [Runtime.InteropServices.Marshal]::PtrToStringAuto(
 *     [Runtime.InteropServices.Marshal]::SecureStringToBSTR((Read-Host 'service role key' -AsSecureString)))
 *   $env:INGEST_INTERNAL_SECRET = [Runtime.InteropServices.Marshal]::PtrToStringAuto(
 *     [Runtime.InteropServices.Marshal]::SecureStringToBSTR((Read-Host 'internal secret' -AsSecureString)))
 *   node scripts/cloud_smoke.mjs
 *   Remove-Item Env:\SUPABASE_SERVICE_ROLE_KEY, Env:\INGEST_INTERNAL_SECRET
 *
 * The publishable (anon) key is read from frontend/.env.local, or SUPABASE_ANON_KEY.
 */
import { createClient } from '@supabase/supabase-js'
import { readFileSync } from 'node:fs'

const UNKNOWN_UUID = '99999999-9999-4999-8999-999999999999'

const PROJECT_URL = process.env.SUPABASE_URL ?? 'https://bxaovkzemfyxrxbcqask.supabase.co'
const FN = `${PROJECT_URL}/functions/v1/ingest`
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY
const SECRET = process.env.INGEST_INTERNAL_SECRET

let ANON = process.env.SUPABASE_ANON_KEY
if (!ANON) {
  try {
    const env = readFileSync(new URL('../frontend/.env.local', import.meta.url), 'utf8')
    ANON = env.match(/VITE_SUPABASE_PUBLISHABLE_KEY=(.+)/)?.[1]?.trim()
  } catch { /* fall through to the check below */ }
}

if (!SERVICE || !SECRET || !ANON) {
  console.error('Required: SUPABASE_SERVICE_ROLE_KEY, INGEST_INTERNAL_SECRET (env), and a publishable key.')
  process.exit(2)
}

// Guard against the exact mistake the design forbids.
if (SECRET === SERVICE) {
  console.error('INGEST_INTERNAL_SECRET must not equal the service-role key.')
  process.exit(2)
}

const db = createClient(PROJECT_URL, SERVICE, { auth: { persistSession: false } })

let passed = 0, failed = 0
const lines = []
const check = (name, cond, detail = '') => {
  if (cond) { passed++; lines.push(`  ok   ${name}`) }
  else { failed++; lines.push(`  FAIL ${name}${detail ? ' :: ' + detail : ''}`) }
}

const stamp = Date.now()
const PW = `cloud-smoke-${stamp}!Aa`
const emails = {
  admin: `smoke.admin.${stamp}@cues.test`,
  editor: `smoke.editor.${stamp}@cues.test`,
}
const created = []

async function makeUser(email, role) {
  const { data, error } = await db.auth.admin.createUser({ email, password: PW, email_confirm: true })
  if (error) throw error
  created.push(data.user.id)
  if (role) {
    const { error: e2 } = await db.from('editors').insert({ user_id: data.user.id, email, role })
    if (e2) throw e2
  }
  const anon = createClient(PROJECT_URL, ANON, { auth: { persistSession: false } })
  const { data: s, error: e3 } = await anon.auth.signInWithPassword({ email, password: PW })
  if (e3) throw e3
  return s.session.access_token
}

async function call(headers, body) {
  const res = await fetch(FN, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body ?? {}),
  })
  let json = null
  try { json = await res.json() } catch { /* non-JSON body */ }
  return { status: res.status, json }
}

const counts = async () => {
  const one = async (t) => (await db.from(t).select('*', { count: 'exact', head: true })).count ?? 0
  return {
    ingest_runs: await one('ingest_runs'),
    ingest_run_sources: await one('ingest_run_sources'),
    raw_post_content_changes: await one('raw_post_content_changes'),
    raw_posts: await one('raw_posts'),
  }
}

async function main() {
  const before = await counts()
  const body = { source_ids: [UNKNOWN_UUID] }

  const adminToken = await makeUser(emails.admin, 'admin')
  const editorToken = await makeUser(emails.editor, 'editor')

  // 1. no credentials
  let r = await call({}, body)
  check('1. no credentials -> rejected', r.status === 401, `status ${r.status}`)

  // 2. malformed bearer
  r = await call({ Authorization: 'Bearer not.a.valid.jwt' }, body)
  check('2. malformed user token -> rejected', r.status === 401, `status ${r.status}`)

  // 3. non-admin editor
  r = await call({ Authorization: `Bearer ${editorToken}` }, body)
  check('3. non-admin editor -> 403', r.status === 403, `status ${r.status}`)

  // 4. admin + unknown source -> reaches handler, 400
  r = await call({ Authorization: `Bearer ${adminToken}` }, body)
  check('4. admin + unknown UUID -> 400', r.status === 400, `status ${r.status}`)
  check('4. body says Unknown source_ids', /unknown source_ids/i.test(r.json?.error ?? ''), r.json?.error)

  // 5. invalid internal secret
  r = await call({ apikey: 'definitely-not-the-secret' }, body)
  check('5. invalid internal secret -> rejected', r.status === 401, `status ${r.status}`)

  // 6. valid internal secret + unknown source -> reaches handler, 400
  r = await call({ apikey: SECRET }, body)
  check('6. internal secret + unknown UUID -> 400', r.status === 400, `status ${r.status}`)
  check('6. body says Unknown source_ids', /unknown source_ids/i.test(r.json?.error ?? ''), r.json?.error)

  // 7. nothing was created, provider never touched
  const after = await counts()
  check('7. ingest_runs unchanged (0)', after.ingest_runs === before.ingest_runs && after.ingest_runs === 0,
    `${before.ingest_runs} -> ${after.ingest_runs}`)
  check('7. ingest_run_sources unchanged (0)', after.ingest_run_sources === 0, `${after.ingest_run_sources}`)
  check('7. raw_post_content_changes unchanged (0)', after.raw_post_content_changes === 0, `${after.raw_post_content_changes}`)
  check('7. raw_posts still 133', after.raw_posts === 133, `${after.raw_posts}`)

  console.log(lines.join('\n'))
  console.log(`\n${passed} passed, ${failed} failed`)
}

async function cleanup() {
  for (const id of created) {
    try { await db.auth.admin.deleteUser(id) } catch { /* editors row cascades */ }
  }
}

main()
  .catch((e) => { console.error('smoke error:', e); failed++ })
  .finally(async () => {
    await cleanup()
    console.log('(ephemeral test users deleted)')
    process.exit(failed === 0 ? 0 : 1)
  })
