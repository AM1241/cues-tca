-- =============================================================================
-- 0001_schema.sql — core schema, ported from the legacy SQLite model
-- =============================================================================
--
-- SINGLE-TENANT BY DESIGN. There is deliberately no `org_id` on `sources`,
-- `configurations` or anything else. CUES is the only tenant and there is no
-- roadmap for a second one. This is an intentional decision, not an oversight:
-- adding org scoping later means one migration plus an RLS rewrite, and paying
-- for that complexity now would buy nothing.
--
-- Type changes from legacy, applied throughout:
--   VARCHAR(n)  -> text            (no arbitrary length caps)
--   DATETIME    -> timestamptz     (legacy stored naive datetime.utcnow())
--   JSON        -> jsonb           (indexable, validated)
--   FLOAT       -> numeric(5,2)    (scores are 0-100, exact)
--   string ids  -> uuid
-- =============================================================================

-- Extensions used in later phases (vector/pgmq/pg_cron) are enabled in the
-- migration for the phase that needs them, not here.

-- -----------------------------------------------------------------------------
-- updated_at maintenance
-- -----------------------------------------------------------------------------
create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;


-- -----------------------------------------------------------------------------
-- sources — one row per LinkedIn company page
-- -----------------------------------------------------------------------------
create table public.sources (
  id                   uuid primary key default gen_random_uuid(),
  name                 text not null unique,
  source_type          text not null default 'linkedin'
                         check (source_type in ('linkedin', 'twitter', 'rss', 'manual')),
  url                  text not null,
  company_name         text,

  -- New in the rewrite: replaces connector_config.json, which the legacy
  -- ingest read off disk before shelling out to a sibling repo.
  rapidapi_identifier  text,
  lookback_days        integer not null default 30 check (lookback_days > 0),

  collection_frequency text not null default 'daily'
                         check (collection_frequency in ('daily', 'every_12h', 'realtime')),
  enabled              boolean not null default true,
  last_fetched_at      timestamptz,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now()
);

comment on table public.sources is
  'LinkedIn company pages to collect from. Replaces legacy connector_config.json.';
comment on column public.sources.rapidapi_identifier is
  'Company identifier passed to the RapidAPI LinkedIn endpoint by the ingest function.';

create trigger sources_set_updated_at
  before update on public.sources
  for each row execute function public.set_updated_at();


