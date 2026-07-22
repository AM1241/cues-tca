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
            foreignKeyName: "analyzed_posts_raw_post_id_fkey"
            columns: ["raw_post_id"]
            isOneToOne: true
            referencedRelation: "raw_posts"
            referencedColumns: ["id"]
          },
        ]
      }
      anonymized_posts_current: {
        Row: {
          anonymized_text: string
          config_snapshot: Json
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
          generalized_source_name?: string
          overall_relevance?: number
          raw_post_id?: string
          replacements?: Json
          source_name?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "anonymized_posts_current_raw_post_id_fkey"
            columns: ["raw_post_id"]
            isOneToOne: true
            referencedRelation: "raw_posts"
            referencedColumns: ["id"]
          },
        ]
      }
      configurations: {
        Row: {
          anonymization_enabled: boolean
          anonymize_companies: boolean
          company_aliases: Json
          id: string
          keep_public_bodies: boolean
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
          company_aliases?: Json
          id?: string
          keep_public_bodies?: boolean
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
          company_aliases?: Json
          id?: string
          keep_public_bodies?: boolean
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
      finalize_ingest_run: { Args: { p_run_id: string }; Returns: string }
      is_editor: { Args: never; Returns: boolean }
      reap_stale_ingest: {
        Args: { p_stale_after?: string }
        Returns: {
          finalized_runs: number
          reaped_sources: number
        }[]
      }
      record_content_change: {
        Args: {
          p_observed_text: string
          p_raw_post_id: string
          p_run_id: string
        }
        Returns: boolean
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

