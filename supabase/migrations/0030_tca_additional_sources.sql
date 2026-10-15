-- 0030_tca_additional_sources.sql
--
-- Nine LinkedIn pages Tecnoalimenti asked to have watched, as sector bodies
-- whose output should feed topic detection alongside the existing five.
--
-- WHY A MIGRATION AND NOT A SEED
-- `supabase/seed.sql` only runs on a fresh database. The installation these
-- sources are wanted on is the running one, with 273 collected posts in it, so
-- the change has to arrive the same way every other schema change does.
--
-- WHY THIS IS ENOUGH TO REACH THE WHOLE PIPELINE
-- Nothing downstream holds a list of sources. `ingest` collects from whatever
-- is in this table and enabled; inserting a raw_post enqueues scoring by
-- trigger (0005/0006); anonymisation, clustering and generation all read from
-- the resulting rows, not from a source list. A row here is therefore wired
-- into every stage by construction — but see the note on retrieval below.
--
-- WHAT THIS MIGRATION DOES *NOT* DO
-- It registers the sources. It does not prove that LinkedIn content can be
-- retrieved for any of them: that costs a real provider request per source and
-- has to be run deliberately with `Collect`. Registration and confirmed
-- retrieval are different claims and are kept apart on purpose.
--
-- IDEMPOTENCE
-- `sources.name` is unique, so re-running is a no-op for anything already
-- present. The second guard, on rapidapi_identifier, catches the case where an
-- operator added the same LinkedIn page under a different display name — which
-- `on conflict (name)` alone would happily duplicate.

insert into public.sources (name, source_type, url, rapidapi_identifier, company_name, lookback_days, enabled)
select v.name, 'linkedin', v.url, v.url, v.company_name, 30, true
from (values
  ('GS1 Italy',           'https://www.linkedin.com/company/gs1-italy/',                          'GS1 Italy'),
  ('Unione Italiana Food','https://www.linkedin.com/company/unione-italiana-food-unionfood/',     'Unione Italiana Food'),
  ('Federalimentare',     'https://www.linkedin.com/company/federalimentare/',                    'Federalimentare'),
  ('CREA',                'https://www.linkedin.com/company/crea-ricerca/',                       'CREA'),
  ('EFSA',                'https://www.linkedin.com/company/efsa/',                               'European Food Safety Authority'),
  ('EFFoST',              'https://www.linkedin.com/company/effost/',                             'EFFoST'),
  ('Foodvalley',          'https://www.linkedin.com/company/food-valley-foundation-/',            'Foodvalley'),
  ('FoodDrinkEurope',     'https://www.linkedin.com/company/fooddrinkeurope/',                    'FoodDrinkEurope'),
  ('EIT Food',            'https://www.linkedin.com/company/eit-food/',                           'EIT Food')
) as v(name, url, company_name)
where not exists (
  select 1 from public.sources s where s.rapidapi_identifier = v.url
)
on conflict (name) do nothing;

comment on table public.sources is
  'LinkedIn pages the collector reads. rapidapi_identifier is the exact address fetched; url is what a human clicks. Extended for the Tecnoalimenti trial in 0030.';