-- -----------------------------------------------------------------------------
-- raw_posts — ingested posts
-- -----------------------------------------------------------------------------
-- Legacy PK was f"{source_type}_{source_name}_{md5(post_text)}", while dedup was
-- checked on (source_id, source_url). One source posting identical text at two
-- URLs therefore collided on the PK and raised.
--
-- IDENTITY IS THE PROVIDER'S ID, NOT THE TEXT. A unique constraint on
-- (source_id, content_hash) would have re-created the very bug it claimed to
-- fix: a company legitimately reposting identical copy at a new URL is a
-- distinct post and must be stored as one. content_hash is therefore only
-- INDEXED, for exact-duplicate detection and review, never unique.
--
-- external_post_id is the provider's stable identifier — the LinkedIn activity
-- URN, e.g. 7473335599555338240. It is what ../linkedin_rapidapi_scraper already
-- uses as its own primary key (parser.py::_extract_post_id prefers
-- urn/id/postUrn/entityUrn, falling back to a URL hash). Nullable, because
-- manually entered posts have none; the unique index is partial to suit.
--
-- canonical_url is indexed but deliberately NOT unique. The LinkedIn URL embeds
-- a slug built from the post text (.../posts/masaf_40-anni-al-servizio-...
-- -activity-7473335599555338240-iGps), so editing a post rewrites its URL while
-- the URN stays put. The URL is the weaker identifier of the two.
--
-- Dropped from legacy: `source_name` and `source_type` (denormalised copies of
-- sources.name / sources.source_type), `post_html` (null in all 133 rows) and
-- `dedup_primary_id` (never populated).
-- -----------------------------------------------------------------------------
create table public.raw_posts (
  id                 uuid primary key default gen_random_uuid(),

  -- Legacy composite key, retained so the migrated traceability links and any
  -- future audit against the old system can still resolve. NULL for new posts.
  legacy_id          text unique,

  -- RESTRICT, not CASCADE: deleting a source must never silently destroy its
  -- posts and everything derived from them. Sources are retired by setting
  -- sources.enabled = false; see 0002, where editors have no DELETE at all.
  source_id          uuid not null references public.sources (id) on delete restrict,
  source_url         text not null,
  external_post_id   text,

  post_title         text,
  post_text          text not null,
  author             text,

  published_at       timestamptz not null,
  collected_at       timestamptz not null default now(),
  media_urls         jsonb not null default '[]'::jsonb,
  engagement_metrics jsonb not null default '{}'::jsonb,

  content_hash       text generated always as (md5(post_text)) stored,
  canonical_url      text generated always as
                       (lower(split_part(split_part(source_url, '#', 1), '?', 1))) stored,

  is_processed       boolean not null default false,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

comment on column public.raw_posts.legacy_id is
  'Legacy SQLite primary key (linkedin_{source_name}_{md5}). NULL for posts ingested by the new pipeline.';
comment on column public.raw_posts.external_post_id is
  'Provider-stable id (LinkedIn activity URN). The ingest dedup key. NULL for manual entries.';
comment on column public.raw_posts.content_hash is
  'md5(post_text), INDEXED NOT UNIQUE. Identical text at two provider ids is two posts, not a duplicate.';
comment on column public.raw_posts.canonical_url is
  'source_url minus query/fragment, lowercased. Indexed for lookup; not unique — the URL slug changes when a post is edited.';

-- The real dedup key. Partial, so posts without a provider id are unconstrained
-- rather than all colliding on NULL. Ingest upserts on this index.
create unique index raw_posts_source_external_id_uniq
  on public.raw_posts (source_id, external_post_id)
  where external_post_id is not null;

create index raw_posts_source_published_idx
  on public.raw_posts (source_id, published_at desc);
create index raw_posts_published_idx
  on public.raw_posts (published_at desc);
-- Non-unique: surfaces exact-content repeats for review without forbidding them.
create index raw_posts_content_hash_idx
  on public.raw_posts (source_id, content_hash);
create index raw_posts_canonical_url_idx
  on public.raw_posts (source_id, canonical_url);

create trigger raw_posts_set_updated_at
  before update on public.raw_posts
  for each row execute function public.set_updated_at();


-- -----------------------------------------------------------------------------
-- normalized_posts — cleaned text, 1:1 with raw_posts
-- -----------------------------------------------------------------------------
create table public.normalized_posts (
  id                 uuid primary key default gen_random_uuid(),
  raw_post_id        uuid not null unique
                       references public.raw_posts (id) on delete cascade,
  clean_text         text not null,
  extracted_hashtags jsonb not null default '[]'::jsonb,
  extracted_mentions jsonb not null default '[]'::jsonb,
  tone_type          text check (tone_type in ('question', 'announcement', 'opinion', 'discussion')),
  word_count         integer not null check (word_count >= 0),
  language           text not null default 'en',
  created_at         timestamptz not null default now()
);

comment on constraint normalized_posts_raw_post_id_key on public.normalized_posts is
  'The legacy model documented 1:1 but never enforced it.';


-- -----------------------------------------------------------------------------
-- analyzed_posts — relevance scoring output
-- -----------------------------------------------------------------------------
-- Dropped from legacy: `cluster_id`. The clusters table is gone (see below) and
-- all 133 legacy rows had cluster_id IS NULL.
-- -----------------------------------------------------------------------------
create table public.analyzed_posts (
  id                     uuid primary key default gen_random_uuid(),
  raw_post_id            uuid not null unique
                           references public.raw_posts (id) on delete cascade,

  relevance_scores       jsonb not null,
  overall_relevance      numeric(5,2) not null
                           check (overall_relevance >= 0 and overall_relevance <= 100),
  reason_for_score       text,
  included_in_generation boolean not null default false,

  topics                 jsonb not null default '[]'::jsonb,
  entities               jsonb not null default '{}'::jsonb,
  key_phrases            jsonb not null default '[]'::jsonb,

  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now()
);

comment on column public.analyzed_posts.relevance_scores is
  'theme -> score (0-100). The generate stage filters on configurations.min_relevance_score.';

-- DATA QUALITY, for Phase 3: 7 of the 133 migrated rows carry
-- overall_relevance = 0 while every one of their per-theme scores is non-zero.
-- The migration preserves them exactly as found; do not "fix" them in transit.
-- Whatever wrote overall_relevance disagreed with the per-theme values, and the
-- rescoring work in Phase 3 should establish which is authoritative.
--   select count(*) from analyzed_posts where overall_relevance = 0;  -- 7

create index analyzed_posts_relevance_idx
  on public.analyzed_posts (overall_relevance desc);
create index analyzed_posts_included_idx
  on public.analyzed_posts (included_in_generation) where included_in_generation;

create trigger analyzed_posts_set_updated_at
  before update on public.analyzed_posts
  for each row execute function public.set_updated_at();


-- -----------------------------------------------------------------------------
-- anonymized_posts_current — overwrite-only, no history (legacy semantics kept)
-- -----------------------------------------------------------------------------
-- PK stays raw_post_id: one current anonymisation per post, upserted in place.
-- `generate` reads ONLY this table.
-- -----------------------------------------------------------------------------
create table public.anonymized_posts_current (
  raw_post_id             uuid primary key
                            references public.raw_posts (id) on delete cascade,
  source_name             text not null,
  generalized_source_name text not null,
  overall_relevance       numeric(5,2) not null
                            check (overall_relevance >= 0 and overall_relevance <= 100),
  anonymized_text         text not null,
  replacements            jsonb not null default '[]'::jsonb,
  config_snapshot         jsonb not null default '{}'::jsonb,
  updated_at              timestamptz not null default now()
);

comment on column public.anonymized_posts_current.replacements is
  'Audit trail of every substitution made. Required by reviewers; do not drop.';
comment on column public.anonymized_posts_current.config_snapshot is
  'The configurations row as it stood when this anonymisation ran.';

create index anonymized_posts_relevance_idx
  on public.anonymized_posts_current (overall_relevance desc);

create trigger anonymized_posts_current_set_updated_at
  before update on public.anonymized_posts_current
  for each row execute function public.set_updated_at();


-- -----------------------------------------------------------------------------
-- generation_requests
-- -----------------------------------------------------------------------------
create table public.generation_requests (
  id                      uuid primary key default gen_random_uuid(),
  generation_type         text not null
                            check (generation_type in ('post', 'carousel', 'post+carousel', 'newsletter')),
  collection_period_start timestamptz not null,
  collection_period_end   timestamptz not null,
  selected_sources        jsonb not null default '[]'::jsonb,
  user_instructions       text,
  status                  text not null default 'pending'
                            check (status in ('pending', 'generating', 'completed', 'failed')),
  error_message           text,
  created_by              uuid references auth.users (id) on delete set null,
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now(),

  constraint generation_requests_period_order check (collection_period_end >= collection_period_start)
);

create index generation_requests_created_idx
  on public.generation_requests (created_at desc);

create trigger generation_requests_set_updated_at
  before update on public.generation_requests
  for each row execute function public.set_updated_at();


-- -----------------------------------------------------------------------------
-- editorial_assets — generated editorial copy
-- -----------------------------------------------------------------------------
-- Provenance is explicit and constrained. The legacy generator wrapped its LLM
-- call in a bare `except: pass` and silently substituted ~160 lines of hardcoded
-- copy, so stored assets cannot be trusted at face value:
--
--   'simulated_fallback' — proven canned output from legacy _simulated_llm.
--   'legacy_unverified'  — migrated legacy asset, provenance genuinely unknown.
--   'llm_verified'       — produced by the new pipeline with a confirmed LLM call.
--
-- llm_used is deliberately NULLABLE: null means "not known", which is the honest
-- value for legacy_unverified rows. The check constraint below stops anyone
-- claiming knowledge the provenance value does not support.
-- -----------------------------------------------------------------------------
create table public.editorial_assets (
  id                 uuid primary key default gen_random_uuid(),
  generation_id      uuid not null references public.generation_requests (id) on delete cascade,
  variant_number     integer not null default 1 check (variant_number > 0),

  asset_type         text not null
                       check (asset_type in ('post', 'carousel', 'post+carousel', 'newsletter')),
  title              text,
  generated_text     text not null,

  featured_clusters  jsonb not null default '[]'::jsonb,
  featured_sources   jsonb not null default '[]'::jsonb,
  hashtags           jsonb not null default '[]'::jsonb,
  cta_text           text,

  status             text not null default 'draft'
                       check (status in ('draft', 'approved', 'rejected', 'published')),

  is_legacy          boolean not null default false,
  provenance         text not null default 'llm_verified'
                       check (provenance in ('simulated_fallback', 'legacy_unverified', 'llm_verified')),
  llm_used           boolean,

  -- Review (Phase 7). Columns existed in legacy but nothing ever wrote them.
  approved_by        uuid references auth.users (id) on delete set null,
  approval_timestamp timestamptz,
  approval_notes     text,
  feedback_provided  text,
  edits_made         jsonb not null default '[]'::jsonb,

  -- Regeneration links a new asset back to the one it replaces.
  regenerated_from   uuid references public.editorial_assets (id) on delete set null,

  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),

  constraint editorial_assets_provenance_llm_used check (
    (provenance = 'simulated_fallback' and llm_used is false)
    or (provenance = 'legacy_unverified' and llm_used is null)
    or (provenance = 'llm_verified'      and llm_used is true)
  )
);

