export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  graphql_public: {
    Tables: {
      [_ in never]: never
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      graphql: {
        Args: {
          extensions?: Json
          operationName?: string
          query?: string
          variables?: Json
        }
        Returns: Json
      }
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
  public: {
    Tables: {
      analyzed_posts: {
        Row: {
          created_at: string
          current_result_id: string | null
          entities: Json
          id: string
          included_in_generation: boolean
          key_phrases: Json
          overall_relevance: number
          raw_post_id: string
          reason_for_score: string | null
          relevance_scores: Json
          topics: Json
          updated_at: string
        }
        Insert: {
          created_at?: string
          current_result_id?: string | null
          entities?: Json
          id?: string
          included_in_generation?: boolean
          key_phrases?: Json
          overall_relevance: number
          raw_post_id: string
          reason_for_score?: string | null
          relevance_scores: Json
          topics?: Json
          updated_at?: string
        }
        Update: {
          created_at?: string
          current_result_id?: string | null
          entities?: Json
          id?: string
          included_in_generation?: boolean
          key_phrases?: Json
          overall_relevance?: number
          raw_post_id?: string
          reason_for_score?: string | null
          relevance_scores?: Json
          topics?: Json
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "analyzed_posts_current_result_id_fkey"
            columns: ["current_result_id"]
            isOneToOne: false
            referencedRelation: "scoring_results"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "analyzed_posts_raw_post_id_fkey"
            columns: ["raw_post_id"]
            isOneToOne: true
            referencedRelation: "raw_posts"
            referencedColumns: ["id"]
          },
        ]
      }
      anonymize_dead_letter: {
        Row: {
          attempts: number
          dead_lettered_at: string
          error_code: string | null
          error_message: string | null
          failure_type: string
          id: string
          job_id: string
          provider_response: Json | null
          raw_post_id: string
        }
        Insert: {
          attempts: number
          dead_lettered_at?: string
          error_code?: string | null
          error_message?: string | null
          failure_type: string
          id?: string
          job_id: string
          provider_response?: Json | null
          raw_post_id: string
        }
        Update: {
          attempts?: number
          dead_lettered_at?: string
          error_code?: string | null
          error_message?: string | null
          failure_type?: string
          id?: string
          job_id?: string
          provider_response?: Json | null
          raw_post_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "anonymize_dead_letter_raw_post_id_fkey"
            columns: ["raw_post_id"]
            isOneToOne: false
            referencedRelation: "raw_posts"
            referencedColumns: ["id"]
          },
        ]
      }
      anonymize_job_state: {
        Row: {
          enqueued_at: string
          failure_count: number
          id: string
          last_error_code: string | null
          last_error_message: string | null
          last_failure_type: string | null
          leased_at: string | null
          msg_id: number | null
          next_attempt_at: string | null
          processing_token: string | null
          raw_post_id: string
          status: string
          updated_at: string
        }
        Insert: {
          enqueued_at?: string
          failure_count?: number
          id?: string
          last_error_code?: string | null
          last_error_message?: string | null
          last_failure_type?: string | null
          leased_at?: string | null
          msg_id?: number | null
          next_attempt_at?: string | null
          processing_token?: string | null
          raw_post_id: string
          status?: string
          updated_at?: string
        }
        Update: {
          enqueued_at?: string
          failure_count?: number
          id?: string
          last_error_code?: string | null
          last_error_message?: string | null
          last_failure_type?: string | null
          leased_at?: string | null
          msg_id?: number | null
          next_attempt_at?: string | null
          processing_token?: string | null
          raw_post_id?: string
          status?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "anonymize_job_state_raw_post_id_fkey"
            columns: ["raw_post_id"]
            isOneToOne: false
            referencedRelation: "raw_posts"
            referencedColumns: ["id"]
          },
        ]
      }
      anonymize_results: {
        Row: {
          anonymize_job_id: string | null
          anonymized_text: string
          config_hash: string
          config_snapshot: Json
          created_at: string
          entity_extraction_used: boolean
          generalized_source_name: string
          id: string
          idempotency_key: string
          overall_relevance: number
          provider_response: Json | null
          raw_post_id: string
          replacements: Json
          source_name: string
        }
        Insert: {
          anonymize_job_id?: string | null
          anonymized_text: string
          config_hash: string
          config_snapshot?: Json
          created_at?: string
          entity_extraction_used: boolean
          generalized_source_name: string
          id?: string
          idempotency_key: string
          overall_relevance: number
          provider_response?: Json | null
          raw_post_id: string
          replacements?: Json
          source_name: string
        }
        Update: {
          anonymize_job_id?: string | null
          anonymized_text?: string
          config_hash?: string
          config_snapshot?: Json
          created_at?: string
          entity_extraction_used?: boolean
          generalized_source_name?: string
          id?: string
          idempotency_key?: string
          overall_relevance?: number
          provider_response?: Json | null
          raw_post_id?: string
          replacements?: Json
          source_name?: string
        }
        Relationships: [
          {
            foreignKeyName: "anonymize_results_raw_post_id_fkey"
            columns: ["raw_post_id"]
            isOneToOne: false
            referencedRelation: "raw_posts"
            referencedColumns: ["id"]
          },
        ]
      }
      anonymized_posts_current: {
        Row: {
          anonymized_text: string
          config_snapshot: Json
          current_result_id: string | null
          generalized_source_name: string
          overall_relevance: number
          raw_post_id: string
          replacements: Json
          source_name: string
          updated_at: string
        }
        Insert: {
          anonymized_text: string
          config_snapshot?: Json
          current_result_id?: string | null
          generalized_source_name: string
          overall_relevance: number
          raw_post_id: string
          replacements?: Json
          source_name: string
          updated_at?: string
        }
        Update: {
          anonymized_text?: string
          config_snapshot?: Json
          current_result_id?: string | null
          generalized_source_name?: string
          overall_relevance?: number
          raw_post_id?: string
          replacements?: Json
          source_name?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "anonymized_posts_current_current_result_id_fkey"
            columns: ["current_result_id"]
            isOneToOne: false
            referencedRelation: "anonymize_results"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "anonymized_posts_current_raw_post_id_fkey"
            columns: ["raw_post_id"]
            isOneToOne: true
            referencedRelation: "raw_posts"
            referencedColumns: ["id"]
          },
        ]
      }
      brand_suggestions: {
        Row: {
          created_at: string
          decided_at: string | null
          decided_by: string | null
          id: string
          name: string
          rationale: string | null
          source_id: string
          status: string
        }
        Insert: {
          created_at?: string
          decided_at?: string | null
          decided_by?: string | null
          id?: string
          name: string
          rationale?: string | null
          source_id: string
          status?: string
        }
        Update: {
          created_at?: string
          decided_at?: string | null
          decided_by?: string | null
          id?: string
          name?: string
          rationale?: string | null
          source_id?: string
          status?: string
        }
        Relationships: [
          {
            foreignKeyName: "brand_suggestions_source_id_fkey"
            columns: ["source_id"]
            isOneToOne: false
            referencedRelation: "sources"
            referencedColumns: ["id"]
          },
        ]
      }
      cluster_assignments: {
        Row: {
          cluster_id: string
          clustering_run_id: string
          raw_post_id: string
        }
        Insert: {
          cluster_id: string
          clustering_run_id: string
          raw_post_id: string
        }
        Update: {
          cluster_id?: string
          clustering_run_id?: string
          raw_post_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "cluster_assignments_cluster_id_fkey"
            columns: ["cluster_id"]
            isOneToOne: false
            referencedRelation: "clusters"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "cluster_assignments_post_in_run_input"
            columns: ["clustering_run_id", "raw_post_id"]
            isOneToOne: true
            referencedRelation: "clustering_run_posts"
            referencedColumns: ["clustering_run_id", "raw_post_id"]
          },
        ]
      }
      cluster_generation_request_errors: {
        Row: {
          cluster_id: string
          created_at: string
          error_message: string
          error_type: string
          generation_request_id: string
          id: string
        }
        Insert: {
          cluster_id: string
          created_at?: string
          error_message: string
          error_type: string
          generation_request_id: string
          id?: string
        }
        Update: {
          cluster_id?: string
          created_at?: string
          error_message?: string
          error_type?: string
          generation_request_id?: string
          id?: string
        }
        Relationships: [
          {
            foreignKeyName: "cluster_generation_request_errors_generation_request_id_fkey"
            columns: ["generation_request_id"]
            isOneToOne: false
            referencedRelation: "cluster_generation_requests"
            referencedColumns: ["id"]
          },
        ]
      }
      cluster_generation_requests: {
        Row: {
          clustering_run_id: string
          completed_at: string | null
          created_at: string
          created_by: string | null
          error_message: string | null
          id: string
          output_types: string[]
          requested_cluster_ids: string[]
          status: string
        }
        Insert: {
          clustering_run_id: string
          completed_at?: string | null
          created_at?: string
          created_by?: string | null
          error_message?: string | null
          id?: string
          output_types: string[]
          requested_cluster_ids: string[]
          status?: string
        }
        Update: {
          clustering_run_id?: string
          completed_at?: string | null
          created_at?: string
          created_by?: string | null
          error_message?: string | null
          id?: string
          output_types?: string[]
          requested_cluster_ids?: string[]
          status?: string
        }
        Relationships: [
          {
            foreignKeyName: "cluster_generation_requests_clustering_run_id_fkey"
            columns: ["clustering_run_id"]
            isOneToOne: false
            referencedRelation: "clustering_runs"
            referencedColumns: ["id"]
          },
        ]
      }
      cluster_generation_results: {
        Row: {
          anonymize_result_ids: string[]
          carousel_output: Json | null
          cluster_id: string
          cluster_label: string
          clustering_run_id: string
          config_snapshot: Json
          created_at: string
          generation_request_id: string
          id: string
          model: string
          output_types: string[]
          post_output: Json | null
          prompt_hash: string
          prompt_version: string
          provider_response: Json | null
          raw_post_ids: string[]
        }
        Insert: {
          anonymize_result_ids: string[]
          carousel_output?: Json | null
          cluster_id: string
          cluster_label: string
          clustering_run_id: string
          config_snapshot: Json
          created_at?: string
          generation_request_id: string
          id?: string
          model: string
          output_types: string[]
          post_output?: Json | null
          prompt_hash: string
          prompt_version: string
          provider_response?: Json | null
          raw_post_ids: string[]
        }
        Update: {
          anonymize_result_ids?: string[]
          carousel_output?: Json | null
          cluster_id?: string
          cluster_label?: string
          clustering_run_id?: string
          config_snapshot?: Json
          created_at?: string
          generation_request_id?: string
          id?: string
          model?: string
          output_types?: string[]
          post_output?: Json | null
          prompt_hash?: string
          prompt_version?: string
          provider_response?: Json | null
          raw_post_ids?: string[]
        }
        Relationships: [
          {
            foreignKeyName: "cluster_generation_results_cluster_id_fkey"
            columns: ["cluster_id"]
            isOneToOne: false
            referencedRelation: "clusters"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "cluster_generation_results_clustering_run_id_fkey"
            columns: ["clustering_run_id"]
            isOneToOne: false
            referencedRelation: "clustering_runs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "cluster_generation_results_generation_request_id_fkey"
            columns: ["generation_request_id"]
            isOneToOne: false
            referencedRelation: "cluster_generation_requests"
            referencedColumns: ["id"]
          },
        ]
      }
      cluster_generation_reviews: {
        Row: {
          approval_notes: string | null
          approval_timestamp: string | null
          approved_by: string | null
          created_at: string
          edited_output: Json | null
          output_type: string
          result_id: string
          status: string
          updated_at: string
        }
        Insert: {
          approval_notes?: string | null
          approval_timestamp?: string | null
          approved_by?: string | null
          created_at?: string
          edited_output?: Json | null
          output_type: string
          result_id: string
          status?: string
          updated_at?: string
        }
        Update: {
          approval_notes?: string | null
          approval_timestamp?: string | null
          approved_by?: string | null
          created_at?: string
          edited_output?: Json | null
          output_type?: string
          result_id?: string
          status?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "cluster_generation_reviews_result_id_fkey"
            columns: ["result_id"]
            isOneToOne: false
            referencedRelation: "cluster_generation_results"
            referencedColumns: ["id"]
          },
        ]
      }
      clustering_run_posts: {
        Row: {
          anonymize_result_id: string
          clustering_run_id: string
          embedding_error_message: string | null
          embedding_outcome_at: string | null
          embedding_status: string
          raw_post_id: string
        }
        Insert: {
          anonymize_result_id: string
          clustering_run_id: string
          embedding_error_message?: string | null
          embedding_outcome_at?: string | null
          embedding_status?: string
          raw_post_id: string
        }
        Update: {
          anonymize_result_id?: string
          clustering_run_id?: string
          embedding_error_message?: string | null
          embedding_outcome_at?: string | null
          embedding_status?: string
          raw_post_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "clustering_run_posts_clustering_run_id_fkey"
            columns: ["clustering_run_id"]
            isOneToOne: false
            referencedRelation: "clustering_runs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "clustering_run_posts_raw_post_id_fkey"
            columns: ["raw_post_id"]
            isOneToOne: false
            referencedRelation: "raw_posts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "clustering_run_posts_result_matches_post"
            columns: ["anonymize_result_id", "raw_post_id"]
            isOneToOne: false
            referencedRelation: "anonymize_results"
            referencedColumns: ["id", "raw_post_id"]
          },
        ]
      }
      clustering_runs: {
        Row: {
          cluster_similarity_threshold: number
          completed_at: string | null
          created_at: string
          created_by: string | null
          embedding_model: string
          error_message: string | null
          id: string
          min_cluster_size: number
          min_relevance_score: number
          period_end: string
          period_start: string
          status: string
        }
        Insert: {
          cluster_similarity_threshold: number
          completed_at?: string | null
          created_at?: string
          created_by?: string | null
          embedding_model: string
          error_message?: string | null
          id?: string
          min_cluster_size: number
          min_relevance_score: number
          period_end: string
          period_start: string
          status?: string
        }
        Update: {
          cluster_similarity_threshold?: number
          completed_at?: string | null
          created_at?: string
          created_by?: string | null
          embedding_model?: string
          error_message?: string | null
          id?: string
          min_cluster_size?: number
          min_relevance_score?: number
          period_end?: string
          period_start?: string
          status?: string
        }
        Relationships: []
      }
      clusters: {
        Row: {
          centroid: string | null
          clustering_run_id: string
          created_at: string
          id: string
          label: string
          label_failed: boolean
          post_count: number
        }
        Insert: {
          centroid?: string | null
          clustering_run_id: string
          created_at?: string
          id?: string
          label: string
          label_failed?: boolean
          post_count: number
        }
        Update: {
          centroid?: string | null
          clustering_run_id?: string
          created_at?: string
          id?: string
          label?: string
          label_failed?: boolean
          post_count?: number
        }
        Relationships: [
          {
            foreignKeyName: "clusters_clustering_run_id_fkey"
            columns: ["clustering_run_id"]
            isOneToOne: false
            referencedRelation: "clustering_runs"
            referencedColumns: ["id"]
          },
        ]
      }
      configurations: {
        Row: {
          anonymization_enabled: boolean
          anonymize_companies: boolean
          cluster_similarity_threshold: number
          company_aliases: Json
          domain_generic_entity: string
          domain_generic_entity_alt: string
          editorial_domain: string
          id: string
          keep_public_bodies: boolean
          min_cluster_size: number
          min_relevance_score: number
          themes: Json
          updated_at: string
          voice_audience: string | null
          voice_style: string | null
          voice_tone: string | null
        }
        Insert: {
          anonymization_enabled?: boolean
          anonymize_companies?: boolean
          cluster_similarity_threshold?: number
          company_aliases?: Json
          domain_generic_entity?: string
          domain_generic_entity_alt?: string
          editorial_domain?: string
          id?: string
          keep_public_bodies?: boolean
          min_cluster_size?: number
          min_relevance_score?: number
          themes?: Json
          updated_at?: string
          voice_audience?: string | null
          voice_style?: string | null
          voice_tone?: string | null
        }
        Update: {
          anonymization_enabled?: boolean
          anonymize_companies?: boolean
          cluster_similarity_threshold?: number
          company_aliases?: Json
          domain_generic_entity?: string
          domain_generic_entity_alt?: string
          editorial_domain?: string
          id?: string
          keep_public_bodies?: boolean
          min_cluster_size?: number
          min_relevance_score?: number
          themes?: Json
          updated_at?: string
          voice_audience?: string | null
          voice_style?: string | null
          voice_tone?: string | null
        }
        Relationships: []
      }
      editorial_assets: {
        Row: {
          approval_notes: string | null
          approval_timestamp: string | null
          approved_by: string | null
          asset_type: string
          created_at: string
          cta_text: string | null
          edits_made: Json
          featured_clusters: Json
          featured_sources: Json
          feedback_provided: string | null
          generated_text: string
          generation_id: string
          hashtags: Json
          id: string
          is_legacy: boolean
          llm_used: boolean | null
          provenance: string
          regenerated_from: string | null
          status: string
          title: string | null
          updated_at: string
          variant_number: number
        }
        Insert: {
          approval_notes?: string | null
          approval_timestamp?: string | null
          approved_by?: string | null
          asset_type: string
          created_at?: string
          cta_text?: string | null
          edits_made?: Json
          featured_clusters?: Json
          featured_sources?: Json
          feedback_provided?: string | null
          generated_text: string
          generation_id: string
          hashtags?: Json
          id?: string
          is_legacy?: boolean
          llm_used?: boolean | null
          provenance?: string
          regenerated_from?: string | null
          status?: string
          title?: string | null
          updated_at?: string
          variant_number?: number
        }
        Update: {
          approval_notes?: string | null
          approval_timestamp?: string | null
          approved_by?: string | null
          asset_type?: string
          created_at?: string
          cta_text?: string | null
          edits_made?: Json
          featured_clusters?: Json
          featured_sources?: Json
          feedback_provided?: string | null
          generated_text?: string
          generation_id?: string
          hashtags?: Json
          id?: string
          is_legacy?: boolean
          llm_used?: boolean | null
          provenance?: string
          regenerated_from?: string | null
          status?: string
          title?: string | null
          updated_at?: string
          variant_number?: number
        }
        Relationships: [
          {
            foreignKeyName: "editorial_assets_generation_id_fkey"
            columns: ["generation_id"]
            isOneToOne: false
            referencedRelation: "generation_requests"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "editorial_assets_regenerated_from_fkey"
            columns: ["regenerated_from"]
            isOneToOne: false
            referencedRelation: "editorial_assets"
            referencedColumns: ["id"]
          },
        ]
      }
      editors: {
        Row: {
          created_at: string
          email: string
          full_name: string | null
          role: string
          user_id: string
        }
        Insert: {
          created_at?: string
          email: string
          full_name?: string | null
          role?: string
          user_id: string
        }
        Update: {
          created_at?: string
          email?: string
          full_name?: string | null
          role?: string
          user_id?: string
        }
        Relationships: []
      }
      generation_requests: {
        Row: {
          collection_period_end: string
          collection_period_start: string
          created_at: string
          created_by: string | null
          error_message: string | null
          generation_type: string
          id: string
          selected_sources: Json
          status: string
          updated_at: string
          user_instructions: string | null
        }
        Insert: {
          collection_period_end: string
          collection_period_start: string
          created_at?: string
          created_by?: string | null
          error_message?: string | null
          generation_type: string
          id?: string
          selected_sources?: Json
          status?: string
          updated_at?: string
          user_instructions?: string | null
        }
        Update: {
          collection_period_end?: string
          collection_period_start?: string
          created_at?: string
          created_by?: string | null
          error_message?: string | null
          generation_type?: string
          id?: string
          selected_sources?: Json
          status?: string
          updated_at?: string
          user_instructions?: string | null
        }
        Relationships: []
      }
      ingest_run_sources: {
        Row: {
          error_code: string | null
          error_message: string | null
          finished_at: string | null
          http_status: number | null
          id: string
          pages_fetched: number
          posts_content_changed: number
          posts_fetched: number
          posts_inserted: number
          posts_metadata_refreshed: number
          posts_skipped_duplicate: number
          posts_skipped_malformed: number
          posts_skipped_no_id: number
          posts_skipped_out_of_window: number
          provider_requests: number
          rapidapi_identifier: string | null
          retry_after_seconds: number | null
          run_id: string
          source_id: string
          source_name: string
          started_at: string
          status: string
          truncated: boolean
        }
        Insert: {
          error_code?: string | null
          error_message?: string | null
          finished_at?: string | null
          http_status?: number | null
          id?: string
          pages_fetched?: number
          posts_content_changed?: number
          posts_fetched?: number
          posts_inserted?: number
          posts_metadata_refreshed?: number
          posts_skipped_duplicate?: number
          posts_skipped_malformed?: number
          posts_skipped_no_id?: number
          posts_skipped_out_of_window?: number
          provider_requests?: number
          rapidapi_identifier?: string | null
          retry_after_seconds?: number | null
          run_id: string
          source_id: string
          source_name: string
          started_at?: string
          status?: string
          truncated?: boolean
        }
        Update: {
          error_code?: string | null
          error_message?: string | null
          finished_at?: string | null
          http_status?: number | null
          id?: string
          pages_fetched?: number
          posts_content_changed?: number
          posts_fetched?: number
          posts_inserted?: number
          posts_metadata_refreshed?: number
          posts_skipped_duplicate?: number
          posts_skipped_malformed?: number
          posts_skipped_no_id?: number
          posts_skipped_out_of_window?: number
          provider_requests?: number
          rapidapi_identifier?: string | null
          retry_after_seconds?: number | null
          run_id?: string
          source_id?: string
          source_name?: string
          started_at?: string
          status?: string
          truncated?: boolean
        }
        Relationships: [
          {
            foreignKeyName: "ingest_run_sources_run_id_fkey"
            columns: ["run_id"]
            isOneToOne: false
            referencedRelation: "ingest_runs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "ingest_run_sources_source_id_fkey"
            columns: ["source_id"]
            isOneToOne: false
            referencedRelation: "sources"
            referencedColumns: ["id"]
          },
        ]
      }
      ingest_runs: {
        Row: {
          dry_run: boolean
          error: string | null
          finished_at: string | null
          id: string
          lookback_days_override: number | null
          pages_fetched: number
          posts_content_changed: number
          posts_fetched: number
          posts_inserted: number
          posts_metadata_refreshed: number
          posts_skipped_duplicate: number
          posts_skipped_malformed: number
          posts_skipped_no_id: number
          posts_skipped_out_of_window: number
          provider_requests: number
          requested_source_ids: Json
          sources_failed: number
          sources_ok: number
          sources_skipped: number
          sources_total: number
          started_at: string
          status: string
          trigger_source: string
          triggered_by: string | null
          triggered_by_email: string | null
        }
        Insert: {
          dry_run?: boolean
          error?: string | null
          finished_at?: string | null
          id?: string
          lookback_days_override?: number | null
          pages_fetched?: number
          posts_content_changed?: number
          posts_fetched?: number
          posts_inserted?: number
          posts_metadata_refreshed?: number
          posts_skipped_duplicate?: number
          posts_skipped_malformed?: number
          posts_skipped_no_id?: number
          posts_skipped_out_of_window?: number
          provider_requests?: number
          requested_source_ids?: Json
          sources_failed?: number
          sources_ok?: number
          sources_skipped?: number
          sources_total?: number
          started_at?: string
          status?: string
          trigger_source: string
          triggered_by?: string | null
          triggered_by_email?: string | null
        }
        Update: {
          dry_run?: boolean
          error?: string | null
          finished_at?: string | null
          id?: string
          lookback_days_override?: number | null
          pages_fetched?: number
          posts_content_changed?: number
          posts_fetched?: number
          posts_inserted?: number
          posts_metadata_refreshed?: number
          posts_skipped_duplicate?: number
          posts_skipped_malformed?: number
          posts_skipped_no_id?: number
          posts_skipped_out_of_window?: number
          provider_requests?: number
          requested_source_ids?: Json
          sources_failed?: number
          sources_ok?: number
          sources_skipped?: number
          sources_total?: number
          started_at?: string
          status?: string
          trigger_source?: string
          triggered_by?: string | null
          triggered_by_email?: string | null
        }
        Relationships: []
      }
      normalized_posts: {
        Row: {
          clean_text: string
          created_at: string
          extracted_hashtags: Json
          extracted_mentions: Json
          id: string
          language: string
          raw_post_id: string
          tone_type: string | null
          word_count: number
        }
        Insert: {
          clean_text: string
          created_at?: string
          extracted_hashtags?: Json
          extracted_mentions?: Json
          id?: string
          language?: string
          raw_post_id: string
          tone_type?: string | null
          word_count: number
        }
        Update: {
          clean_text?: string
          created_at?: string
          extracted_hashtags?: Json
          extracted_mentions?: Json
          id?: string
          language?: string
          raw_post_id?: string
          tone_type?: string | null
          word_count?: number
        }
        Relationships: [
          {
            foreignKeyName: "normalized_posts_raw_post_id_fkey"
            columns: ["raw_post_id"]
            isOneToOne: true
            referencedRelation: "raw_posts"
            referencedColumns: ["id"]
          },
        ]
      }
      post_embeddings: {
        Row: {
          anonymize_result_id: string
          created_at: string
          embedding: string
          model: string
          raw_post_id: string
        }
        Insert: {
          anonymize_result_id: string
          created_at?: string
          embedding: string
          model: string
          raw_post_id: string
        }
        Update: {
          anonymize_result_id?: string
          created_at?: string
          embedding?: string
          model?: string
          raw_post_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "post_embeddings_result_matches_post"
            columns: ["anonymize_result_id", "raw_post_id"]
            isOneToOne: false
            referencedRelation: "anonymize_results"
            referencedColumns: ["id", "raw_post_id"]
          },
        ]
      }
      raw_post_content_changes: {
        Row: {
          first_observed_at: string
          id: string
          last_observed_at: string
          observation_count: number
          observed_content_hash: string
          observed_post_text: string
          raw_post_id: string
          resolution: string | null
          resolved_at: string | null
          run_id: string | null
          stored_content_hash: string
        }
        Insert: {
          first_observed_at?: string
          id?: string
          last_observed_at?: string
          observation_count?: number
          observed_content_hash: string
          observed_post_text: string
          raw_post_id: string
          resolution?: string | null
          resolved_at?: string | null
          run_id?: string | null
          stored_content_hash: string
        }
        Update: {
          first_observed_at?: string
          id?: string
          last_observed_at?: string
          observation_count?: number
          observed_content_hash?: string
          observed_post_text?: string
          raw_post_id?: string
          resolution?: string | null
          resolved_at?: string | null
          run_id?: string | null
          stored_content_hash?: string
        }
        Relationships: [
          {
            foreignKeyName: "raw_post_content_changes_raw_post_id_fkey"
            columns: ["raw_post_id"]
            isOneToOne: false
            referencedRelation: "raw_posts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "raw_post_content_changes_run_id_fkey"
            columns: ["run_id"]
            isOneToOne: false
            referencedRelation: "ingest_runs"
            referencedColumns: ["id"]
          },
        ]
      }
      raw_posts: {
        Row: {
          author: string | null
          canonical_url: string | null
          collected_at: string
          content_hash: string | null
          created_at: string
          engagement_metrics: Json
          external_post_id: string | null
          id: string
          is_processed: boolean
          last_seen_at: string
          legacy_id: string | null
          media_urls: Json
          post_text: string
          post_title: string | null
          published_at: string
          source_id: string
          source_url: string
          updated_at: string
        }
        Insert: {
          author?: string | null
          canonical_url?: string | null
          collected_at?: string
          content_hash?: string | null
          created_at?: string
          engagement_metrics?: Json
          external_post_id?: string | null
          id?: string
          is_processed?: boolean
          last_seen_at?: string
          legacy_id?: string | null
          media_urls?: Json
          post_text: string
          post_title?: string | null
          published_at: string
          source_id: string
          source_url: string
          updated_at?: string
        }
        Update: {
          author?: string | null
          canonical_url?: string | null
          collected_at?: string
          content_hash?: string | null
          created_at?: string
          engagement_metrics?: Json
          external_post_id?: string | null
          id?: string
          is_processed?: boolean
          last_seen_at?: string
          legacy_id?: string | null
          media_urls?: Json
          post_text?: string
          post_title?: string | null
          published_at?: string
          source_id?: string
          source_url?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "raw_posts_source_id_fkey"
            columns: ["source_id"]
            isOneToOne: false
            referencedRelation: "sources"
            referencedColumns: ["id"]
          },
        ]
      }
      scoring_dead_letter: {
        Row: {
          attempts: number
          dead_lettered_at: string
          error_code: string | null
          error_message: string | null
          failure_type: string
          id: string
          job_id: string
          provider_response: Json | null
          raw_post_id: string
          scoring_request_id: string
        }
        Insert: {
          attempts: number
          dead_lettered_at?: string
          error_code?: string | null
          error_message?: string | null
          failure_type: string
          id?: string
          job_id: string
          provider_response?: Json | null
          raw_post_id: string
          scoring_request_id: string
        }
        Update: {
          attempts?: number
          dead_lettered_at?: string
          error_code?: string | null
          error_message?: string | null
          failure_type?: string
          id?: string
          job_id?: string
          provider_response?: Json | null
          raw_post_id?: string
          scoring_request_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "scoring_dead_letter_raw_post_id_fkey"
            columns: ["raw_post_id"]
            isOneToOne: false
            referencedRelation: "raw_posts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "scoring_dead_letter_scoring_request_id_fkey"
            columns: ["scoring_request_id"]
            isOneToOne: false
            referencedRelation: "scoring_requests"
            referencedColumns: ["id"]
          },
        ]
      }
      scoring_job_state: {
        Row: {
          enqueued_at: string
          failure_count: number
          id: string
          last_error_code: string | null
          last_error_message: string | null
          last_failure_type: string | null
          leased_at: string | null
          msg_id: number | null
          next_attempt_at: string | null
          processing_token: string | null
          raw_post_id: string
          scoring_request_id: string
          status: string
          updated_at: string
        }
        Insert: {
          enqueued_at?: string
          failure_count?: number
          id?: string
          last_error_code?: string | null
          last_error_message?: string | null
          last_failure_type?: string | null
          leased_at?: string | null
          msg_id?: number | null
          next_attempt_at?: string | null
          processing_token?: string | null
          raw_post_id: string
          scoring_request_id: string
          status?: string
          updated_at?: string
        }
        Update: {
          enqueued_at?: string
          failure_count?: number
          id?: string
          last_error_code?: string | null
          last_error_message?: string | null
          last_failure_type?: string | null
          leased_at?: string | null
          msg_id?: number | null
          next_attempt_at?: string | null
          processing_token?: string | null
          raw_post_id?: string
          scoring_request_id?: string
          status?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "scoring_job_state_raw_post_id_fkey"
            columns: ["raw_post_id"]
            isOneToOne: false
            referencedRelation: "raw_posts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "scoring_job_state_scoring_request_id_fkey"
            columns: ["scoring_request_id"]
            isOneToOne: false
            referencedRelation: "scoring_requests"
            referencedColumns: ["id"]
          },
        ]
      }
      scoring_requests: {
        Row: {
          aggregation_strategy: string
          config_hash: string
          config_snapshot: Json
          created_at: string
          id: string
          model: string
          model_snapshot: string
          prompt_hash: string
          prompt_template: string
          prompt_version: string
          purpose: string
          status: string
        }
        Insert: {
          aggregation_strategy: string
          config_hash: string
          config_snapshot: Json
          created_at?: string
          id?: string
          model: string
          model_snapshot: string
          prompt_hash: string
          prompt_template: string
          prompt_version: string
          purpose: string
          status?: string
        }
        Update: {
          aggregation_strategy?: string
          config_hash?: string
          config_snapshot?: Json
          created_at?: string
          id?: string
          model?: string
          model_snapshot?: string
          prompt_hash?: string
          prompt_template?: string
          prompt_version?: string
          purpose?: string
          status?: string
        }
        Relationships: []
      }
      scoring_results: {
        Row: {
          aggregation_strategy: string
          config_hash: string
          config_snapshot: Json
          created_at: string
          id: string
          idempotency_key: string
          included_in_generation: boolean
          llm_used: boolean
          model: string | null
          model_snapshot: string | null
          overall_relevance: number
          prompt_version: string | null
          provenance_status: string
          provider_response: Json | null
          raw_post_id: string
          reason: string | null
          scoring_job_id: string | null
          scoring_request_id: string | null
          source: string
          theme_scores: Json
        }
        Insert: {
          aggregation_strategy: string
          config_hash: string
          config_snapshot: Json
          created_at?: string
          id?: string
          idempotency_key: string
          included_in_generation: boolean
          llm_used: boolean
          model?: string | null
          model_snapshot?: string | null
          overall_relevance: number
          prompt_version?: string | null
          provenance_status: string
          provider_response?: Json | null
          raw_post_id: string
          reason?: string | null
          scoring_job_id?: string | null
          scoring_request_id?: string | null
          source: string
          theme_scores: Json
        }
        Update: {
          aggregation_strategy?: string
          config_hash?: string
          config_snapshot?: Json
          created_at?: string
          id?: string
          idempotency_key?: string
          included_in_generation?: boolean
          llm_used?: boolean
          model?: string | null
          model_snapshot?: string | null
          overall_relevance?: number
          prompt_version?: string | null
          provenance_status?: string
          provider_response?: Json | null
          raw_post_id?: string
          reason?: string | null
          scoring_job_id?: string | null
          scoring_request_id?: string | null
          source?: string
          theme_scores?: Json
        }
        Relationships: [
          {
            foreignKeyName: "scoring_results_raw_post_id_fkey"
            columns: ["raw_post_id"]
            isOneToOne: false
            referencedRelation: "raw_posts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "scoring_results_scoring_request_id_fkey"
            columns: ["scoring_request_id"]
            isOneToOne: false
            referencedRelation: "scoring_requests"
            referencedColumns: ["id"]
          },
        ]
      }
      scoring_themes: {
        Row: {
          active: boolean
          created_at: string
          label: string
          position: number
          theme_id: string
        }
        Insert: {
          active?: boolean
          created_at?: string
          label: string
          position: number
          theme_id: string
        }
        Update: {
          active?: boolean
          created_at?: string
          label?: string
          position?: number
          theme_id?: string
        }
        Relationships: []
      }
      sources: {
        Row: {
          collection_frequency: string
          company_name: string | null
          created_at: string
          enabled: boolean
          id: string
          last_fetched_at: string | null
          lookback_days: number
          name: string
          rapidapi_identifier: string | null
          source_type: string
          updated_at: string
          url: string
        }
        Insert: {
          collection_frequency?: string
          company_name?: string | null
          created_at?: string
          enabled?: boolean
          id?: string
          last_fetched_at?: string | null
          lookback_days?: number
          name: string
          rapidapi_identifier?: string | null
          source_type?: string
          updated_at?: string
          url: string
        }
        Update: {
          collection_frequency?: string
          company_name?: string | null
          created_at?: string
          enabled?: boolean
          id?: string
          last_fetched_at?: string | null
          lookback_days?: number
          name?: string
          rapidapi_identifier?: string | null
          source_type?: string
          updated_at?: string
          url?: string
        }
        Relationships: []
      }
      traceability_link_posts: {
        Row: {
          link_id: string
          position: number
          raw_post_id: string
        }
        Insert: {
          link_id: string
          position: number
          raw_post_id: string
        }
        Update: {
          link_id?: string
          position?: number
          raw_post_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "traceability_link_posts_link_id_fkey"
            columns: ["link_id"]
            isOneToOne: false
            referencedRelation: "traceability_links"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "traceability_link_posts_raw_post_id_fkey"
            columns: ["raw_post_id"]
            isOneToOne: false
            referencedRelation: "raw_posts"
            referencedColumns: ["id"]
          },
        ]
      }
      traceability_links: {
        Row: {
          asset_id: string
          claim_text: string
          confidence: string
          created_at: string
          id: string
          position_in_asset: number
        }
        Insert: {
          asset_id: string
          claim_text: string
          confidence?: string
          created_at?: string
          id?: string
          position_in_asset: number
        }
        Update: {
          asset_id?: string
          claim_text?: string
          confidence?: string
          created_at?: string
          id?: string
          position_in_asset?: number
        }
        Relationships: [
          {
            foreignKeyName: "traceability_links_asset_id_fkey"
            columns: ["asset_id"]
            isOneToOne: false
            referencedRelation: "editorial_assets"
            referencedColumns: ["id"]
          },
        ]
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      accept_brand_suggestion: { Args: { p_id: string }; Returns: undefined }
      activate_scoring_request: {
        Args: { p_request_id: string }
        Returns: undefined
      }
      backfill_anonymize_jobs: {
        Args: { p_min_relevance?: number }
        Returns: number
      }
      backfill_scoring_for_request: {
        Args: { p_request_id: string }
        Returns: number
      }
      cancel_scoring_request_siblings: {
        Args: {
          p_reason?: string
          p_scoring_request_id: string
          p_triggering_job_id: string
        }
        Returns: number
      }
      claim_source_for_ingest: {
        Args: {
          p_identifier: string
          p_run_id: string
          p_source_id: string
          p_source_name: string
          p_stale_after?: string
        }
        Returns: boolean
      }
      close_scoring_request: {
        Args: { p_request_id: string }
        Returns: undefined
      }
      complete_and_promote_scoring_job: {
        Args: {
          p_job_id: string
          p_msg_id: number
          p_processing_token?: string
          p_provider_response?: Json
          p_raw_post_id: string
          p_reason: string
          p_scoring_request_id: string
          p_theme_scores: Json
        }
        Returns: string
      }
      complete_anonymize_job: {
        Args: {
          p_anonymized_text: string
          p_config_snapshot: Json
          p_entity_extraction_used: boolean
          p_generalized_source_name: string
          p_job_id: string
          p_msg_id: number
          p_processing_token?: string
          p_provider_response?: Json
          p_raw_post_id: string
          p_replacements: Json
        }
        Returns: string
      }
      complete_cluster_generation_result: {
        Args: {
          p_anonymize_result_ids: string[]
          p_carousel_output: Json
          p_cluster_id: string
          p_cluster_label: string
          p_config_snapshot: Json
          p_model: string
          p_output_types: string[]
          p_post_output: Json
          p_prompt_hash: string
          p_prompt_version: string
          p_provider_response?: Json
          p_raw_post_ids: string[]
          p_request_id: string
        }
        Returns: string
      }
      complete_clustering_run: {
        Args: { p_clusters: Json; p_run_id: string }
        Returns: undefined
      }
      complete_scoring_job: {
        Args: {
          p_job_id: string
          p_msg_id: number
          p_processing_token?: string
          p_provider_response?: Json
          p_raw_post_id: string
          p_reason: string
          p_scoring_request_id: string
          p_theme_scores: Json
        }
        Returns: string
      }
      create_cluster_generation_request: {
        Args: {
          p_clustering_run_id: string
          p_output_types: string[]
          p_requested_cluster_ids: string[]
        }
        Returns: string
      }
      create_clustering_run: {
        Args: {
          p_cluster_similarity_threshold: number
          p_embedding_model: string
          p_min_cluster_size: number
          p_min_relevance_score: number
          p_period_end: string
          p_period_start: string
        }
        Returns: string
      }
      create_scoring_request: {
        Args: {
          p_aggregation_strategy: string
          p_config_snapshot: Json
          p_model: string
          p_model_snapshot: string
          p_prompt_hash: string
          p_prompt_template?: string
          p_prompt_version: string
          p_purpose: string
        }
        Returns: string
      }
      dead_letter_anonymize_job: {
        Args: {
          p_attempts: number
          p_error_code: string
          p_error_message: string
          p_failure_type: string
          p_job_id: string
          p_msg_id: number
          p_provider_response: Json
          p_raw_post_id: string
        }
        Returns: undefined
      }
      dead_letter_scoring_job: {
        Args: {
          p_attempts: number
          p_error_code: string
          p_error_message: string
          p_failure_type: string
          p_job_id: string
          p_msg_id: number
          p_provider_response: Json
          p_raw_post_id: string
          p_scoring_request_id: string
        }
        Returns: undefined
      }
      enqueue_reevaluation: { Args: { p_request_id: string }; Returns: number }
      enqueue_scoring_job: {
        Args: { p_raw_post_id: string; p_scoring_request_id: string }
        Returns: string
      }
      fail_clustering_run: {
        Args: { p_error_message: string; p_run_id: string }
        Returns: undefined
      }
      finalize_ingest_run: { Args: { p_run_id: string }; Returns: string }
      finish_cluster_generation_request: {
        Args: { p_request_id: string }
        Returns: string
      }
      import_legacy_analyses: { Args: never; Returns: number }
      is_editor: { Args: never; Returns: boolean }
      open_production_scoring_request: {
        Args: {
          p_aggregation_strategy: string
          p_config_snapshot: Json
          p_model: string
          p_model_snapshot: string
          p_prompt_hash: string
          p_prompt_version: string
        }
        Returns: string
      }
      read_anonymize_jobs: {
        Args: { p_qty: number; p_vt: number }
        Returns: {
          message: Json
          msg_id: number
          processing_token: string
        }[]
      }
      read_scoring_jobs: {
        Args: { p_qty: number; p_vt: number }
        Returns: {
          message: Json
          msg_id: number
          processing_token: string
        }[]
      }
      reap_stale_ingest: {
        Args: { p_stale_after?: string }
        Returns: {
          finalized_runs: number
          reaped_sources: number
        }[]
      }
      record_anonymize_failure: {
        Args: {
          p_error_code: string
          p_error_message: string
          p_failure_type: string
          p_job_id: string
          p_msg_id: number
          p_processing_token?: string
          p_provider_response?: Json
          p_raw_post_id: string
        }
        Returns: string
      }
      record_cluster_generation_error: {
        Args: {
          p_cluster_id: string
          p_error_message: string
          p_error_type: string
          p_request_id: string
        }
        Returns: undefined
      }
      record_clustering_run_input: {
        Args: { p_input: Json; p_run_id: string }
        Returns: number
      }
      record_content_change: {
        Args: {
          p_observed_text: string
          p_raw_post_id: string
          p_run_id: string
        }
        Returns: boolean
      }
      record_embedding_outcome: {
        Args: {
          p_error_message?: string
          p_raw_post_id: string
          p_run_id: string
          p_status: string
        }
        Returns: undefined
      }
      record_scoring_failure: {
        Args: {
          p_error_code: string
          p_error_message: string
          p_failure_type: string
          p_job_id: string
          p_msg_id: number
          p_processing_token?: string
          p_provider_response?: Json
          p_raw_post_id: string
          p_scoring_request_id: string
        }
        Returns: string
      }
      reject_brand_suggestion: { Args: { p_id: string }; Returns: undefined }
      revive_scoring_job: { Args: { p_job_id: string }; Returns: undefined }
      scoring_apply_aggregation: {
        Args: { p_strategy: string; p_theme_scores: Json }
        Returns: number
      }
      scoring_config_snapshot: { Args: never; Returns: Json }
      scoring_hash_of_snapshot: { Args: { p_snapshot: Json }; Returns: string }
      scoring_prompt_template: { Args: never; Returns: string }
      scoring_prompt_version: { Args: never; Returns: string }
      scoring_theme_snapshot: { Args: never; Returns: Json }
      set_current_scoring_result: {
        Args: { p_raw_post_id: string; p_result_id: string }
        Returns: undefined
      }
      set_scoring_themes: { Args: { p_themes: Json }; Returns: undefined }
      upsert_post_embedding: {
        Args: {
          p_anonymize_result_id: string
          p_embedding: string
          p_model: string
          p_raw_post_id: string
        }
        Returns: undefined
      }
      validate_theme_scores: {
        Args: { p_scores: Json; p_snapshot: Json }
        Returns: undefined
      }
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  graphql_public: {
    Enums: {},
  },
  public: {
    Enums: {},
  },
} as const

