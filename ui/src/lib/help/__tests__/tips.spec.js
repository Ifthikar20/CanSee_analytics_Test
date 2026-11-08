import { describe, expect, it } from 'vitest'
import { TIPS } from '../tips'
import { HINTS } from '../hints'

function strings(value, path = 'TIPS') {
  if (typeof value === 'string') return [[path, value]]
  return Object.entries(value).flatMap(([key, v]) => strings(v, `${path}.${key}`))
}

const ALL = [...strings(TIPS), ...HINTS.flatMap((h) => [[`${h.key}.title`, h.title], [`${h.key}.body`, h.body]])]

describe('help copy', () => {
  it('is plain sentences: no emoji, no markup, no dollar amounts', () => {
    for (const [path, text] of ALL) {
      expect(text.trim(), path).not.toBe('')
      expect(text, path).not.toMatch(/\p{Extended_Pictographic}/u)
      expect(text, path).not.toMatch(/[<>]/)
      // Free users never see dollars; the allowance is spoken of as an allowance.
      expect(text, path).not.toMatch(/\$/)
    }
  })

  it('says research skips engines that are not configured (the swarm plans them as not asked)', () => {
    expect(TIPS.onboarding.engines).toBe(
      'Engines listed as not configured have no access set up on this workspace yet, so research skips them.',
    )
  })

  it('never says Ask AI answers feed Prompt ranking', () => {
    expect(TIPS.ranking.notRanked).toContain('Ask AI answers stay in Ask AI')
    for (const [path, text] of ALL) {
      expect(text, path).not.toMatch(/Ask AI answers (count|feed|go) (to|into|toward) (Prompt )?ranking/i)
    }
  })
})

describe('Agents page help', () => {
  it('explains the setup strip, the research ceiling and the presets', () => {
    expect(TIPS.agents.setup).toMatch(/never as not mentioning you/)
    expect(TIPS.agents.ceiling).toMatch(/per Google results page, per AI engine asked and per competitor page read/)
    expect(TIPS.agents.presets).toMatch(/before anything runs/)
  })
})
