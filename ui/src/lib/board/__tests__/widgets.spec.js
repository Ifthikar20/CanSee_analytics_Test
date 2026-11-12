import { describe, expect, it } from 'vitest'
import { DEFAULT_LAYOUT, SIZES, SIZE_LABELS, TONES, WIDGETS, blockCode, panelTitle, widgetMeta } from '../widgets'
import { PREVIEW_KINDS } from '../previews'
import { boardLocation } from '../links'

// The catalog row by row: key, title, one line, default size, allowed
// sizes. The four blocks that open a new board lead it, board_contract.md 3
// follows with autopilot_contract.md 6 first, and the account and project
// blocks end it. The backend's apps/boards/layout.py is tested against the
// same keys and default sizes.
const CONTRACT = [
  ['watch', 'Watch', 'An eye on your tracking: the prompts and AI engines it follows.', 'third', ['third', 'half']],
  [
    'asked-answered',
    'Asked and answered',
    'Your latest tracked question, and whether each engine named you in its answer.',
    'third',
    ['third', 'half'],
  ],
  [
    'answer-rank',
    'Rank in AI answers',
    'The brands AI names in recent answers, in order, with your place among them.',
    'third',
    ['third', 'half'],
  ],
  [
    'visibility-score',
    'Visibility score',
    'How often AI names you, as one number, with the last weeks behind it.',
    'third',
    ['third', 'half'],
  ],
  [
    'prompt-box',
    'Ask AI',
    "Ask a buyer's question several times and see how often each engine names you.",
    'full',
    ['half', 'full'],
  ],
  ['ranking', 'Prompt ranking', 'Your tracked prompts, ranked by how often AI names you.', 'full', ['half', 'full']],
  ['summary', 'Summary', 'Google and the AI engines at a glance.', 'full', ['half', 'full']],
  ['prompts', 'Prompts', 'Where Google ranks you next to what AI says, per question.', 'full', ['half', 'full']],
  ['countries', 'Countries', 'Where you rank and where your traffic comes from, country by country.', 'half', ['half', 'full']],
  ['traffic', 'Traffic', 'Real traffic from the source you connect.', 'half', ['third', 'half', 'full']],
  ['visibility', 'AI visibility over time', 'How often the AI engines name you.', 'half', ['third', 'half', 'full']],
  ['by-engine', 'AI visibility by engine', "Each engine's share of answers that name you.", 'third', ['third', 'half']],
  ['who-recommends', 'Who AI recommends', 'Brands the engines name in their latest answers.', 'third', ['third', 'half']],
  ['share-of-voice', 'Share of voice', 'Your share of all brand mentions in AI answers.', 'third', ['third', 'half']],
  ['sentiment', 'Sentiment', 'How the engines describe you when they name you.', 'third', ['third', 'half']],
  ['fact-check', 'Fact check', 'What AI states about you, checked against your facts.', 'third', ['third', 'half']],
  ['citations', 'Citations', "The sources AI answers cite, and how often it's you.", 'half', ['third', 'half', 'full']],
  ['ai-traffic', 'AI traffic', 'Visits that arrive from AI assistants.', 'third', ['third', 'half']],
  ['ai-crawlers', 'AI crawlers', 'AI bots reading your site, counted by Cloudflare.', 'third', ['third', 'half']],
  ['crawler-access', 'Crawler access', 'Whether AI crawlers may read your site.', 'third', ['third', 'half']],
  ['pages', 'Pages', 'Your pages that Google, AI answers and crawlers use.', 'half', ['half', 'full']],
  ['fan-outs', 'Query fan-outs', 'The web searches the engines ran while answering.', 'half', ['half', 'full']],
  ['prompt-research', 'Prompt research', 'New questions worth tracking, and where they came from.', 'half', ['half', 'full']],
  ['competitors', 'Competitors', 'You next to the competitors you track.', 'half', ['half', 'full']],
  ['products', 'Products', 'Your products in Google Shopping and AI answers.', 'half', ['half', 'full']],
  [
    'prompt-runs',
    'Prompt runs',
    'The prompt runs of this month: what is left on Free, what was used on a paid plan.',
    'third',
    ['third', 'half'],
  ],
  ['next-steps', 'Next steps', 'What is not set up for this project yet, and what to do next.', 'third', ['third', 'half']],
  ['latest-report', 'Latest report', 'The most recent report you saved for this project.', 'half', ['half', 'full']],
]

