// data.header and data.gaps of a report version, as services/reports saves
// them (reports-be contract).
export function reportHeader(overrides = {}) {
  return {
    template: { id: 'competitor_comparison', name: 'Competitor comparison' },
    project: { name: 'Notion', url: 'https://www.notion.so/' },
    captured_at: '2026-11-08T12:00:00Z',
    data: [
      { key: 'tracked_data', label: 'Tracked prompt data', window_days: 120 },
      { key: 'research_agents', label: 'Research agents run for this reply', window_days: null },
    ],
    engines: [
      { key: 'chatgpt', label: 'ChatGPT', status: 'asked', configured: true },
      { key: 'claude', label: 'Claude', status: 'asked', configured: true },
      { key: 'gemini', label: 'Gemini', status: 'failed', configured: true },
      { key: 'grok', label: 'Grok', status: 'not_configured', configured: false },
      { key: 'perplexity', label: 'Perplexity', status: 'not_selected', configured: true },
    ],
    locations: ['US'],
    prompts: [{ prompt_id: 'p1', text: 'best notes app for teams', location: 'US' }],
    competitors: [
      { name: 'Evernote', domain: 'evernote.com' },
      { name: 'Coda', domain: 'coda.io' },
    ],
    compared: null,
    ...overrides,
  }
}

export function promptGap(overrides = {}) {
  return {
    prompt: { id: 'p1', text: 'best notes app for teams', location: 'us' },
    google: { status: 'ok', position: 4, page: 1, depth: 100, top_results: [] },
    engines: [
      { key: 'chatgpt', label: 'ChatGPT', configured: true, answers: 5, mentioned: true, rank: 2 },
      { key: 'claude', label: 'Claude', configured: true, answers: 3, mentioned: false, rank: null },
      { key: 'grok', label: 'Grok', configured: false, answers: 0, mentioned: null, rank: null },
    ],
    gap: { class: 'google_ahead', value: -35 },
    verdict: 'ChatGPT lists you #2. Google has you at #4 (page 1).',
    actions: [],
    ...overrides,
  }
}
