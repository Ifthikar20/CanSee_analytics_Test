// Swarm parts and tables shaped exactly as swarm_contract.md 4b, 5c, 5d and
// 5e describe them, for the research agents component specs. Test data
// only; app code never imports this file.

export const SWARM_ID = '5d0c6a1e-8b0f-4d0e-9a3e-0b3e2a6f9c11'
export const PROMPT = 'best note taking app for teams'
export const SERP_TAB = 'serp:3f2a9c1d0e7b'
export const OWN_TAB = 'page:aa11bb22cc33'
export const COMPETITOR_TAB = 'page:dd44ee55ff66'

const STARTED = '2026-11-04T10:15:04.309Z'

export function task(fields = {}) {
  return {
    id: 'google.p1.page1',
    category: 'google',
    subcategory: 'p1',
    worker: 'serp_page',
    label: 'Google page 1',
    target: PROMPT,
    status: 'queued',
    step: '',
    result: '',
    tone: null,
    depends_on: [],
    started_at: null,
    ended_at: null,
    duration_ms: null,
    attempt: 0,
    error: null,
    pane: null,
    detail: null,
    rev: 1,
    ...fields,
  }
}

export function serpDetail(overrides = {}) {
  return {
    query: PROMPT,
    page: 1,
    location: 'us',
    provider: 'scraperapi',
    captured_at: '2026-11-04T10:15:19.004Z',
    reused: false,
    result_count: 10,
    brand_positions: [4],
    top: [
      {
        position: 1,
        title: 'Evernote: Best Note Taking App',
        url: 'https://evernote.com/',
        domain: 'evernote.com',
        is_yours: false,
        is_competitor: true,
        competitor_name: 'Evernote',
      },
      {
        position: 4,
        title: 'Notion: notes for teams',
        url: 'https://www.notion.so/product',
        domain: 'notion.so',
        is_yours: true,
        is_competitor: false,
        competitor_name: null,
      },
    ],
    ai_overview: {
      shown: true,
      content_captured: true,
      mentions_you: false,
      cites_you: false,
      references: [{ domain: 'zapier.com', url: 'https://zapier.com/blog/best-note-taking-apps/' }],
    },
    people_also_ask: ['What is the best free note taking app?'],
    ...overrides,
  }
}

export function engineDetail(overrides = {}) {
  return {
    engine: 'chatgpt',
    engine_label: 'ChatGPT',
    variant: null,
    model_id: 'gpt-4o-mini',
    prompt_text: PROMPT,
    answered_at: '2026-11-04T10:15:31.220Z',
    mentioned: false,
    rank: null,
    sentiment: null,
    brands: [
      { name: 'Evernote', position: 1 },
      { name: 'OneNote', position: 2 },
    ],
    brands_above: [{ name: 'Evernote', position: 1 }],
    snippet: '',
    citations: [
      { url: 'https://zapier.com/blog/notes', domain: 'zapier.com', is_yours: false },
      { url: 'https://www.notion.so/product', domain: 'notion.so', is_yours: true },
    ],
    analysis: {
      summary: 'ChatGPT recommends Evernote, OneNote and Obsidian and does not name Notion.',
      reasons: ['Strong offline mode', 'Free tier'],
      opportunity: 'Publish a comparison page that names offline support and pricing.',
    },
    analysis_error: null,
    result_id: 'c2b1',
    ...overrides,
  }
}

export function pageDetail(overrides = {}) {
  return {
    role: 'competitor',
    url: 'https://evernote.com/',
    final_url: 'https://evernote.com/',
    status_code: 200,
    domain: 'evernote.com',
    competitor_name: 'Evernote',
    position: 1,
    chosen_because: 'Ranks #1 on Google for this prompt',
    title: 'Evernote: Best Note Taking App',
    seo: {
      title: 'Evernote: Best Note Taking App',
      title_length: 34,
      meta_description: 'Capture notes everywhere.',
      meta_description_length: 120,
      h1: ['Remember everything'],
      h2: ['Evernote vs. OneNote', 'Pricing'],
      word_count: 2140,
      structured_data: ['Organization', 'FAQPage'],
      canonical: 'https://evernote.com/',
      robots: '',
      links: { internal: 80, external: 12 },
      images: { count: 24, missing_alt: 3 },
    },
    excerpt: 'Remember everything.',
    reused_from: null,
    ...overrides,
  }
}

