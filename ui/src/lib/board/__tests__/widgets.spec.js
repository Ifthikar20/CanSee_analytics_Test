import { describe, expect, it } from 'vitest'
import { DEFAULT_LAYOUT, SIZES, SIZE_LABELS, WIDGETS, panelTitle, widgetMeta } from '../widgets'
import { boardLocation } from '../links'

// board_contract.md 3 with autopilot_contract.md 6 first, row by row: key,
// title, one line, default size, allowed sizes.
const CONTRACT = [
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
]

describe('the widget catalog', () => {
  it('lists the 21 widgets of the contracts, in catalog order, with their sizes and one-liners', () => {
    expect(WIDGETS.map((w) => [w.key, w.title, w.description, w.size, [...w.sizes]])).toEqual(CONTRACT)
    expect(WIDGETS).toHaveLength(21)
  })

  it('allows each default size and only the three sizes', () => {
    expect(SIZES).toEqual(['third', 'half', 'full'])
    for (const w of WIDGETS) {
      expect(w.sizes, w.key).toContain(w.size)
      for (const s of w.sizes) expect(SIZES, w.key).toContain(s)
    }
    expect(SIZE_LABELS).toEqual({ third: 'One third', half: 'Half', full: 'Full width' })
  })

  it('starts a board with Ask AI, then Prompt ranking', () => {
    expect(DEFAULT_LAYOUT.map((w) => ({ ...w }))).toEqual([
      { key: 'prompt-box', size: 'full' },
      { key: 'ranking', size: 'full' },
    ])
    expect(Object.isFrozen(DEFAULT_LAYOUT)).toBe(true)
    expect(Object.isFrozen(WIDGETS[0])).toBe(true)
  })

  it('looks a widget up by key', () => {
    expect(widgetMeta('ai-crawlers')).toMatchObject({ title: 'AI crawlers', size: 'third' })
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
