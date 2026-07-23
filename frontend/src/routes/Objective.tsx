import { useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'
import { useToast } from '../components/toast-context'
import { Spinner, ErrorNotice } from '../components/ui'
import type { Database } from '../lib/database.types'

type Config = Database['public']['Tables']['configurations']['Row']

// The single editorial config row (id='default'). RLS in 0002 lets editors SELECT
// and UPDATE it, but not insert or delete: the pipeline assumes it always exists.
// themes is a string[] jsonb; company_aliases is a { alias: canonical } jsonb map.
type Draft = {
  themes: string[]
  voice_tone: string
  voice_audience: string
  voice_style: string
  min_relevance_score: number
  anonymization_enabled: boolean
  anonymize_companies: boolean
  keep_public_bodies: boolean
  aliases: { key: string; value: string }[]
}

function toDraft(c: Config): Draft {
  const aliasObj = (c.company_aliases ?? {}) as Record<string, string>
  return {
    themes: (c.themes as string[]) ?? [],
    voice_tone: c.voice_tone ?? '',
    voice_audience: c.voice_audience ?? '',
    voice_style: c.voice_style ?? '',
    min_relevance_score: Number(c.min_relevance_score),
    anonymization_enabled: c.anonymization_enabled,
    anonymize_companies: c.anonymize_companies,
    keep_public_bodies: c.keep_public_bodies,
    aliases: Object.entries(aliasObj).map(([key, value]) => ({ key, value })),
  }
}

export function Objective() {
  const toast = useToast()
  const [draft, setDraft] = useState<Draft | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [dirty, setDirty] = useState(false)
  const [newTheme, setNewTheme] = useState('')

  useEffect(() => {
    supabase
      .from('configurations')
      .select('*')
      .eq('id', 'default')
      .single()
      .then(({ data, error }) => {
        if (error) setError(error.message)
        else if (data) setDraft(toDraft(data))
      })
  }, [])

  function patch(p: Partial<Draft>) {
    setDraft((d) => (d ? { ...d, ...p } : d))
    setDirty(true)
  }

  async function save() {
    if (!draft) return
    setSaving(true)
    setError(null)
    const aliases: Record<string, string> = {}
    for (const { key, value } of draft.aliases) {
      const k = key.trim()
      if (k) aliases[k] = value.trim()
    }
    const { error } = await supabase
      .from('configurations')
      .update({
        themes: draft.themes,
        voice_tone: draft.voice_tone.trim() || null,
        voice_audience: draft.voice_audience.trim() || null,
        voice_style: draft.voice_style.trim() || null,
        min_relevance_score: draft.min_relevance_score,
        anonymization_enabled: draft.anonymization_enabled,
        anonymize_companies: draft.anonymize_companies,
        keep_public_bodies: draft.keep_public_bodies,
        company_aliases: aliases,
      })
      .eq('id', 'default')
    setSaving(false)
    if (error) toast.error(error.message)
    else {
      setDirty(false)
      toast.success('Objective saved')
    }
  }

  if (error) return <ErrorNotice message={error} />
  if (!draft) return <Spinner label="Loading objective…" />

  return (
    <div className="max-w-2xl">
      <div className="mb-6 flex items-center justify-between">
        <h1 className="text-xl font-semibold">Editorial objective</h1>
        <div className="flex items-center gap-3">
          {dirty && (
            <span className="text-sm text-amber-600">unsaved changes</span>
          )}
          <button
            onClick={save}
            disabled={saving || !dirty}
            className="rounded-md bg-slate-900 px-4 py-1.5 text-sm font-medium text-white hover:bg-slate-800 disabled:opacity-60"
          >
            {saving ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>

      <Section title="Themes" hint="What the scorer rates each post against.">
        <div className="flex flex-wrap gap-2">
          {draft.themes.map((t) => (
            <span
              key={t}
              className="inline-flex items-center gap-1.5 rounded-full bg-slate-100 py-1 pl-3 pr-2 text-sm"
            >
              {t}
              <button
                onClick={() =>
                  patch({ themes: draft.themes.filter((x) => x !== t) })
                }
                className="text-slate-400 hover:text-slate-700"
                aria-label={`Remove ${t}`}
              >
                ×
              </button>
            </span>
          ))}
        </div>
        <div className="mt-3 flex gap-2">
          <input
            value={newTheme}
            onChange={(e) => setNewTheme(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                const v = newTheme.trim()
                if (v && !draft.themes.includes(v))
                  patch({ themes: [...draft.themes, v] })
                setNewTheme('')
              }
            }}
            placeholder="Add a theme and press Enter"
            className="flex-1 rounded-md border border-slate-300 px-3 py-1.5 text-sm"
          />
        </div>
      </Section>

      <Section title="Voice" hint="Passed to the generator's prompt.">
        <div className="space-y-3">
          <TextField
            label="Tone"
            value={draft.voice_tone}
            onChange={(v) => patch({ voice_tone: v })}
          />
          <TextField
            label="Audience"
            value={draft.voice_audience}
            onChange={(v) => patch({ voice_audience: v })}
          />
          <TextField
            label="Style"
            value={draft.voice_style}
            onChange={(v) => patch({ voice_style: v })}
          />
        </div>
      </Section>

      <Section
        title="Relevance threshold"
        hint="Posts below this overall score are excluded from generation."
      >
        <div className="flex items-center gap-4">
          <input
            type="range"
            min={0}
            max={100}
            step={5}
            value={draft.min_relevance_score}
            onChange={(e) =>
              patch({ min_relevance_score: Number(e.target.value) })
            }
            className="w-64"
          />
          <span className="w-10 text-right font-semibold tabular-nums">
            {draft.min_relevance_score}
          </span>
        </div>
      </Section>

      <Section title="Anonymisation">
        <div className="space-y-2">
          <Toggle
            label="Anonymisation enabled"
            checked={draft.anonymization_enabled}
            onChange={(v) => patch({ anonymization_enabled: v })}
          />
          <Toggle
            label="Anonymise company names"
            checked={draft.anonymize_companies}
            onChange={(v) => patch({ anonymize_companies: v })}
          />
          <Toggle
            label="Keep public bodies (don't anonymise)"
            checked={draft.keep_public_bodies}
            onChange={(v) => patch({ keep_public_bodies: v })}
          />
        </div>
      </Section>

      <Section
        title="Company aliases"
        hint="Alias → canonical name, used by the anonymiser's replacement map."
      >
        <div className="space-y-2">
          {draft.aliases.map((a, i) => (
            <div key={i} className="flex gap-2">
              <input
                value={a.key}
                onChange={(e) => {
                  const next = [...draft.aliases]
                  next[i] = { ...next[i], key: e.target.value }
                  patch({ aliases: next })
                }}
                placeholder="alias"
                className="flex-1 rounded-md border border-slate-300 px-3 py-1.5 text-sm"
              />
              <input
                value={a.value}
                onChange={(e) => {
                  const next = [...draft.aliases]
                  next[i] = { ...next[i], value: e.target.value }
                  patch({ aliases: next })
                }}
                placeholder="canonical name"
                className="flex-1 rounded-md border border-slate-300 px-3 py-1.5 text-sm"
              />
              <button
                onClick={() =>
                  patch({ aliases: draft.aliases.filter((_, j) => j !== i) })
                }
                className="px-2 text-slate-400 hover:text-slate-700"
                aria-label="Remove alias"
              >
                ×
              </button>
            </div>
          ))}
          <button
            onClick={() =>
              patch({ aliases: [...draft.aliases, { key: '', value: '' }] })
            }
            className="text-sm font-medium text-slate-500 hover:text-slate-900"
          >
            + Add alias
          </button>
        </div>
      </Section>
    </div>
  )
}

function Section({
  title,
  hint,
  children,
}: {
  title: string
  hint?: string
  children: React.ReactNode
}) {
  return (
    <section className="mb-6 rounded-lg border border-slate-200 bg-white p-5">
      <h2 className="font-semibold">{title}</h2>
      {hint && <p className="mt-0.5 mb-3 text-sm text-slate-500">{hint}</p>}
      {!hint && <div className="mb-3" />}
      {children}
    </section>
  )
}

function TextField({
  label,
  value,
  onChange,
}: {
  label: string
  value: string
  onChange: (v: string) => void
}) {
  return (
    <label className="block text-sm">
      <span className="mb-1 block font-medium text-slate-700">{label}</span>
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="w-full rounded-md border border-slate-300 px-3 py-2"
      />
    </label>
  )
}

function Toggle({
  label,
  checked,
  onChange,
}: {
  label: string
  checked: boolean
  onChange: (v: boolean) => void
}) {
  return (
    <label className="flex cursor-pointer items-center gap-3 text-sm text-slate-700">
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        onClick={() => onChange(!checked)}
        className={`relative inline-flex h-5 w-9 items-center rounded-full transition ${
          checked ? 'bg-emerald-500' : 'bg-slate-300'
        }`}
      >
        <span
          className={`inline-block h-4 w-4 transform rounded-full bg-white transition ${
            checked ? 'translate-x-4' : 'translate-x-1'
          }`}
        />
      </button>
      {label}
    </label>
  )
}
