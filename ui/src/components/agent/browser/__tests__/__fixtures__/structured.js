// Structured draft data (p2_contract.md 12d), as saved and as streamed.

export function pageRevisionData(overrides = {}) {
  return {
    type: 'page_revision',
    source: {
      url: 'https://notion.so/pricing',
      final_url: 'https://notion.so/pricing',
      title: 'Pricing',
      status_code: 200,
      read_at: new Date(Date.now() - 2 * 3600 * 1000).toISOString(),
      words: 1240,
    },
    current: { title: 'Pricing | Notion', meta_description: '', h1: 'Plans', structured_data: ['Organization'] },
    proposed: { title: 'Notion pricing: plans for teams', meta_description: 'Compare the Free, Plus and Business plans.', h1: 'Notion pricing' },
    changes: [
      {
        id: 'c1',
        kind: 'rewrite',
        section: 'Pricing',
        before: 'Plans for everyone',
        after: 'Plus costs $10 per seat each month.',
        reason: 'Engines search for the price.',
        signal_ids: ['s2', 's9'],
      },
      { id: 'c2', kind: 'add', section: 'FAQ', before: '', after: 'Is there a free plan? Yes.', reason: 'No signal applies.', signal_ids: [] },
    ],
    signals: [{ id: 's2', kind: 'fanout', text: 'ChatGPT searched "notion pricing 2026" while answering "notion pricing" (2026-11-04)' }],
    ...overrides,
  }
}

export function comparisonData(overrides = {}) {
  return {
    type: 'comparison',
    competitor: { name: 'Evernote', domain: 'evernote.com' },
    sources: [
      { id: 'c1', owner: 'competitor', url: 'https://evernote.com/pricing', title: 'Evernote pricing', read_at: new Date().toISOString(), state: 'ok' },
      { id: 'p1', owner: 'you', url: 'https://notion.so/pricing', title: 'Notion pricing', read_at: '', state: 'failed' },
    ],
    claims: [
      { about: 'competitor', text: 'Evernote Personal costs $14.99 a month.', source_id: 'c1', quote: '$14.99/month', verified: true },
      { about: 'you', text: 'Notion Plus costs $10 a seat.', source_id: 'p1', quote: '$10 per seat', verified: false },
    ],
    ...overrides,
  }
}

export function socialPostsData(overrides = {}) {
  return {
    type: 'social_posts',
    source: { artifact_id: 'a9', title: 'Wiki guide', version: 2 },
    posts: [
      { id: 'p1', channel: 'linkedin', link_url: 'https://notion.so/guide', parts: [{ text: 'Our wiki guide is out.', length: 22, limit: 3000, over: false }] },
      {
        id: 'p2',
        channel: 'x_thread',
        link_url: '',
        parts: [
          { text: 'Thread part one', length: 15, limit: 280, over: false },
          { text: 'A very long part', length: 301, limit: 280, over: true },
        ],
      },
    ],
    ...overrides,
  }
}

export function correctionsData(overrides = {}) {
  return {
    type: 'corrections',
    claim: {
      key: '9f2c|contradicted',
      text: "Notion's Plus plan costs $8 per user per month",
      engines: ['chatgpt', 'claude'],
      answers: 3,
      evidence: { kind: 'page', url: 'https://notion.so/pricing', quote: 'Plus $10 per seat/month' },
    },
    targets: [
      {
        id: 't1',
        url: 'https://g2.com/products/notion',
        publisher: 'g2.com',
        quote: 'Plus at $8 per user',
        read_at: new Date().toISOString(),
        letter: 'Dear G2 team,\n\nThe Plus plan costs **$10** per seat.',
      },
    ],
    not_repeating: [{ url: 'https://capterra.com/notion', publisher: 'capterra.com' }],
    unreadable: [{ url: 'https://blog.example.com/notion', publisher: 'example.com', reason: 'The page took too long to load.' }],
    ...overrides,
  }
}
