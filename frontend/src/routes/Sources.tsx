import { useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'
import { useAuth } from '../lib/useAuth'
import { useToast } from '../components/toast-context'
import { Spinner, ErrorNotice } from '../components/ui'
import type { Database } from '../lib/database.types'

type Source = Database['public']['Tables']['sources']['Row']

// A name discover-brands proposes as identifying this source's company. It is a
// question put to the operator, not a change: nothing reaches the anonymiser
// until accept_brand_suggestion writes it into company_aliases. See 0020.
type BrandSuggestion = {
  id: string
  name: string
  rationale: string | null
  status: string
}

// Editors may insert and update sources, but not delete them: RLS in 0002 grants
// no DELETE. Retiring a source is `enabled = false`, which is what the toggle does.
//
// Adding a source, and changing name/url/type/collectionAddress/company_name,
// is admin-only as of 0025 — enforced in the database (is_admin() + a trigger),
// not just here. lookback_days and the enabled toggle stay open to every
// editor, which is why toggleEnabled() below is untouched by any of this.
//
// `collectionAddress` is the one field that used to be labelled "RapidAPI
// identifier": the exact address the collector reads from. It is left blank
// here whenever it already matches the URL above — which is true for 3 of the
// 5 real sources — so the common case is one visible field, not two. The two
// that genuinely need to diverge (MASAF's URL points at its posts feed for a
// human to click; the collector needs the bare company page) keep working by
// filling this in, still without ever naming the vendor behind it.
type FormState = {
  name: string
  url: string
  source_type: string
  company_name: string
  collectionAddress: string
  lookback_days: number
}

const emptyForm: FormState = {
  name: '',
  url: '',
  source_type: 'linkedin',
  company_name: '',
  collectionAddress: '',
  lookback_days: 30,
}

type CollectResult = {
  source_id: string
  name: string
  status: string
  error_code?: string
  posts_fetched?: number
  posts_inserted?: number
  posts_skipped_duplicate?: number
  posts_skipped_out_of_window?: number
}

// Turn one source's ingest result into a short human line for the toast.
//
// posts_skipped_out_of_window is the number that used to be silently dropped
// here — a source with 0 new posts looked identical whether nothing had been
// published or everything found had simply fallen outside the lookback
// window, and only the second case is answered by widening it.
function summariseResult(r: CollectResult): string {
  if (r.status === 'skipped') return `${r.name}: skipped (${r.error_code ?? 'skipped'})`
  const inserted = r.posts_inserted ?? 0
  const dupes = r.posts_skipped_duplicate ?? 0
  const outOfWindow = r.posts_skipped_out_of_window ?? 0
  const bits = [`${inserted} new`]
  if (dupes) bits.push(`${dupes} duplicate${dupes === 1 ? '' : 's'}`)
  if (outOfWindow) bits.push(`${outOfWindow} outside your lookback window`)
  return `${r.name}: ${bits.join(', ')}`
}

export function Sources() {
  const toast = useToast()
  const { isAdmin } = useAuth()
  const [sources, setSources] = useState<Source[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [editing, setEditing] = useState<Source | 'new' | null>(null)
  // Which source id is collecting, or 'all' for the header run, or null.
  const [collecting, setCollecting] = useState<string | 'all' | null>(null)
  // Brand discovery: which source is running, and the pending proposals to
  // review. Proposals change nothing until accepted — see 0020.
  const [discovering, setDiscovering] = useState<string | null>(null)
  const [suggestions, setSuggestions] = useState<BrandSuggestion[] | null>(null)
  const [reviewingSource, setReviewingSource] = useState<Source | null>(null)
  // Permanent deletion (0026), admin-only: which source the confirm dialog is
  // open for. DeleteSourceDialog owns the RPC call and its own loading state.
  const [deleting, setDeleting] = useState<Source | null>(null)

  async function load() {
    const { data, error } = await supabase
      .from('sources')
      .select('*')
      .order('name')
    if (error) setError(error.message)
    else setSources(data)
  }

  useEffect(() => {
    load()
  }, [])

  async function loadSuggestions(source: Source) {
    const { data, error } = await supabase
      .from('brand_suggestions')
      .select('id, name, rationale, status')
      .eq('source_id', source.id)
      .eq('status', 'pending')
      .order('created_at')
    if (error) return toast.error(error.message)
    setSuggestions((data ?? []) as BrandSuggestion[])
    setReviewingSource(source)
  }

  // Ask the model which names in this source's own posts identify its company.
  // The anonymiser can only derive forms of the source LABEL, and the entity
  // extractor is told to skip "the source's own name" — so product brands like
  // Carpano fall between the two stages. Everything returned is a proposal.
  async function discover(source: Source) {
    if (discovering) return
    setDiscovering(source.id)
    const { data: sessionData } = await supabase.auth.getSession()
    const token = sessionData.session?.access_token
    const { data, error } = await supabase.functions.invoke('discover-brands', {
      body: { source_id: source.id },
      headers: token ? { Authorization: `Bearer ${token}` } : undefined,
    })
    setDiscovering(null)

    if (error) return toast.error(error.message)
    if (data?.ok === false) return toast.error(data.error ?? 'Discovery failed')

    const t = data?.totals
    if (!t?.read) {
      return toast.success('No collected posts for this source yet.')
    }
    await loadSuggestions(source)
    toast.success(
      t.stored > 0
        ? `${t.stored} name(s) to review from ${t.read} post(s)`
        : `Nothing new from ${t.read} post(s) — everything found is already decided.`,
    )
  }

  async function decide(s: BrandSuggestion, accept: boolean) {
    const { error } = await supabase.rpc(
      accept ? 'accept_brand_suggestion' : 'reject_brand_suggestion',
      { p_id: s.id },
    )
    if (error) return toast.error(error.message)
    setSuggestions((prev) => (prev ?? []).filter((x) => x.id !== s.id))
    toast.success(
      accept ? `"${s.name}" will now be anonymised` : `"${s.name}" will not be proposed again`,
    )
  }

  // Invoke the deployed `ingest` Edge Function. Omitting source_ids collects
  // every enabled source; the function honours `enabled` server-side and
  // returns a per-source breakdown. Auth is the logged-in editor's JWT.
  async function collect(target: Source | 'all') {
    if (collecting) return
    setCollecting(target === 'all' ? 'all' : target.id)
    const body = target === 'all' ? {} : { source_ids: [target.id] }
    const { data, error } = await supabase.functions.invoke('ingest', { body })
    setCollecting(null)

    if (error) {
      toast.error(error.message)
      return
    }
    const results: CollectResult[] = (data?.results as CollectResult[]) ?? []
    if (results.length === 0) {
      toast.error('Ingest returned no results.')
    } else if (results.length === 1) {
      toast.success(summariseResult(results[0]))
    } else {
      const total = results.reduce((n, r) => n + (r.posts_inserted ?? 0), 0)
      toast.success(`Collected ${results.length} sources — ${total} new posts`)
    }
    // Refresh so last_fetched_at (and disabled-skip behaviour) show through.
    load()
  }

  async function toggleEnabled(s: Source) {
    // Optimistic: flip locally, revert on failure.
    setSources((prev) =>
      prev?.map((x) => (x.id === s.id ? { ...x, enabled: !x.enabled } : x)) ??
      prev,
    )
    const { error } = await supabase
      .from('sources')
      .update({ enabled: !s.enabled })
      .eq('id', s.id)
    if (error) {
      toast.error(error.message)
      load()
    } else {
      toast.success(`${s.name} ${s.enabled ? 'disabled' : 'enabled'}`)
    }
  }

  if (error) return <ErrorNotice message={error} />

  if (!sources) return <Spinner label="Loading sources…" />

  return (
    <div>
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold">Sources</h1>
          <p className="mt-1 text-sm text-slate-500">
            {sources.filter((s) => s.enabled).length} of {sources.length} enabled
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => collect('all')}
            disabled={collecting !== null || sources.every((s) => !s.enabled)}
            className="rounded-md border border-slate-300 px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50"
          >
            {collecting === 'all' ? 'Collecting…' : 'Collect all enabled'}
          </button>
          {/* Adding a source is admin-only (0025) — the database refuses a
              non-admin's insert regardless, but there is no reason to offer a
              button that always fails. */}
          {isAdmin && (
            <button
              onClick={() => setEditing('new')}
              className="rounded-md bg-slate-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-slate-800"
            >
              Add source
            </button>
          )}
        </div>
      </div>

      <div className="overflow-x-auto rounded-lg border border-slate-200 bg-white">
        <table className="w-full text-sm">
          <thead className="border-b border-slate-200 bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
            <tr>
              <th className="px-4 py-3 font-medium">Name</th>
              <th className="px-4 py-3 font-medium">Type</th>
              <th className="px-4 py-3 font-medium">Lookback</th>
              <th className="px-4 py-3 font-medium">Last fetched</th>
              <th className="px-4 py-3 font-medium">Enabled</th>
              <th className="px-4 py-3" />
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {sources.map((s) => (
              <tr key={s.id} className={s.enabled ? '' : 'opacity-60'}>
                <td className="px-4 py-3">
                  <div className="font-medium text-slate-900">{s.name}</div>
                  {s.url && (
                    <a
                      href={s.url}
                      target="_blank"
                      rel="noreferrer"
                      className="text-xs text-slate-500 hover:underline"
                    >
                      {s.url}
                    </a>
                  )}
                  {/* The divergence itself (MASAF, Fratelli Branca) is still
                      visible and editable in the Edit popup's "Collect from a
                      different address" field — just not surfaced on this
                      list, on the operator's call: the list stays as simple
                      as the common case, and the two sources that need it
                      still show it exactly where an admin would go to change
                      it. */}
                </td>
                <td className="px-4 py-3 text-slate-600">{s.source_type}</td>
                <td className="px-4 py-3 tabular-nums text-slate-600">
                  {s.lookback_days}d
                </td>
                <td className="px-4 py-3 text-slate-600">
                  {s.last_fetched_at
                    ? new Date(s.last_fetched_at).toLocaleString()
                    : 'never'}
                </td>
                <td className="px-4 py-3">
                  <button
                    onClick={() => toggleEnabled(s)}
                    role="switch"
                    aria-checked={s.enabled}
                    className={`relative inline-flex h-5 w-9 items-center rounded-full transition ${
                      s.enabled ? 'bg-emerald-500' : 'bg-slate-300'
                    }`}
                  >
                    <span
                      className={`inline-block h-4 w-4 transform rounded-full bg-white transition ${
                        s.enabled ? 'translate-x-4' : 'translate-x-1'
                      }`}
                    />
                  </button>
                </td>
                <td className="px-4 py-3 text-right">
                  <div className="flex items-center justify-end gap-3">
                    <button
                      onClick={() => collect(s)}
                      disabled={collecting !== null || !s.enabled}
                      title={s.enabled ? 'Collect posts now' : 'Enable the source to collect'}
                      className="text-sm font-medium text-slate-500 hover:text-slate-900 disabled:opacity-40"
                    >
                      {collecting === s.id ? 'Collecting…' : 'Collect'}
                    </button>
                    <button
                      onClick={() => discover(s)}
                      disabled={discovering !== null}
                      title="Read this source's posts and propose the brand names that identify it"
                      className="text-sm font-medium text-slate-500 hover:text-slate-900 disabled:opacity-40"
                    >
                      {discovering === s.id ? 'Reading…' : 'Find names'}
                    </button>
                    <button
                      onClick={() => setEditing(s)}
                      className="text-sm font-medium text-slate-500 hover:text-slate-900"
                    >
                      {isAdmin ? 'Edit' : 'Change lookback'}
                    </button>
                    {/* Permanent deletion (0026) is admin-only, same as
                        creating a source — the RPC enforces this regardless,
                        but there is no reason to offer a button that always
                        fails. */}
                    {isAdmin && (
                      <button
                        onClick={() => setDeleting(s)}
                        className="text-sm font-medium text-red-600 hover:text-red-800"
                      >
                        Delete
                      </button>
                    )}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {reviewingSource && suggestions && (
        <div className="mt-6 rounded-lg border border-slate-200 bg-white p-5">
          <div className="flex items-start justify-between gap-4">
            <div>
              <h2 className="font-semibold">
                Names found in {reviewingSource.name}
              </h2>
              <p className="mt-0.5 text-sm text-slate-500">
                Accepting a name anonymises it everywhere, in post text and in
                hashtags. Rejecting keeps it from being proposed again.
              </p>
            </div>
            <button
              onClick={() => {
                setReviewingSource(null)
                setSuggestions(null)
              }}
              className="shrink-0 text-sm font-medium text-slate-500 hover:text-slate-900"
            >
              Close
            </button>
          </div>

          {suggestions.length === 0 ? (
            <p className="mt-4 text-sm text-slate-400">
              Nothing waiting for a decision on this source.
            </p>
          ) : (
            <ul className="mt-4 space-y-2">
              {suggestions.map((s) => (
                <li
                  key={s.id}
                  className="flex items-start justify-between gap-4 rounded-md border border-slate-200 p-3"
                >
                  <div className="min-w-0">
                    <p className="font-medium text-slate-900">{s.name}</p>
                    {s.rationale && (
                      <p className="mt-0.5 text-sm text-slate-500">{s.rationale}</p>
                    )}
                  </div>
                  <div className="flex shrink-0 gap-2">
                    <button
                      onClick={() => decide(s, true)}
                      className="rounded-md bg-emerald-600 px-3 py-1 text-sm font-medium text-white hover:bg-emerald-700"
                    >
                      Accept
                    </button>
                    <button
                      onClick={() => decide(s, false)}
                      className="rounded-md border border-slate-300 px-3 py-1 text-sm font-medium text-slate-600 hover:bg-slate-100"
                    >
                      Reject
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          )}

          <p className="mt-4 text-xs text-slate-400">
            Watch for product categories — “vermouth”, “pasta”. Those describe
            what is sold, not who sells it, and anonymising one would strip the
            meaning out of every post that mentions it.
          </p>
        </div>
      )}

      {editing && (
        <SourceForm
          source={editing === 'new' ? null : editing}
          isAdmin={isAdmin}
          onClose={() => setEditing(null)}
          onSaved={(created) => {
            setEditing(null)
            toast.success(created ? 'Source created' : 'Source updated')
            load()
          }}
        />
      )}

      {deleting && (
        <DeleteSourceDialog
          source={deleting}
          onClose={() => setDeleting(null)}
          onDeleted={(counts) => {
            setDeleting(null)
            toast.success(
              `Deleted "${deleting.name}" — ${counts.raw_posts ?? 0} post(s) and everything derived from them`,
            )
            load()
          }}
        />
      )}
    </div>
  )
}

/**
 * The confirmation step for purge_source() (0026). A blocked attempt — the
 * source's posts are cited in generated copy — is not a quick mistake to
 * retry, so its message stays in the dialog, in full, rather than as a toast
 * that vanishes before an admin can read which results are affected.
 */
function DeleteSourceDialog({
  source,
  onClose,
  onDeleted,
}: {
  source: Source
  onClose: () => void
  onDeleted: (counts: Record<string, unknown>) => void
}) {
  const [purging, setPurging] = useState(false)
  const [blocked, setBlocked] = useState<string | null>(null)

  async function confirmDelete() {
    setPurging(true)
    setBlocked(null)
    const { data, error } = await supabase.rpc('purge_source', { p_source_id: source.id })
    setPurging(false)
    if (error) {
      setBlocked(error.message)
      return
    }
    onDeleted(data as Record<string, unknown>)
  }

  return (
    <div
      className="fixed inset-0 z-10 flex items-center justify-center bg-slate-900/40 px-6"
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-lg rounded-lg bg-white p-6 shadow-xl"
      >
        <h2 className="text-lg font-semibold text-red-700">Delete "{source.name}"?</h2>
        <p className="mt-3 text-sm text-slate-600">
          This permanently removes every post collected from this source, and
          everything derived from them — scores, anonymised text, embeddings,
          cluster assignments. <span className="font-medium">This cannot be undone.</span>
        </p>
        <p className="mt-3 text-sm text-slate-600">
          To only stop collecting from it while keeping its history, use the
          enabled switch instead — Cancel below and toggle it in the list.
        </p>

        {blocked && (
          <div className="mt-4 max-h-64 overflow-y-auto rounded-md bg-red-50 p-3 text-xs text-red-800">
            <p className="mb-1 font-medium">Can't delete — some of its posts are already in generated copy:</p>
            <pre className="whitespace-pre-wrap break-words font-mono">{blocked}</pre>
          </div>
        )}

        <div className="mt-6 flex justify-end gap-3">
          <button
            type="button"
            onClick={onClose}
            className="rounded-md px-4 py-2 text-sm font-medium text-slate-600 hover:bg-slate-100"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={confirmDelete}
            disabled={purging}
            className="rounded-md bg-red-600 px-4 py-2 text-sm font-medium text-white hover:bg-red-700 disabled:opacity-60"
          >
            {purging ? 'Deleting…' : 'Delete permanently'}
          </button>
        </div>
      </div>
    </div>
  )
}

function SourceForm({
  source,
  isAdmin,
  onClose,
  onSaved,
}: {
  source: Source | null
  isAdmin: boolean
  onClose: () => void
  onSaved: (created: boolean) => void
}) {
  const [form, setForm] = useState<FormState>(
    source
      ? {
          name: source.name,
          url: source.url,
          source_type: source.source_type,
          company_name: source.company_name ?? '',
          // Left blank whenever it already matches the URL — true for 3 of
          // the 5 real sources — so the common case shows an empty advanced
          // field, not a second copy of the same address.
          collectionAddress:
            source.rapidapi_identifier && source.rapidapi_identifier !== source.url
              ? source.rapidapi_identifier
              : '',
          lookback_days: source.lookback_days,
        }
      : emptyForm,
  )
  // Expanded by default only when editing a source that already has an
  // override (MASAF, Fratelli Branca today) — otherwise collapsed, since
  // nearly every source never needs it.
  const [showAdvanced, setShowAdvanced] = useState(() => form.collectionAddress !== '')
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  function set<K extends keyof FormState>(key: K, value: FormState[K]) {
    setForm((f) => ({ ...f, [key]: value }))
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setSaving(true)
    setErr(null)

    const fullPayload = {
      name: form.name.trim(),
      url: form.url.trim(),
      source_type: form.source_type,
      company_name: form.company_name.trim() || null,
      rapidapi_identifier: form.collectionAddress.trim() || form.url.trim(),
      lookback_days: form.lookback_days,
    }

    // A non-admin editing an existing source may change lookback_days only —
    // matches exactly what the 0025 trigger allows, so this never even
    // attempts a write the database would refuse. Creating a source always
    // uses the full payload: that path is unreachable for a non-admin, since
    // the "Add source" button itself is admin-only in Sources().
    const { error } = source
      ? await supabase
          .from('sources')
          .update(isAdmin ? fullPayload : { lookback_days: form.lookback_days })
          .eq('id', source.id)
      : await supabase.from('sources').insert(fullPayload)
    setSaving(false)
    if (error) setErr(error.message)
    else onSaved(!source)
  }

  return (
    <div
      className="fixed inset-0 z-10 flex items-center justify-center bg-slate-900/40 px-6"
      onClick={onClose}
    >
      <form
        onClick={(e) => e.stopPropagation()}
        onSubmit={submit}
        className="w-full max-w-lg rounded-lg bg-white p-6 shadow-xl"
      >
        <h2 className="text-lg font-semibold">
          {!isAdmin ? 'Change lookback' : source ? 'Edit source' : 'New source'}
        </h2>

        {!isAdmin ? (
          <div className="mt-4 space-y-4">
            <p className="text-sm text-slate-500">
              Only an admin can change a source's name, address or type. You can
              still adjust how far back it looks.
            </p>
            <Field label="Lookback (days)">
              <input
                type="number"
                min={1}
                max={365}
                value={form.lookback_days}
                onChange={(e) => set('lookback_days', Number(e.target.value))}
                className="w-full rounded-md border border-slate-300 px-3 py-2"
              />
            </Field>
          </div>
        ) : (
          <div className="mt-4 space-y-4">
            <Field label="Name">
              <input
                required
                value={form.name}
                onChange={(e) => set('name', e.target.value)}
                className="w-full rounded-md border border-slate-300 px-3 py-2"
              />
            </Field>
            <Field label="URL">
              <input
                required
                type="url"
                value={form.url}
                onChange={(e) => set('url', e.target.value)}
                className="w-full rounded-md border border-slate-300 px-3 py-2"
              />
              <p className="mt-1 text-xs text-slate-500">
                This is also the address posts are collected from, unless you set
                a different one below.
              </p>
            </Field>
            <div className="grid grid-cols-2 gap-4">
              <Field label="Type">
                <select
                  value={form.source_type}
                  onChange={(e) => set('source_type', e.target.value)}
                  className="w-full rounded-md border border-slate-300 px-3 py-2"
                >
                  <option value="linkedin">linkedin</option>
                </select>
              </Field>
              <Field label="Lookback (days)">
                <input
                  type="number"
                  min={1}
                  max={365}
                  value={form.lookback_days}
                  onChange={(e) => set('lookback_days', Number(e.target.value))}
                  className="w-full rounded-md border border-slate-300 px-3 py-2"
                />
              </Field>
            </div>
            <Field label="Company name (optional)">
              <input
                value={form.company_name}
                onChange={(e) => set('company_name', e.target.value)}
                className="w-full rounded-md border border-slate-300 px-3 py-2"
              />
            </Field>

            {showAdvanced ? (
              <Field label="Collect from a different address (rare)">
                <input
                  type="url"
                  placeholder={form.url || 'Same as URL above'}
                  value={form.collectionAddress}
                  onChange={(e) => set('collectionAddress', e.target.value)}
                  className="w-full rounded-md border border-slate-300 px-3 py-2"
                />
                <p className="mt-1 text-xs text-slate-500">
                  Only needed when the page above isn't the exact address posts
                  should be collected from — e.g. the URL points at a posts feed
                  view. Leave blank to use the URL above.
                </p>
              </Field>
            ) : (
              <button
                type="button"
                onClick={() => setShowAdvanced(true)}
                className="text-sm font-medium text-slate-500 hover:text-slate-900"
              >
                Collect from a different address…
              </button>
            )}
          </div>
        )}

        {err && <p className="mt-4 text-sm text-red-600">{err}</p>}

        <div className="mt-6 flex justify-end gap-3">
          <button
            type="button"
            onClick={onClose}
            className="rounded-md px-4 py-2 text-sm font-medium text-slate-600 hover:bg-slate-100"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={saving}
            className="rounded-md bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-800 disabled:opacity-60"
          >
            {saving ? 'Saving…' : 'Save'}
          </button>
        </div>
      </form>
    </div>
  )
}

function Field({
  label,
  children,
}: {
  label: string
  children: React.ReactNode
}) {
  return (
    <label className="block text-sm">
      <span className="mb-1 block font-medium text-slate-700">{label}</span>
      {children}
    </label>
  )
}
