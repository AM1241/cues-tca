# Editorial presets

The pipeline is sector-neutral: scoring, anonymisation and generation all read
the domain from `configurations`, not from code. This file records the values
for each direction the project has been pointed at, so switching is one
statement rather than an archaeology exercise.

See `supabase/migrations/0019_editorial_domain.sql` for why these moved out of
code, and `docs/SESSION_HANDOFF.md` for the measurement that motivated it.

## CUES — food and agrifood (the project's own direction)

This is the seeded default: `0019` sets these as the column defaults, so a fresh
database and the existing production row both start here.

```sql
update public.configurations set
  editorial_domain          = 'food, agriculture and the agrifood supply chain',
  domain_generic_entity     = 'a food-sector organization',
  domain_generic_entity_alt = 'another food-sector organization'
where id = 'default';
```

Themes, as seeded in `0005_scoring.sql` and editable from the Objective screen:
`sustainability`, `innovation`, `talent development`, `food safety`,
`supply chain`, `tradition`.

> Note on `talent development`: measured on real posts, it is the theme most
> likely to admit off-domain content — a careers or traineeship announcement
> scores highly on it while having nothing to do with the sector. The domain
> rule added in 0019 suppresses most of that, but not all: an EU social-policy
> post still scored 70 on it. If the objective is strictly sector news rather
> than employer branding, retiring this theme is the cleaner setting.

## Switching to another sector

Set the three fields together — a domain without matching generic wording leaves
the anonymiser describing companies in the old sector's language.

```sql
update public.configurations set
  editorial_domain          = 'automotive manufacturing and its supply chain',
  domain_generic_entity     = 'an automotive-sector organization',
  domain_generic_entity_alt = 'another automotive-sector organization'
where id = 'default';
```

Then review the themes on the Objective screen — the seeded six are food-shaped
(`food safety`, `tradition`) and will not fit another sector unchanged.

Still food-specific in code, and a correction to session 14's claim that all
four hardcoded assumptions were made configurable — there is a fifth:

- **`cluster/prompt.ts` carries a hardcoded CUES brief** (*"CUES is building an
  editorial narrative around how food companies communicate change, value, and
  responsibility"*) with five food-specific directions, used to name every
  cluster. It should read `editorial_domain` like the others. Pointed at another
  sector, cluster names would still be written for a food publication.
- the anonymiser's public-body preservation list
  (`anonymize-worker/deterministic.ts`), which names EU and Italian food
  institutions

`aggregation_strategy` and the scoring model moved into `configurations` in
`0021`, so they are no longer on this list — though neither has a UI control yet.

## Company and brand names

`company_aliases` is the operator's lever for names the source label cannot
imply: product brands, historical names, venues. `discover-brands` proposes them
per source and an editor accepts, but it is an assistant rather than an
authority — on Fratelli Branca it found nine names a careful human read had
missed, and still missed two that appear only inside hashtags. Expect to add
some by hand.

Note for any deployment carrying the corpus encoding corruption: the model
normalises accents, so it proposes "Niccolò Branca" where the stored text holds
"Niccol? Branca". Such an alias never matches. Prefer the unaccented part of the
name until ingest is fixed.