describe('the widget catalog', () => {
  it('lists the 28 blocks, in catalog order, with their sizes and one-liners', () => {
    expect(WIDGETS.map((w) => [w.key, w.title, w.description, w.size, [...w.sizes]])).toEqual(CONTRACT)
    expect(WIDGETS).toHaveLength(28)
    expect(new Set(WIDGETS.map((w) => w.key)).size).toBe(28)
  })

  it('numbers the blocks CNS_01 to CNS_28 by catalog order', () => {
    expect(WIDGETS.map((w) => blockCode(w.key))).toEqual(
      Array.from({ length: 28 }, (_, i) => `CNS_${String(i + 1).padStart(2, '0')}`),
    )
    // The codes people see on the board: the four that open it, then Ask AI.
    expect(['watch', 'asked-answered', 'answer-rank', 'visibility-score', 'prompt-box'].map(blockCode)).toEqual([
      'CNS_01',
      'CNS_02',
      'CNS_03',
      'CNS_04',
      'CNS_05',
    ])
    expect(blockCode('latest-report')).toBe('CNS_28')
    expect(blockCode('nope')).toBe('')
    expect(blockCode(undefined)).toBe('')
  })

  it('gives every block a short caption, a surface and a catalog drawing', () => {
    expect(TONES).toEqual(['ink', 'light'])
    for (const w of WIDGETS) {
      // One line under the card, beside its code and its controls.
      expect(w.caption.length, w.key).toBeGreaterThan(0)
      expect(w.caption.length, w.key).toBeLessThanOrEqual(26)
      expect(TONES, w.key).toContain(w.tone)
      expect(PREVIEW_KINDS, w.key).toContain(w.preview)
    }
    expect(new Set(WIDGETS.map((w) => w.caption)).size).toBe(28)
  })

  it('spreads the ink blocks out, so the grid has rhythm and never a run of black', () => {
    const tones = WIDGETS.map((w) => w.tone)
    const ink = tones.filter((t) => t === 'ink').length
    expect(ink).toBeGreaterThanOrEqual(6)
    expect(ink).toBeLessThanOrEqual(10)
    // No two ink blocks are neighbours in the catalog.
    tones.forEach((tone, i) => {
      if (i > 0 && tone === 'ink') expect(tones[i - 1], WIDGETS[i].key).toBe('light')
    })
    // A new board reads ink, light, light, ink, then its two wide cards in light.
    expect(DEFAULT_LAYOUT.map((w) => widgetMeta(w.key).tone)).toEqual(['ink', 'light', 'light', 'ink', 'light', 'light'])
  })

  it('allows each default size and only the three sizes', () => {
    expect(SIZES).toEqual(['third', 'half', 'full'])
    for (const w of WIDGETS) {
      expect(w.sizes, w.key).toContain(w.size)
      for (const s of w.sizes) expect(SIZES, w.key).toContain(s)
    }
    expect(SIZE_LABELS).toEqual({ third: 'One third', half: 'Half', full: 'Full width' })
  })

  it('starts a board with a row of four small blocks, then Ask AI and Prompt ranking', () => {
    expect(DEFAULT_LAYOUT.map((w) => ({ ...w }))).toEqual([
      { key: 'watch', size: 'third' },
      { key: 'asked-answered', size: 'third' },
      { key: 'answer-rank', size: 'third' },
      { key: 'visibility-score', size: 'third' },
      { key: 'prompt-box', size: 'full' },
      { key: 'ranking', size: 'full' },
    ])
    // Each at its own default size.
    for (const w of DEFAULT_LAYOUT) expect(widgetMeta(w.key).size, w.key).toBe(w.size)
    expect(Object.isFrozen(DEFAULT_LAYOUT)).toBe(true)
    expect(Object.isFrozen(WIDGETS[0])).toBe(true)
  })

  it('looks a widget up by key', () => {
    expect(widgetMeta('ai-crawlers')).toMatchObject({ title: 'AI crawlers', size: 'third' })
    expect(widgetMeta('visibility-score')).toMatchObject({ caption: 'One number to watch', tone: 'ink', preview: 'numeral' })
    expect(widgetMeta('overview')).toBeNull()
    expect(widgetMeta(undefined)).toBeNull()
  })

  it("titles the panel by its widget, and a prompt's detail Prompt", () => {
    expect(panelTitle('countries', {})).toBe('Countries')
    expect(panelTitle('prompts', {})).toBe('Prompts')
    expect(panelTitle('prompts', { prompt: 'p1' })).toBe('Prompt')
    expect(panelTitle('countries', { prompt: 'p1' })).toBe('Countries')
    expect(panelTitle('prompt-box', { run: 'r1' })).toBe('Ask AI')
    expect(panelTitle('ranking', { order: 'weakest' })).toBe('Prompt ranking')
    expect(panelTitle('answer-rank', {})).toBe('Rank in AI answers')
    expect(panelTitle('nope')).toBe('')
  })
})

describe('boardLocation', () => {
  it('opens the board of a project, with a panel and its keys', () => {
    expect(boardLocation('w1')).toEqual({ name: 'analytics', params: { websiteId: 'w1' }, query: {} })
    expect(boardLocation(7, 'prompts', { prompt: 'p1' })).toEqual({
      name: 'analytics',
      params: { websiteId: '7' },
      query: { prompt: 'p1', widget: 'prompts' },
    })
    // widget is set last, so it wins.
    expect(boardLocation('w1', 'countries', { widget: 'traffic', check: '1' }).query).toEqual({
      widget: 'countries',
      check: '1',
    })
  })

  it('goes through /dashboard without a project', () => {
    expect(boardLocation(null, 'prompts')).toEqual({ name: 'dashboard', query: { widget: 'prompts' } })
    expect(boardLocation('')).toEqual({ name: 'dashboard', query: {} })
  })
})
