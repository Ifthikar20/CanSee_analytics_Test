// GET /agent/command-center/ payloads (p2_contract.md 14b).

export function commandCenter(overrides = {}) {
  return {
    scope: 'org',
    scopes: [
      { key: 'me', label: 'Your activity' },
      { key: 'org', label: 'Acme' },
    ],
    window: { period: '7d', interval: 'day', start: '2026-10-30', end: '2026-11-05', buckets: ['2026-11-03', '2026-11-04', '2026-11-05'] },
    filters: { website_id: null },
    websites: [
      { id: 'c9', name: 'Notion' },
      { id: 'd4', name: 'Acme shop' },
    ],
    empty_reason: null,
    totals: {
      runs: 120,
      runs_prev: 98,
      completed: 110,
      failed: 6,
      cancelled: 3,
      interrupted: 1,
      in_progress: 0,
      chats: 40,
      drafts_saved: 25,
      active_users: 5,
      active_users_prev: 4,
      ai_usd: '12.3456',
      ai_usd_prev: '10.0100',
    },
    runs_series: { completed: [3, 0, 5], failed: [0, 1, 0], cancelled: [0, 0, 1], interrupted: [0, 0, 0] },
    active_users_series: [2, 0, 3],
    spend_series: {
      agent_replies: ['0.1200', '0.0000', '0.3000'],
      writers: ['0.0000', '0.0000', '1.2000'],
      research: ['0.0000', '0.0000', '0.0000'],
      context: ['0.0000', '0.0000', '0.0061'],
      engines: ['0.0400', '0.0000', '0.0800'],
      insights: ['0.0000', '0.0000', '0.0000'],
      other: ['0.0000', '0.0000', '0.0000'],
    },
    spend_by_category: [{ key: 'writers', label: 'Writing agents', usd: '1.2000', requests: 4 }],
    by_agent: [
      { key: 'page_optimizer', label: 'Page Optimizer', team: 'aeo_seo', runs: 12, drafts_saved: 10, ai_usd: '1.2300' },
      { key: 'agent_only', label: 'Agent only', team: null, runs: 30, drafts_saved: 0, ai_usd: '0.0000' },
    ],
    by_team: [{ key: 'aeo_seo', label: 'AEO and SEO', runs: 30 }],
    top_users: [
      { user_id: 'u1', name: 'Site Owner', email: 'owner@example.com', role: 'owner', runs: 40, active_days: 12, ai_usd: '4.5600', last_active_at: new Date(Date.now() - 3600 * 1000).toISOString() },
      { user_id: 'u9', name: 'Lee (former member)', email: '', role: null, runs: 2, active_days: 1, ai_usd: '0.0040', last_active_at: null },
    ],
    ...overrides,
  }
}

export function mineOnly(overrides = {}) {
  return commandCenter({ scope: 'me', scopes: [{ key: 'me', label: 'Your activity' }], top_users: null, ...overrides })
}
