# Known failing backend tests

Snapshot taken on 2026-11-07 against CanSee_analytics_App commit 47f833d
(the search-gap work). These tests predate about two months of backend
changes and fail for that reason; they are not new regressions unless
noted. Fix or update them, then remove them from this list.

## Failing against current code and against the September code they were written for (107)

These were already broken when the suite was removed from the backend repo.

- `apps/accounts/tests/test_services.py::TestAuthService::test_login_returns_tokens`
- `apps/accounts/tests/test_services.py::TestAuthService::test_login_unverified_email_raises`
- `apps/accounts/tests/test_services.py::TestAuthService::test_login_wrong_password_raises`
- `apps/accounts/tests/test_views.py::TestRegisterView::test_register_duplicate_email`
- `apps/accounts/tests/test_views.py::TestRegisterView::test_register_success`
- `apps/analytics/tests/test_analytics.py::DailyStatsServiceTest::test_get_device_breakdown`
- `apps/analytics/tests/test_analytics.py::EventLogViewTest::test_clamps_to_retention_floor`
- `apps/analytics/tests/test_analytics.py::EventLogViewTest::test_csv_export`
- `apps/analytics/tests/test_analytics.py::EventLogViewTest::test_filters_by_event_type_device_and_q`
- `apps/analytics/tests/test_analytics.py::EventLogViewTest::test_paginates_and_includes_retention_meta`
- `apps/analytics/tests/test_analytics.py::IngestEndpointBodySizeTest::test_oversized_body_rejected_413`
- `apps/analytics/tests/test_analytics.py::IngestionAccuracyTest::test_visit_count_increments_per_session_not_per_event`
- `apps/analytics/tests/test_analytics.py::WebsiteCreationTest::test_create_website_invalid_url`
- `apps/citations/tests/test_source_scan.py::test_reddit_reader_extracts_scored_comments`
- `apps/citations/tests/test_views.py::TestWebsiteSourceInfluenceAggregation::test_aggregation_math`
- `apps/content_studio/tests/test_services.py::test_visibility_brief_created_when_mention_rate_low`
- `apps/content_studio/tests/test_views.py::test_briefs_list_filter_by_status`
- `apps/content_studio/tests/test_views.py::test_briefs_list_tenant_isolation`
- `apps/llm_ranking/tests/test_geo_deep_dive.py::TestBuildForUser::test_available_prompts_ranked_by_volume`
- `apps/llm_ranking/tests/test_geo_deep_dive.py::TestBuildForUser::test_position_buckets_split_per_provider`
- `apps/llm_ranking/tests/test_geo_deep_dive.py::TestBuildForUser::test_prompts_filter_narrows_matrix`
- `apps/llm_ranking/tests/test_geo_deep_dive.py::TestBuildForUser::test_sentiment_split_per_provider`
- `apps/llm_ranking/tests/test_geo_deep_dive.py::TestBuildForUser::test_themes_disabled_by_setting`
- `apps/llm_ranking/tests/test_geo_deep_dive.py::TestBuildForUser::test_themes_parsed_from_provider_response`
- `apps/llm_ranking/tests/test_geo_deep_dive.py::TestBuildForUser::test_themes_skipped_when_provider_not_configured`
- `apps/llm_ranking/tests/test_geo_deep_dive.py::TestBuildForUser::test_visibility_matrix_caps_at_max_prompts`
- `apps/llm_ranking/tests/test_geo_stats.py::TestBuildBreakdownsForUser::test_position_distribution_buckets`
- `apps/llm_ranking/tests/test_geo_stats.py::TestBuildBreakdownsForUser::test_sentiment_split_and_samples`
- `apps/llm_ranking/tests/test_geo_stats.py::TestBuildBreakdownsForUser::test_visibility_by_provider`
- `apps/llm_ranking/tests/test_geo_stats.py::TestBuildKpisForUser::test_returns_three_tiles_in_order`
- `apps/llm_ranking/tests/test_geo_stats.py::TestBuildKpisForUser::test_sentiment_score_from_mention_distribution`
- `apps/llm_ranking/tests/test_geo_stats.py::TestFilters::test_prompts_filter_narrows_visibility`
- `apps/llm_ranking/tests/test_geo_tagger.py::test_heuristic_explanation_pattern`
- `apps/llm_ranking/tests/test_plackett_luce.py::TestFitPlackettLuce::test_single_brand_rankings_skipped`
- `apps/llm_ranking/tests/test_scoring_edge_cases.py::TestComputeOverallScoreEdgeCases::test_all_failed_queries_dont_crash`
- `apps/llm_ranking/tests/test_scoring_edge_cases.py::TestComputeOverallScoreEdgeCases::test_mixed_sentiment_yields_partial_score`
- `apps/llm_ranking/tests/test_scoring_edge_cases.py::TestComputeOverallScoreEdgeCases::test_only_one_provider_succeeded_caps_coverage`
- `apps/llm_ranking/tests/test_scoring_edge_cases.py::TestComputeOverallScoreEdgeCases::test_smoothed_pulls_small_samples_toward_prior`
- `apps/llm_ranking/tests/test_scoring_edge_cases.py::TestComputeOverallScoreEdgeCases::test_unanimous_top_rank_caps_at_100`
- `apps/llm_ranking/tests/test_services.py::TestBetaBinomialMean::test_approaches_empirical_at_large_n`
- `apps/llm_ranking/tests/test_services.py::TestComputeOverallScoreCI::test_mention_rate_ci_is_returned`
- `apps/llm_ranking/tests/test_services.py::TestPromptLibrary::test_generate_returns_dict_list_with_intents`
- `apps/llm_ranking/tests/test_services.py::TestPromptLibrary::test_intents_for_tags_generated_prompts`
- `apps/llm_ranking/tests/test_services.py::TestPromptLibrary::test_location_adds_local_intent`
- `apps/llm_ranking/tests/test_services.py::TestRecommendations::test_high_rank_gives_position_recommendation`
- `apps/llm_ranking/tests/test_services.py::TestRecommendations::test_high_score_gives_maintenance_recommendation`
- `apps/llm_ranking/tests/test_services.py::TestRecommendations::test_low_score_gives_content_recommendation`
- `apps/llm_ranking/tests/test_services.py::TestRunAudit::test_run_audit_stores_mention_correctly`
- `apps/llm_ranking/tests/test_views.py::TestLLMRankingAuditDetailView::test_get_audit_with_results`
- `apps/llm_ranking/tests/test_views.py::TestLLMRankingAuditListView::test_create_audit_falls_back_to_website_fields`
- `apps/llm_ranking/tests/test_views.py::TestLLMRankingAuditListView::test_create_audit_queues_task`
- `apps/llm_ranking/tests/test_views.py::TestLLMRankingAuditListView::test_create_audit_with_custom_prompts`
- `apps/llm_ranking/tests/test_views.py::TestLLMRankingAuditListView::test_list_empty`
- `apps/llm_ranking/tests/test_views.py::TestLLMRankingAuditListView::test_list_excludes_other_websites`
- `apps/llm_ranking/tests/test_views.py::TestLLMRankingAuditListView::test_list_returns_audits`
- `apps/llm_ranking/tests/test_views.py::TestLLMRankingHistoryView::test_history_aggregates_competitors_per_audit`
- `apps/llm_ranking/tests/test_views.py::TestLLMRankingHistoryView::test_history_computes_citation_share`
- `apps/llm_ranking/tests/test_views.py::TestLLMRankingHistoryView::test_history_dedupes_competitor_within_a_response`
- `apps/llm_ranking/tests/test_views.py::TestLLMRankingHistoryView::test_history_includes_per_provider_stats`
- `apps/llm_ranking/tests/test_views.py::TestLLMRankingProviderBreakdownView::test_breakdown_groups_by_provider`
- `apps/llm_ranking/tests/test_views.py::TestVisibilityOverviewView::test_empty_state`
- `apps/llm_ranking/tests/test_views.py::TestVisibilityOverviewView::test_excludes_other_websites`
- `apps/llm_ranking/tests/test_views.py::TestVisibilityOverviewView::test_populated_state`
- `apps/llm_ranking/tests/test_views.py::TestVisibilityOverviewView::test_response_includes_per_competitor_breakdown`
- `apps/llm_ranking/tests/test_visibility_series.py::TestBuildForUser::test_competitor_rate_is_share_of_answers_with_competitors`
- `apps/llm_ranking/tests/test_visibility_series.py::TestBuildForUser::test_empty_buckets_report_zero`
- `apps/llm_ranking/tests/test_visibility_series.py::TestBuildForUser::test_other_users_audits_are_excluded`
- `apps/llm_ranking/tests/test_visibility_series.py::TestBuildOverview::test_competitor_names_are_deduped_case_insensitively`
- `apps/llm_ranking/tests/test_visibility_series.py::TestBuildOverview::test_per_competitor_breakdown_ranks_by_total_mentions`
- `apps/llm_ranking/tests/test_visibility_series.py::TestWebsiteScopedMonth12::test_excludes_audits_from_other_websites`
- `apps/llm_ranking/tests/test_visibility_series.py::TestWebsiteScopedMonth12::test_returns_twelve_buckets`
- `apps/prompt_library/tests/test_context_generator.py::test_no_provider_returns_fallback`
- `apps/prompt_library/tests/test_context_generator.py::test_short_template_text_skipped_then_fallback`
- `apps/prompt_library/tests/test_context_generator.py::test_truncated_json_is_repaired`
- `apps/prompt_library/tests/test_views.py::test_create_prompt_reuses_existing_topic`
- `apps/prompt_library/tests/test_views.py::test_create_prompt_routes_region_from_location`
- `apps/prompt_library/tests/test_views.py::test_create_prompt_scan_failure_does_not_break_create`
- `apps/prompt_library/tests/test_views.py::test_create_prompt_with_new_topic`
- `apps/prompt_library/tests/test_views.py::test_create_prompts_multiline_with_tags_and_location`
- `apps/prompt_library/tests/test_views.py::test_get_audit_sample_returns_null_when_missing`
- `apps/prompt_library/tests/test_views.py::test_industries_list`
- `apps/prompt_library/tests/test_views.py::test_preview_sample_returns_prompts`
- `apps/prompt_library/tests/test_views.py::test_prompt_detail_attaches_logo_from_cited_domain`
- `apps/prompt_library/tests/test_views.py::test_prompt_detail_brands_fall_back_to_response_text`
- `apps/prompt_library/tests/test_views.py::test_prompt_detail_by_model_visibility`
- `apps/prompt_library/tests/test_views.py::test_prompt_detail_heals_stale_running_scan`
- `apps/prompt_library/tests/test_views.py::test_prompt_detail_includes_latest_scan`
- `apps/prompt_library/tests/test_views.py::test_prompt_detail_keeps_fresh_running_scan`
- `apps/prompt_library/tests/test_views.py::test_prompt_detail_latest_scan_none_when_never_crawled`
- `apps/prompt_library/tests/test_views.py::test_prompt_detail_per_model_rank_buckets_and_unavailable`
- `apps/prompt_library/tests/test_views.py::test_prompt_detail_position_follows_response_list_order`
- `apps/prompt_library/tests/test_views.py::test_prompt_detail_prefers_llm_supplied_domain`
- `apps/prompt_library/tests/test_views.py::test_prompt_detail_recent_chats_label_failed_and_unavailable`
- `apps/prompt_library/tests/test_views.py::test_prompt_detail_returns_recent_chats`
- `apps/prompt_library/tests/test_views.py::test_prompt_detail_top_domains_expose_sample_chats`
- `apps/prompt_library/tests/test_views.py::test_prompt_detail_uses_per_competitor_sentiment`
- `apps/prompt_library/tests/test_views.py::test_prompt_detail_visibility_varies_with_cross_model_overlap`
- `apps/prompt_library/tests/test_views.py::test_prompts_list_filter_by_industry`
- `apps/prompt_library/tests/test_views.py::test_reextract_backfills_competitors_on_old_rows`
- `apps/prompt_library/tests/test_views.py::test_regions_endpoint`
- `apps/prompt_library/tests/test_views.py::test_saved_agg_tag_filter_and_all_tags`
- `apps/prompt_library/tests/test_views.py::test_use_library_sample_persists_run`
- `apps/web_analytics/tests/test_dashboard_sources.py::test_ga4_bundle_report_period_shapes`
- `core/tests/test_field_encryption.py::test_dev_without_key_passes_through_plaintext_and_warns`
- `core/tests/test_nginx_conf.py::TestBothConfigsStayInSync::test_every_route_exists_in_both[/admin/]`
- `core/validators/tests/test_safe_http.py::TestRedirectRevalidation::test_refuses_redirect_to_private_address`
- `services/sources/tests/test_sources_api.py::test_read_dispatches_reddit`

