-- =============================================================================
-- 0034_output_language.sql — choose the language of the written output
-- =============================================================================
--
-- In the call of 2026-11-06 Tecnoalimenti asked for Italian output, and FINT
-- agreed to a dedicated control rather than wording in the editorial brief: the
-- brief route ("Scrivi in italiano e basta") gave four English publications out
-- of seven. generate/prompt.ts reads this column (languageRule); NULL keeps the
-- behaviour of generate_v5 / publication_v3, where the brief decides and
-- English is the default.
--
-- Nothing else reads it. scoring_config_snapshot (0022) lists its fields one by
-- one, so adding a column does not change the scoring hash and rotates nothing.
-- Editors already hold UPDATE on configurations (0002), and RLS covers the row.
-- =============================================================================

alter table public.configurations
  add column output_language text
  constraint configurations_output_language_check check (output_language in ('en', 'it'));

comment on column public.configurations.output_language is
  'Language of the generated post and carousel: en or it. NULL follows the editorial brief, English by default.';
