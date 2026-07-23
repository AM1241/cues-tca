import { useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'
import { useToast } from '../components/toast-context'
import { Spinner, ErrorNotice } from '../components/ui'
import type { Database } from '../lib/database.types'

type Source = Database['public']['Tables']['sources']['Row']

// Editors may insert and update sources, but not delete them: RLS in 0002 grants
// no DELETE. Retiring a source is `enabled = false`, which is what the toggle does.
type FormState = {
  name: string
  url: string
  source_type: string
  company_name: string
  rapidapi_identifier: string
  lookback_days: number
}

const emptyForm: FormState = {
  name: '',
  url: '',
  source_type: 'linkedin',
  company_name: '',
  rapidapi_identifier: '',
  lookback_days: 30,
}

export function Sources() {
  const toast = useToast()
  const [sources, setSources] = useState<Source[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [editing, setEditing] = useState<Source | 'new' | null>(null)

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
        <button
          onClick={() => setEditing('new')}
          className="rounded-md bg-slate-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-slate-800"
        >
          Add source
        </button>
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
                  <button
                    onClick={() => setEditing(s)}
                    className="text-sm font-medium text-slate-500 hover:text-slate-900"
                  >
                    Edit
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {editing && (
        <SourceForm
          source={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={(created) => {
            setEditing(null)
            toast.success(created ? 'Source created' : 'Source updated')
            load()
          }}
        />
      )}
    </div>
  )
}

function SourceForm({
  source,
  onClose,
  onSaved,
}: {
  source: Source | null
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
          rapidapi_identifier: source.rapidapi_identifier ?? '',
          lookback_days: source.lookback_days,
        }
      : emptyForm,
  )
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  function set<K extends keyof FormState>(key: K, value: FormState[K]) {
    setForm((f) => ({ ...f, [key]: value }))
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setSaving(true)
    setErr(null)
    const payload = {
      name: form.name.trim(),
      url: form.url.trim(),
      source_type: form.source_type,
      company_name: form.company_name.trim() || null,
      rapidapi_identifier: form.rapidapi_identifier.trim() || null,
      lookback_days: form.lookback_days,
    }
    const { error } = source
      ? await supabase.from('sources').update(payload).eq('id', source.id)
      : await supabase.from('sources').insert(payload)
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
          {source ? 'Edit source' : 'New source'}
        </h2>

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
          <Field label="RapidAPI identifier (optional)">
            <input
              value={form.rapidapi_identifier}
              onChange={(e) => set('rapidapi_identifier', e.target.value)}
              className="w-full rounded-md border border-slate-300 px-3 py-2"
            />
          </Field>
        </div>

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
