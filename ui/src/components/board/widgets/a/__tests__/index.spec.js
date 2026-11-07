import { describe, expect, it } from 'vitest'
import widgetsA from '../index.js'

describe('group A widgets', () => {
  it('serves the four default widgets and the traffic family, each a lazy card and panel', () => {
    expect(Object.keys(widgetsA)).toEqual(['summary', 'prompts', 'countries', 'traffic', 'ai-traffic', 'ai-crawlers'])
    for (const entry of Object.values(widgetsA)) {
      expect(typeof entry.card).toBe('function')
      expect(typeof entry.panel).toBe('function')
    }
  })

  it('opens AI traffic on the half each widget is about', async () => {
    expect(widgetsA['ai-traffic'].panelProps).toEqual({ focus: 'visits' })
    expect(widgetsA['ai-crawlers'].panelProps).toEqual({ focus: 'crawlers' })
    expect(widgetsA['ai-traffic'].panel).toBe(widgetsA['ai-crawlers'].panel)
    const page = await widgetsA['ai-crawlers'].panel()
    expect(page.default.props).toHaveProperty('focus')
  })

  it('loads every component', async () => {
    for (const entry of Object.values(widgetsA)) {
      expect((await entry.card()).default).toBeTruthy()
      expect((await entry.panel()).default).toBeTruthy()
    }
  })
})