export function gapDetail(overrides = {}) {
  return {
    compared: [
      { role: 'own', url: 'https://www.notion.so/product', title: 'Notion product' },
      { role: 'competitor', url: 'https://evernote.com/', title: 'Evernote' },
    ],
    headline: "Evernote's page answers the buyer question directly; yours does not.",
    gaps: [
      {
        issue: 'No comparison with alternatives',
        evidence: "Evernote's H2 'Evernote vs. OneNote'; your page has none.",
        fix: 'Add a section comparing Notion with Evernote and OneNote on offline use and price.',
        target: 'https://www.notion.so/product',
        severity: 'high',
      },
      {
        issue: 'No FAQ',
        evidence: 'Evernote marks up an FAQPage.',
        fix: 'Answer the common buyer questions on the page.',
        target: 'https://docs.example.test/faq',
        severity: 'low',
      },
    ],
    analysis_error: null,
    ...overrides,
  }
}

export function citationsDetail(overrides = {}) {
  return {
    total_citations: 14,
    you_cited: false,
    overview_references: 3,
    sources: [
      {
        domain: 'g2.com',
        citations: 3,
        engines: ['chatgpt', 'claude'],
        is_yours: false,
        is_competitor: false,
        competitor_name: null,
        example_url: 'https://www.g2.com/categories/note-taking',
      },
      {
        domain: 'evernote.com',
        citations: 2,
        engines: ['chatgpt'],
        is_yours: false,
        is_competitor: true,
        competitor_name: 'Evernote',
        example_url: 'https://evernote.com/',
      },
    ],
    analysis: {
      headline: 'Engines lean on review sites you are not listed on.',
      opportunities: [
        { domain: 'g2.com', why: 'Cited by two engines for this prompt', action: 'Claim and complete the Notion listing on G2.' },
      ],
    },
    analysis_error: null,
    ...overrides,
  }
}

const ENGINES_NOTE = {
  level: 'info',
  code: 'engines_not_configured',
  text: 'Gemini, Grok and Perplexity are not configured, so they were not asked.',
}

export function categories() {
  const sub = [{ key: 'p1', label: PROMPT }]
  return [
    { key: 'google', label: 'Google (SEO)', notes: [], subcategories: sub },
    { key: 'engines', label: 'AI engines (GEO)', notes: [ENGINES_NOTE], subcategories: sub },
    { key: 'competitors', label: 'Competitor pages', notes: [], subcategories: sub },
    { key: 'site', label: 'Your site and content gaps', notes: [], subcategories: sub },
    { key: 'sources', label: 'Sources and citations', notes: [], subcategories: sub },
  ]
}

// The planning part the translator adds while the tool input streams.
export function planningPart(overrides = {}) {
  return {
    id: 'p4',
    type: 'swarm',
    request: 1,
    swarm_id: null,
    version: null,
    title: '',
    scope: 'all',
    scope_label: '',
    status: 'planning',
    started_at: null,
    ended_at: null,
    duration_ms: null,
    categories: [],
    tasks: [],
    table_version: null,
    error: null,
    limits: null,
    ...overrides,
  }
}

// Seven agents for one prompt, at the moment Google page 1 and ChatGPT are
// done and Claude is asking.
export function runningTasks() {
  return [
    task({
      status: 'done',
      started_at: '2026-11-04T10:15:04.401Z',
      ended_at: '2026-11-04T10:15:19.149Z',
      duration_ms: 14748,
      attempt: 1,
      result: "You're #4 · AI Overview shown",
      tone: 'good',
      pane: { kind: 'serp', tab_id: SERP_TAB },
      detail: serpDetail(),
      rev: 4,
    }),
    task({
      id: 'engines.p1.chatgpt',
      category: 'engines',
      worker: 'engine_answer',
      label: 'ChatGPT',
      status: 'done',
      started_at: '2026-11-04T10:15:04.500Z',
      ended_at: '2026-11-04T10:15:23.500Z',
      duration_ms: 19000,
      attempt: 1,
      result: 'Not named · lists Evernote, OneNote',
      tone: 'warn',
      detail: engineDetail(),
      rev: 5,
    }),
    task({
      id: 'engines.p1.claude',
      category: 'engines',
      worker: 'engine_answer',
      label: 'Claude',
      status: 'running',
      step: 'Asking Claude',
      started_at: '2026-11-04T10:15:10.000Z',
      attempt: 1,
      rev: 2,
    }),
    task({
      id: 'competitors.p1.c1',
      category: 'competitors',
      worker: 'page_inspect',
      label: 'Competitor page 1',
      target: 'Chosen from Google results',
      depends_on: ['google.p1.page1'],
    }),
    task({
      id: 'site.p1.page',
      category: 'site',
      worker: 'page_inspect',
      label: 'Your page',
      target: 'Your best-ranking page',
      depends_on: ['google.p1.page1'],
    }),
    task({
      id: 'site.p1.gaps',
      category: 'site',
      worker: 'content_gap',
      label: 'Content gaps',
      depends_on: ['site.p1.page', 'competitors.p1.c1', 'engines.p1.chatgpt', 'engines.p1.claude'],
    }),
    task({
      id: 'sources.p1.cited',
      category: 'sources',
      worker: 'citations',
      label: 'Cited sources',
      depends_on: ['engines.p1.chatgpt', 'engines.p1.claude', 'google.p1.page1'],
    }),
  ]
}