comment on column public.editorial_assets.provenance is
  'How this asset was produced. simulated_fallback assets are canned legacy text, not generated copy.';
comment on column public.editorial_assets.llm_used is
  'NULL means unknown (legacy). Never infer a value; the check constraint ties it to provenance.';
comment on column public.editorial_assets.featured_clusters is
  'Free-form jsonb. The legacy clusters table is dropped, so these are not FKs.';

create index editorial_assets_generation_idx on public.editorial_assets (generation_id);
create index editorial_assets_status_idx     on public.editorial_assets (status);
create index editorial_assets_created_idx    on public.editorial_assets (created_at desc);
-- Partial index: the default UI view is "current assets only".
create index editorial_assets_current_idx
  on public.editorial_assets (created_at desc) where not is_legacy;

create trigger editorial_assets_set_updated_at
  before update on public.editorial_assets
  for each row execute function public.set_updated_at();


-- -----------------------------------------------------------------------------
-- traceability_links (+ join table)
-- -----------------------------------------------------------------------------
-- Legacy stored source_post_ids as a JSON array of raw_post string ids, with no
-- referential integrity. Normalised here into a real join table so the 469
-- post references across 89 links are enforced by the database.
-- -----------------------------------------------------------------------------
create table public.traceability_links (
  id                uuid primary key default gen_random_uuid(),
  asset_id          uuid not null references public.editorial_assets (id) on delete cascade,
  claim_text        text not null,
  confidence        text not null default 'high'
                      check (confidence in ('high', 'medium', 'low')),
  position_in_asset integer not null check (position_in_asset >= 0),
  created_at        timestamptz not null default now()
);

