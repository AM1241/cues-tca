import { useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'
import { useToast } from '../components/toast-context'
import { Spinner, ErrorNotice } from '../components/ui'
import type { Database } from '../lib/database.types'

type Config = Database['public']['Tables']['configurations']['Row']

// One theme as the scorer sees it. This list lives in `scoring_themes`, NOT in
// configurations.themes — the two used to be independent and nothing synced
// them, so removing a theme here changed the generator's prompt while the
// scorer carried on scoring it. scoring_themes is the source of truth because
// its theme_ids are immutable and referenced by every stored result;
// configurations.themes is now a mirror the RPC refreshes. See 0019.
type Theme = { theme_id: string; label: string }

// The single editorial config row (id='default'). RLS in 0002 lets editors SELECT
// and UPDATE it, but not insert or delete: the pipeline assumes it always exists.
// company_aliases is a { alias: canonical } jsonb map.
type Draft = {
  editorial_domain: string
  domain_generic_entity: string
  domain_generic_entity_alt: string
  themes: Theme[]
  voice_tone: string
  voice_audience: string
  voice_style: string
  min_relevance_score: number
  cluster_similarity_threshold: number
  min_cluster_size: number
  anonymization_enabled: boolean
  anonymize_companies: boolean
  keep_public_bodies: boolean
  aliases: { key: string; value: string }[]
}

/** Same convention the seeded themes use: "talent development" -> talent_development. */
function toThemeId(label: string): string {
  return label.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/(^_|_$)/g, '')
}

function toDraft(c: Config, themes: Theme[]): Draft {
  const aliasObj = (c.company_aliases ?? {}) as Record<string, string>
  return {
    editorial_domain: c.editorial_domain ?? '',
    domain_generic_entity: c.domain_generic_entity ?? '',
    domain_generic_entity_alt: c.domain_generic_entity_alt ?? '',
    themes,
    voice_tone: c.voice_tone ?? '',
    voice_audience: c.voice_audience ?? '',
    voice_style: c.voice_style ?? '',
    min_relevance_score: Number(c.min_relevance_score),
    cluster_similarity_threshold: Number(c.cluster_similarity_threshold),
    min_cluster_size: Number(c.min_cluster_size),
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
    async function load() {
      const [cfg, themes] = await Promise.all([
        supabase.from('configurations').select('*').eq('id', 'default').single(),
        // Active themes only: retired ones stay in the table so historical
        // results keep resolving their theme_ids, but they are not part of the
        // objective any more.
        supabase
          .from('scoring_themes')
          .select('theme_id, label')
          .eq('active', true)
          .order('position'),
      ])
      if (cfg.error) return setError(cfg.error.message)
      if (themes.error) return setError(themes.error.message)
      if (cfg.data) setDraft(toDraft(cfg.data, themes.data ?? []))
    }
    load()
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
    // Themes go through the RPC, not this UPDATE: it is what keeps
    // scoring_themes (the scorer's list) and configurations.themes in step, and
    // it retires dropped themes rather than deleting ids that stored results
    // still reference.
    const { error: themesError } = await supabase.rpc('set_scoring_themes', {
      p_themes: draft.themes.map((t, i) => ({
        theme_id: t.theme_id,
        label: t.label,
        position: i + 1,
        active: true,
      })),
    })
    if (themesError) {
      setSaving(false)
      return toast.error(themesError.message)
    }

    const { error } = await supabase
      .from('configurations')
      .update({
        editorial_domain: draft.editorial_domain.trim(),
        domain_generic_entity: draft.domain_generic_entity.trim(),
        domain_generic_entity_alt: draft.domain_generic_entity_alt.trim(),
        voice_tone: draft.voice_tone.trim() || null,
        voice_audience: draft.voice_audience.trim() || null,
        voice_style: draft.voice_style.trim() || null,
        min_relevance_score: draft.min_relevance_score,
        cluster_similarity_threshold: draft.cluster_similarity_threshold,
        min_cluster_size: draft.min_cluster_size,
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

      <Section
        title="Editorial scope"
        hint="What this publication is actually about. Themes are angles within this scope, not the scope itself."
      >
        <TextField
          label="Domain"
          value={draft.editorial_domain}
          onChange={(v) => patch({ editorial_domain: v })}
        />
        <p className="mt-2 text-sm text-slate-500">
          A post outside this domain scores <strong>0 on every theme</strong>, however
          strongly it matches one in the abstract — an unrelated sector's
          sustainability story is not a sustainability story for this publication.
        </p>
        <div className="mt-4 space-y-3">
          <TextField
            label="Anonymised company wording"
            value={draft.domain_generic_entity}
            onChange={(v) => patch({ domain_generic_entity: v })}
          />
          <TextField
            label="…and for a second organisation in the same post"
            value={draft.domain_generic_entity_alt}
            onChange={(v) => patch({ domain_generic_entity_alt: v })}
          />
        </div>
      </Section>

      <Section
        title="Themes"
        hint="The angles the scorer rates each post against, within the domain above."
      >
        <div className="flex flex-wrap gap-2">
          {draft.themes.map((t) => (
            <span
              key={t.theme_id}
              className="inline-flex items-center gap-1.5 rounded-full bg-slate-100 py-1 pl-3 pr-2 text-sm"
            >
              {t.label}
              <button
                onClick={() =>
                  patch({
                    themes: draft.themes.filter((x) => x.theme_id !== t.theme_id),
                  })
                }
                className="text-slate-400 hover:text-slate-700"
                aria-label={`Remove ${t.label}`}
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
              if (e.key !== 'Enter') return
              e.preventDefault()
              const label = newTheme.trim()
              const theme_id = toThemeId(label)
              if (theme_id && !draft.themes.some((x) => x.theme_id === theme_id))
                patch({ themes: [...draft.themes, { theme_id, label }] })
              setNewTheme('')
            }}
            placeholder="Add a theme and press Enter"
            className="flex-1 rounded-md border border-slate-300 px-3 py-1.5 text-sm"
          />
        </div>
        <p className="mt-2 text-xs text-slate-400">
          Removing a theme retires it rather than deleting it — posts already scored
          keep referring to it, so their history stays readable.
        </p>
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

      <Section
        title="Clustering"
        hint="How anonymised posts are grouped into themes before generation."
      >
        <div className="space-y-3">
          <label className="block text-sm">
            <span className="mb-1 block font-medium text-slate-700">
              Similarity threshold
            </span>
            <div className="flex items-center gap-4">
              <input
                type="range"
                min={0.5}
                max={0.95}
                step={0.01}
                value={draft.cluster_similarity_threshold}
                onChange={(e) =>
                  patch({ cluster_similarity_threshold: Number(e.target.value) })
                }
                className="w-64"
              />
              <span className="w-12 text-right font-semibold tabular-nums">
                {draft.cluster_similarity_threshold.toFixed(2)}
              </span>
            </div>
          </label>
          <label className="block text-sm">
            <span className="mb-1 block font-medium text-slate-700">
              Minimum cluster size
            </span>
            <input
              type="number"
              min={2}
              max={20}
              value={draft.min_cluster_size}
              onChange={(e) => patch({ min_cluster_size: Number(e.target.value) })}
              className="w-24 rounded-md border border-slate-300 px-3 py-2"
            />
          </label>
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