export function runningPart(overrides = {}) {
  return planningPart({
    swarm_id: SWARM_ID,
    version: 1,
    title: 'Research Notion',
    scope_label: 'All agents',
    status: 'running',
    started_at: STARTED,
    limits: { max_tasks: 30, workers: 6 },
    categories: categories(),
    tasks: runningTasks(),
    ...overrides,
  })
}

// Every agent settled: one failed, the rest done.
export function finishedTasks() {
  const [google, chatgpt, claude, competitor, own, gaps, cited] = runningTasks()
  return [
    google,
    chatgpt,
    {
      ...claude,
      status: 'failed',
      step: '',
      ended_at: '2026-11-04T10:16:12.000Z',
      duration_ms: 62000,
      attempt: 2,
      error: { code: 'rate_limited', message: 'The engine was busy or rate limited.' },
      rev: 5,
    },
    {
      ...competitor,
      target: 'evernote.com',
      status: 'done',
      started_at: '2026-11-04T10:15:20.000Z',
      ended_at: '2026-11-04T10:15:26.000Z',
      duration_ms: 6000,
      attempt: 1,
      result: 'Evernote: Best Note Taking App · 2,140 words · 2 schema types',
      pane: { kind: 'page', tab_id: COMPETITOR_TAB },
      detail: pageDetail(),
      rev: 5,
    },
    {
      ...own,
      target: 'notion.so/product',
      status: 'done',
      started_at: '2026-11-04T10:15:20.000Z',
      ended_at: '2026-11-04T10:15:25.000Z',
      duration_ms: 5000,
      attempt: 1,
      result: 'Notion product · 980 words · 0 schema types',
      pane: { kind: 'page', tab_id: OWN_TAB },
      detail: pageDetail({
        role: 'own',
        url: 'https://www.notion.so/product',
        final_url: 'https://www.notion.so/product',
        domain: 'notion.so',
        competitor_name: null,
        position: 4,
        chosen_because: 'Your best-ranking page for this prompt',
      }),
      rev: 5,
    },
    {
      ...gaps,
      status: 'done',
      started_at: '2026-11-04T10:16:13.000Z',
      ended_at: '2026-11-04T10:16:30.000Z',
      duration_ms: 17000,
      attempt: 1,
      result: "2 gaps · Evernote's page answers the buyer question directly",
      tone: 'warn',
      detail: gapDetail(),
      rev: 4,
    },
    {
      ...cited,
      status: 'done',
      started_at: '2026-11-04T10:16:13.000Z',
      ended_at: '2026-11-04T10:16:20.000Z',
      duration_ms: 7000,
      attempt: 1,
      result: "2 sources · you're not cited · g2.com cited 3 times",
      tone: 'warn',
      detail: citationsDetail(),
      rev: 4,
    },
  ]
}

export function finishedPart(overrides = {}) {
  return runningPart({
    status: 'partial',
    ended_at: '2026-11-04T10:17:18.510Z',
    duration_ms: 134201,
    table_version: 1,
    tasks: finishedTasks(),
    ...overrides,
  })
}

function cell(fields = {}) {
  return { text: '', v: null, state: 'ok', tone: null, note: null, task_id: null, version: 2, previous: null, ...fields }
}

const PROMPT_COLUMNS = [
  { key: 'prompt', label: 'Prompt', kind: 'text', align: 'left', sortable: true },
  { key: 'google', label: 'Google', kind: 'rank', align: 'right', sortable: true },
  { key: 'chatgpt', label: 'ChatGPT', kind: 'rank', align: 'left', sortable: true },
  { key: 'gemini', label: 'Gemini', kind: 'rank', align: 'left', sortable: true },
  { key: 'ahead', label: 'Ahead of you', kind: 'text', align: 'left', sortable: false },
  { key: 'finding', label: 'Finding', kind: 'text', align: 'left', sortable: false },
]