create index traceability_links_asset_idx
  on public.traceability_links (asset_id, position_in_asset);

create table public.traceability_link_posts (
  link_id     uuid not null references public.traceability_links (id) on delete cascade,
  -- RESTRICT: this is an audit trail. A post that an approved asset cites may
  -- not be deleted out from under it, leaving a claim with no evidence.
  raw_post_id uuid not null references public.raw_posts (id) on delete restrict,
  position    integer not null check (position >= 0),

  primary key (link_id, position)
);

comment on table public.traceability_link_posts is
  'Replaces traceability_links.source_post_ids JSON array. PK is (link_id, position) rather '
  'than (link_id, raw_post_id) so a claim may legitimately cite the same post twice.';

create index traceability_link_posts_raw_post_idx
  on public.traceability_link_posts (raw_post_id);


-- -----------------------------------------------------------------------------
-- configurations — the editorial objective, as data
-- -----------------------------------------------------------------------------
-- Exactly one row, id = 'default'. Operators change editorial direction by
-- editing this row and re-running the pipeline; it is not env vars or code.
-- -----------------------------------------------------------------------------
create table public.configurations (
  id                    text primary key default 'default' check (id = 'default'),
  themes                jsonb not null default '[]'::jsonb,

  anonymization_enabled boolean not null default true,
  anonymize_companies   boolean not null default true,
  keep_public_bodies    boolean not null default true,
  company_aliases       jsonb not null default '{}'::jsonb,

  voice_tone            text,
  voice_audience        text,
  voice_style           text,

  min_relevance_score   numeric(5,2) not null default 50
                          check (min_relevance_score >= 0 and min_relevance_score <= 100),

  updated_at            timestamptz not null default now()
);

comment on table public.configurations is
  'Single-row editorial config. The id check constraint enforces exactly one row.';

create trigger configurations_set_updated_at
  before update on public.configurations
  for each row execute function public.set_updated_at();


-- =============================================================================
-- Deliberately NOT created
-- =============================================================================
--   clusters
--     0 rows in legacy, and all 133 analyzed_posts had cluster_id IS NULL.
--     Clustering was reimplemented as a stateless computation that never wrote
--     rows; the table and AnalysisService.cluster_posts were dead weight from
--     the first design. Phase 4 replaces it with pgvector similarity.
--
--   analyzed_posts_backup_before_mock_llm
--     A one-off manual backup. Its per-theme scores are mostly zeros — the
--     fossil of the bare-integer batch prompt bug — while the live table holds
--     properly scored data. Nothing should read it.
-- =============================================================================
