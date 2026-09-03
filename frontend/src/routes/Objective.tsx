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
  scoring_model: string
  scoring_model_snapshot: string
  aggregation_strategy: string
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
    scoring_model: c.scoring_model ?? '',
    scoring_model_snapshot: c.scoring_model_snapshot ?? '',
    aggregation_strategy: c.aggregation_strategy ?? 'max_theme_v1',
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
        scoring_model: draft.scoring_model.trim(),
        scoring_model_snapshot: draft.scoring_model_snapshot.trim(),
        aggregation_strategy: draft.aggregation_strategy,
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
      <div className="mb-2 flex items-center justify-between">
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
      <p className="mb-6 text-sm text-slate-500">
        Grouped by which screen a change actually reaches — every group below names it.
        Nothing here takes effect on its own: Posts still needs Score now, Clusters still
        needs Run clustering, on the settings that were active at the time.
      </p>

      {/* ============================================================ */}
      <StageHeader
        n={1}
        title="Scope"
        reaches={['Posts', 'Clusters', 'Generate']}
        detail="The domain and the themes are read almost everywhere: they shape the scoring rubric, name the clusters, and appear in the final text's brief. Get these right first — everything else narrows within them."
      />

      <Section title="Domain">
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
      </Section>

      <Section
        title="Themes"
        hint="The angles Posts scores each item against, within the domain above."
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

      {/* ============================================================ */}
      <StageHeader
        n={2}
        title="Deciding what's relevant"
        reaches={['Posts']}
        detail="Controls the Posts screen only: which model scores an item, and which scored items are worth carrying forward at all."
      />

      <Section
        title="Relevance threshold"
        hint="Posts below this score are excluded from BOTH anonymisation and the final text — not generation alone."
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
        <p className="mt-2 text-xs text-slate-500">
          A post scoring below this never becomes eligible for Anonymise now on
          Clusters either — this is the one setting that reaches two screens at once.
        </p>
      </Section>

      <Section
        title="Scoring engine"
        hint="Which model scores a post, and how its per-theme scores become one number."
      >
        <div className="space-y-3">
          <div className="grid gap-4 sm:grid-cols-2">
            <TextField
              label="Model"
              value={draft.scoring_model}
              onChange={(v) => patch({ scoring_model: v })}
            />
            <TextField
              label="Pinned build"
              value={draft.scoring_model_snapshot}
              onChange={(v) => patch({ scoring_model_snapshot: v })}
            />
          </div>
          <label className="block text-sm">
            <span className="mb-1 block font-medium text-slate-700">
              Combining theme scores
            </span>
            <select
              value={draft.aggregation_strategy}
              onChange={(e) => patch({ aggregation_strategy: e.target.value })}
              className="rounded-md border border-slate-300 px-3 py-2 text-sm"
            >
              <option value="max_theme_v1">Highest single theme wins</option>
            </select>
          </label>
          <p className="text-xs text-slate-500">
            &ldquo;Highest single theme&rdquo; means a post scoring 95 on one theme and 0 on
            the rest ranks alongside one that is strong across the board. It is the
            only strategy implemented; the list is here so a second one is a visible
            choice rather than a hidden default.
          </p>
          <p className="text-xs text-slate-500">
            The pinned build is the exact dated model recorded on every score, so a
            result can still name what produced it after the alias moves. Changing
            either field opens a new scoring request the next time you queue —
            existing scores stay until you re-score.
          </p>
        </div>
      </Section>

      {/* ============================================================ */}
      <StageHeader
        n={3}
        title="Anonymising and grouping"
        reaches={['Clusters']}
        detail="Everything here runs on the Clusters screen: what a company name becomes once hidden, which names are hidden at all, and how similar posts are grouped into the themes a publication is built from."
      />

      <Section
        title="Anonymised wording"
        hint="What a hidden company becomes in the text — for the source itself, and for a second organisation named in the same post."
      >
        <div className="space-y-3">
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
        title="Company and brand names"
        hint="Any name on the left is replaced by the text on the right, in post text and in hashtags."
      >
        <p className="mb-3 text-sm text-slate-500">
          The anonymiser derives a source's own name from its label. Product brands
          it cannot — <em>Carpano</em> never appears in
          “Fratelli Branca Distillerie”, and the entity extractor skips it as the
          source's own. List those here.
        </p>
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
                placeholder="name in the text"
                className="flex-1 rounded-md border border-slate-300 px-3 py-1.5 text-sm"
              />
              <input
                value={a.value}
                onChange={(e) => {
                  const next = [...draft.aliases]
                  next[i] = { ...next[i], value: e.target.value }
                  patch({ aliases: next })
                }}
                placeholder="replace with"
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

      <Section
        title="Clustering"
        hint="How anonymised posts are grouped into themes, still on the Clusters screen."
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

      {/* ============================================================ */}
      <StageHeader
        n={4}
        title="Writing the final text"
        reaches={['Generate']}
        detail="Read only when a post or publication is actually written on the Clusters screen's Create publication button. Nothing here touches scoring or anonymisation."
      />

      <Section
        title="Editorial brief"
        hint="The main instruction: what this publication is trying to say, and why. This is the field that used to be labelled “Style” — it is a direction, not a stylistic descriptor."
      >
        <label className="block text-sm">
          <textarea
            value={draft.voice_style}
            onChange={(e) => patch({ voice_style: e.target.value })}
            rows={3}
            placeholder="e.g. Highlight how organisations in this sector communicate change, value and responsibility, and give the institutional context around them."
            className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
          />
        </label>
        <p className="mt-2 text-xs text-slate-500">
          Left blank, the generator falls back to a generic sentence built from the
          Domain above — usable, but worth writing your own once you know what this
          publication is actually for.
        </p>
      </Section>

      <Section title="Voice" hint="Shorter dials on the same text — tone and who it's written for.">
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
        </div>
      </Section>
    </div>
  )
}

const STAGE_COLORS: Record<string, string> = {
  Posts: 'bg-blue-100 text-blue-700',
  Clusters: 'bg-violet-100 text-violet-700',
  Generate: 'bg-teal-100 text-teal-700',
}

/**
 * One per pipeline stage. Exists because the flat stack of sections this
 * screen used to be gave no indication of where a change actually landed —
 * an operator could not tell "Style" only ever reached Generate, or that
 * Relevance threshold reaches both Posts and Clusters, without reading the
 * source. The `reaches` badges are the same names as the nav bar and the
 * button an operator will actually press next.
 */
function StageHeader({
  n,
  title,
  reaches,
  detail,
}: {
  n: number
  title: string
  reaches: string[]
  detail: string
}) {
  return (
    <div className="mb-3 mt-8 first:mt-0">
      <div className="flex items-center gap-2">
        <span className="flex h-5 w-5 items-center justify-center rounded-full bg-slate-900 text-xs font-semibold text-white">
          {n}
        </span>
        <h2 className="text-base font-semibold text-slate-900">{title}</h2>
        <span className="text-slate-300">·</span>
        <div className="flex gap-1.5">
          {reaches.map((r) => (
            <span
              key={r}
              className={`rounded px-1.5 py-0.5 text-xs font-medium ${STAGE_COLORS[r] ?? 'bg-slate-100 text-slate-600'}`}
            >
              → {r}
            </span>
          ))}
        </div>
      </div>
      <p className="mt-1 text-sm text-slate-500">{detail}</p>
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
