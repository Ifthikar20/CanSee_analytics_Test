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

  it('says the engine choice of the last onboarding step applies to the first research only', () => {
    expect(TIPS.onboarding.engines).toBe(
      'Pick the AI engines your first research asks. An engine that is not set up on this workspace cannot be picked. Later checks ask every engine that is set up.',
    )
  })

  it('explains a prompt run without a number or a dollar', () => {
    expect(TIPS.onboarding.promptRuns).toContain('One prompt run is one prompt answered by one AI engine.')
    expect(TIPS.onboarding.promptRuns).toContain('shared by all your projects and engines')
    expect(TIPS.onboarding.promptRuns).not.toMatch(/\$|\d/)
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
