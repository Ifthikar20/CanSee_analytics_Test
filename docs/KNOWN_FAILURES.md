# Known failing backend tests

Run on 2026-11-07: this repository at the commit that adds this file,
against CanSee_analytics_App `feature/November-26` at `d658e55`, one app
at a time with `scripts/run-backend-tests.sh`.

Result: 3789 passed, 6 failed, 0 errors, 1 skipped.

Each remaining failure points at a real bug in the backend. The tests are
left failing on purpose: fix the app code, then remove the entry here. Do not
skip, xfail or loosen these tests to get a green run.

| Test | Bug | Where |
| --- | --- | --- |
| `apps/llm_ranking/tests/test_views.py::TestLLMRankingAuditDetailView::test_get_audit_with_results` | The response envelope treats any payload with a `results` key as a paginated page, so the audit detail endpoint returns its results list as `data` and the audit fields under `meta`. | `core/interceptors/response_envelope.py` (the `"results" in data` check) |
| `apps/analytics/tests/test_analytics.py::EventLogViewTest::test_csv_export` | `?format=csv` is consumed by DRF content negotiation, which finds no CSV renderer and returns 404 before the view runs, so the documented CSV export is unreachable. | `apps/analytics/api/v1/analytics_views.py` (`EventLogView`) |
| `apps/analytics/tests/test_analytics.py::WebsiteCreationTest::test_create_website_invalid_url` | Website create accepts dotless, non-public hostnames such as `not-a-url` (stored as `https://not-a-url`). Regressed when the serializer moved from `URLField` to `CharField` in `e7992df`. | `core/validators/url_validator.py` |
| `apps/prompt_library/tests/test_context_generator.py::test_truncated_json_is_repaired` | Truncated-JSON repair cuts at the last `}`, which can sit inside an unterminated string, so complete items are dropped and generation fails with a 502. | `apps/prompt_library/services/context_generator.py` (`_extract_json_array`) |
| `apps/llm_ranking/tests/test_geo_tagger.py::test_heuristic_explanation_pattern` | The people/society rule matches "generation" before the explanation rule runs, so "how does retrieval augmented generation work" is tagged `people_society`. | `apps/llm_ranking/services/geo_tagger.py` |
| `apps/llm_ranking/tests/test_plackett_luce.py::TestFitPlackettLuce::test_single_brand_rankings_skipped` | Brands that only appear in single-brand rankings are never compared but keep the maximum strength of 1.0. Production audits drop such rankings today, so impact is low. | `apps/llm_ranking/services/plackett_luce.py` |

## How the suite got here

The suite restored from early September 2026 had about 127 failures against
the current backend. They were resolved in the commits titled "Align ... tests
with the merged backend":

- Test files whose subject was deliberately removed from the backend were
  deleted (for example `geo_rewrite`, `google_search`, the old Brand Security
  agents and safety endpoints, Content Studio, prompt test environments). Each
  deletion names the removing commit.
- Tests whose expected behaviour changed on purpose were updated to assert the
  current behaviour (for example the knowledge base and dashboards being shared
  per project, the Search Console return to `/settings/connections`, plan
  limits, login throttling). Isolation tests now check isolation between
  projects and organizations.
- The onboarding tests no longer exhaust memory: one test mocked the whole
  `WebsiteService`, a query returned a mock, and the JSON encoder recursed on
  it.