function promptRow(key, text, google, chatgpt, { finding = true } = {}) {
  return {
    key,
    cells: {
      prompt: cell({ text, v: text, note: 'Searched from US' }),
      google,
      chatgpt,
      gemini: cell({ text: 'Not configured', state: 'not_configured', tone: 'muted', note: 'GEMINI_API_KEY is not set.' }),
      ahead: cell({ text: 'Evernote (1 engine, Google #1)' }),
      finding: cell({ text: '=HYPERLINK("https://evil.test","x")' }),
    },
    task_ids: ['google.p1.page1', 'engines.p1.chatgpt'],
    finding: finding
      ? {
          title: `Not named by ChatGPT for “${text}”`,
          detail: 'Google ranks you #4.',
          category: 'engines',
          severity: 'high',
          prompt_text: text,
          evidence: [{ kind: 'serp', label: "Google page 1 · you're #4", tab_id: SERP_TAB, url: null }],
        }
      : null,
    links: [{ kind: 'serp', label: 'Google page 1', tab_id: SERP_TAB, url: null }],
  }
}

// Version 2 of a research with three prompts; ChatGPT for p1 was carried
// from version 1, and Google for p1 moved from #6 to #4.
export function swarmTable(overrides = {}) {
  return {
    swarm_id: SWARM_ID,
    version: 2,
    title: 'Research Notion',
    status: 'partial',
    generated_at: '2026-11-04T11:02:10.880Z',
    previous_version: 1,
    counts: { total: 6, done: 5, failed: 1, skipped: 0, stopped: 0 },
    notes: ['Only the Google (SEO) agents ran in this version; other cells are from version 1.'],
    changes: [{ sheet: 'prompts', row: 'p1', column: 'google', label: `${PROMPT} · Google`, from: '#6', to: '#4' }],
    sheets: [
      {
        key: 'prompts',
        title: 'Prompts',
        columns: PROMPT_COLUMNS,
        rows: [
          promptRow(
            'p1',
            PROMPT,
            cell({ text: '#4', v: 4, task_id: 'google.p1.page1', note: '1 of 1 pages searched', previous: { text: '#6', version: 1 } }),
            cell({ text: 'Not named', v: 1000, state: 'not_found', tone: 'warn', task_id: 'engines.p1.chatgpt', version: 1, note: 'Lists Evernote, OneNote' })
          ),
          promptRow(
            'p2',
            'notes app with offline mode',
            cell({ text: 'Failed', state: 'failed', tone: 'muted', task_id: 'google.p2.page1', note: 'The Google search failed.' }),
            cell({ text: 'Named #2', v: 2, tone: 'good', task_id: 'engines.p2.chatgpt' }),
            { finding: false }
          ),
          promptRow(
            'p3',
            'Alternatives to Evernote',
            cell({ text: '#1', v: 1, tone: 'good', task_id: 'google.p3.page1' }),
            cell({ text: 'Named', v: 100, task_id: 'engines.p3.chatgpt' })
          ),
        ],
      },
      {
        key: 'gaps',
        title: 'Content gaps',
        columns: [
          { key: 'prompt', label: 'Prompt', kind: 'text', align: 'left', sortable: true },
          { key: 'issue', label: 'Issue', kind: 'text', align: 'left', sortable: true },
          { key: 'page', label: 'Page', kind: 'link', align: 'left', sortable: true },
          { key: 'severity', label: 'Severity', kind: 'status', align: 'left', sortable: true },
        ],
        rows: [
          {
            key: 'p1.g1',
            cells: {
              prompt: cell({ text: PROMPT, v: PROMPT }),
              issue: cell({ text: 'No comparison with alternatives', v: 'No comparison with alternatives' }),
              page: cell({ text: 'notion.so/product', v: 'https://www.notion.so/product' }),
              severity: cell({ text: 'High', v: 1 }),
            },
            task_ids: ['site.p1.gaps'],
            finding: {
              title: 'No comparison with alternatives',
              detail: 'Evidence: ... Fix: ...',
              category: 'site',
              severity: 'high',
              prompt_text: PROMPT,
              evidence: [],
            },
            links: [],
          },
        ],
      },
      { key: 'sources', title: 'Sources', columns: [], rows: [] },
    ],
    ...overrides,
  }
}

export function tablePart(overrides = {}) {
  return {
    id: 'p5',
    type: 'swarm_table',
    request: 1,
    swarm_id: SWARM_ID,
    version: 2,
    title: 'Research Notion',
    status: 'partial',
    generated_at: '2026-11-04T11:02:10.880Z',
    table: swarmTable(),
    ...overrides,
  }
}