## Passed on the September code, fail now (20)

Checked causes so far: the knowledge base, brand search terms and
visibility dashboards became shared per project instead of per user
(commits c2d7892 and a71db88), the Search Console OAuth return moved to
/settings/connections, the free-plan prompt cap changed from 5 to 1, and
the session payload gained a `source` field. The two Google OAuth
failures (HTTP 400) are not yet explained.

- `apps/accounts/tests/test_google_oauth.py::TestGoogleOAuthView::test_logs_in_existing_user`
- `apps/accounts/tests/test_google_oauth.py::TestGoogleOAuthView::test_unknown_google_email_rejected`
- `apps/accounts/tests/test_refresh_cookie.py::TestRefreshCookieHardening::test_name_path_and_lifetime_match_the_client[False]`
- `apps/accounts/tests/test_refresh_cookie.py::TestRefreshCookieHardening::test_name_path_and_lifetime_match_the_client[True]`
- `apps/billing/tests/test_trial_transition.py::TestSessionPayloadContract::test_live_trial_is_described_as_a_trial`
- `apps/billing/tests/test_trial_transition.py::TestSessionPayloadContract::test_no_subscription`
- `apps/brand_vault/tests/security/test_derived_terms.py::test_scoped_to_owning_user`
- `apps/llm_ranking/tests/test_geo_deep_dive.py::TestBuildForUser::test_visibility_matrix_dedupes_by_most_recent_audit`
- `apps/llm_ranking/tests/test_geo_stats.py::TestBuildKpisForUser::test_missing_previous_period_yields_neutral_change`
- `apps/llm_ranking/tests/test_geo_stats.py::TestBuildKpisForUser::test_other_users_audits_excluded`
- `apps/llm_ranking/tests/test_geo_stats.py::TestBuildKpisForUser::test_position_direction_inverts_higher_is_worse`
- `apps/llm_ranking/tests/test_geo_stats.py::TestBuildKpisForUser::test_visibility_value_reflects_current_period`
- `apps/llm_ranking/tests/test_geo_stats.py::TestFilters::test_explicit_start_end_window`
- `apps/llm_ranking/tests/test_plan_prompt_caps.py::TestMaxPromptsForUser::test_no_subscription_falls_back_to_free`
- `apps/llm_ranking/tests/test_visibility_series.py::TestBuildForUser::test_brand_series_averages_mention_rate_in_bucket`
- `apps/llm_ranking/tests/test_visibility_series.py::TestBuildForUser::test_returns_all_three_resolutions_when_user_has_data`
- `apps/rag/tests/test_retriever.py::TestRetrieve::test_scoped_to_user_and_website`
- `apps/rag/tests/test_source_list_api.py::TestSourceListFilters::test_other_users_rows_never_leak_via_domain_filter`
- `apps/rag/tests/test_tenant_isolation.py::TestTenantIsolation::test_context_block_never_leaks_other_user`
- `apps/search_console/tests/test_views_connection.py::TestOAuthCallback::test_happy_path_connects_and_redirects`
