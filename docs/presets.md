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

Two things are **not** yet configurable and stay food-specific in code:

- the anonymiser's public-body preservation list
  (`anonymize-worker/deterministic.ts`), which names EU and Italian food
  institutions
- the aggregation strategy `max_theme_v1`, which lives on the scoring request
  rather than in `configurations`

Both are candidates for the same treatment if the tool is genuinely pointed at
another sector.
