import { describe, expect, it } from 'vitest'
import {
  MAX_RESEARCH_PROMPTS,
  agentBlock,
  allowanceLine,
  blockHelp,
  hidesDollars,
  listNames,
  promptRunsLeft,
  researchBlock,
  researchCeiling,
  researchFit,
  researchPromptLimit,
  researchRunsCost,
  researchRunsLine,
  setupSummary,
  workspaceBlock,
} from '../availability'

// A production build (no local dev reveal), so only the server decides who
// sees setting names.
const prod = { dev: false }

const ENGINES = [
  { key: 'chatgpt', label: 'ChatGPT', configured: true, key_setting: '' },
  { key: 'claude', label: 'Claude', configured: true, key_setting: '' },
  { key: 'gemini', label: 'Gemini', configured: false, key_setting: '' },
  { key: 'grok', label: 'Grok', configured: false, key_setting: '' },
  { key: 'perplexity', label: 'Perplexity', configured: false, key_setting: '' },
]

// GET agent/status/ for a paid customer with everything running.
function status(over = {}) {
  return {
    enabled: true,
    configured: true,
    live_available: true,
    engines: ENGINES,
    serp_configured: true,
    google: { configured: true, provider: 'serpapi', label: 'SerpAPI', key_settings: [], reliable_pages: 10 },
    allowance: { cap_usd: '29.25', spent_usd: '3.00', exceeded: false, warning: false, show_usd: true },
    prompt_runs: { unlimited: true, limit: null, used: 4, reserved: 0, remaining: null },
    research: { available: true, reason: null, message: '' },
    setup: { ready: true, issues: [] },
    writers: {},
    limits: { run_cost_usd: '3.00' },
    swarm: { enabled: true, max_agents: 50, worker_model: 'claude-haiku-5-5' },
    ...over,
  }
}

const issue = (code, extra = {}) => ({ code, severity: 'blocking', subject: 'agent', engine: null, setting: null, title: '', action: '', ...extra })

describe('workspaceBlock: what stops every agent', () => {
  it('blocks nothing without a status, or with everything running', () => {
    expect(workspaceBlock(null, prod)).toBeNull()
    expect(workspaceBlock(undefined, prod)).toBeNull()
    expect(workspaceBlock('nope', prod)).toBeNull()
    expect(workspaceBlock({}, prod)).toBeNull()
    expect(workspaceBlock(status(), prod)).toBeNull()
  })

  it('treats a missing field as unknown, never as off', () => {
    const { enabled, configured, live_available: live, ...rest } = status()
    expect([enabled, configured, live]).toEqual([true, true, true])
    expect(workspaceBlock(rest, prod)).toBeNull()
    expect(workspaceBlock({ enabled: null, configured: undefined, live_available: 0 }, prod)).toBeNull()
  })

  it('says the agent is off, in customer words without a setting name', () => {
    expect(workspaceBlock(status({ enabled: false }), prod)).toEqual({
      code: 'agent_disabled',
      scope: 'workspace',
      title: 'The AI agent is turned off on this workspace.',
      action: 'Ask your workspace admin to turn it on.',
      setting: '',
    })
  })

  it('names the setting for staff (the server sends it) and on a dev build', () => {
    const staff = status({ enabled: false, setup: { ready: false, issues: [issue('agent_disabled', { setting: 'AGENT_ENABLED' })] } })
    expect(workspaceBlock(staff, prod).setting).toBe('AGENT_ENABLED')
    // A local dev build against a server that did not name it.
    expect(workspaceBlock(status({ enabled: false }), { dev: true }).setting).toBe('AGENT_ENABLED')
    expect(workspaceBlock(status({ configured: false }), { dev: true }).setting).toBe('ANTHROPIC_API_KEY')
  })

  it('checks in order: switched off, then the key, then the process, then the allowance', () => {
    const all = status({ enabled: false, configured: false, live_available: false, allowance: { exceeded: true } })
    expect(workspaceBlock(all, prod).code).toBe('agent_disabled')
    expect(workspaceBlock({ ...all, enabled: true }, prod).code).toBe('agent_not_configured')
    expect(workspaceBlock({ ...all, enabled: true, configured: true }, prod).code).toBe('agent_unavailable')
    expect(workspaceBlock({ ...all, enabled: true, configured: true, live_available: true }, prod).code).toBe('allowance_exceeded')
  })

  it('says what to do about a missing key and a stopped agent process', () => {
    const key = workspaceBlock(status({ configured: false }), prod)
    expect(key.title).toBe("The AI agent isn't set up on this workspace.")
    expect(key.action).toBe('Ask your workspace admin to add the Anthropic API key.')
    expect(key.setting).toBe('')
    const down = workspaceBlock(status({ live_available: false }), prod)
    expect(down.title).toBe("The AI agent isn't running right now.")
    expect(down.action).toBe('Try again in a minute. If it stays down, contact support.')
    expect(down.staffNote).toBeUndefined()
    // Staff get a pointer at the process.
    const staffDown = workspaceBlock(status({ live_available: false }), { dev: true })
    expect(staffDown.staffNote).toBe('Check that the agent process is running. It also needs ANTHROPIC_API_KEY to answer.')
  })

  it('words a used-up allowance for free accounts without dollars', () => {
    const paid = workspaceBlock(status({ allowance: { exceeded: true, show_usd: true } }), prod)
    expect(paid.title).toBe("This month's AI allowance is used up.")
    expect(paid.action).toBe('It renews at the start of your next billing month.')
    const free = workspaceBlock(status({ allowance: { exceeded: true, show_usd: false } }), prod)
    expect(free.title).toBe("This month's free AI allowance is used up.")
    expect(free.title).not.toMatch(/\$/)
  })

  it("prefers the server's own setup issue words", () => {
    const s = status({
      configured: false,
      setup: { ready: false, issues: [issue('agent_not_configured', { title: 'Server title.', action: 'Server action.' })] },
    })
    expect(workspaceBlock(s, prod)).toMatchObject({ title: 'Server title.', action: 'Server action.' })
  })

  it('ignores malformed issues', () => {
    const s = status({ enabled: false, setup: { issues: [null, 'x', 4, issue('agent_disabled', { title: 7 })] } })
    expect(workspaceBlock(s, prod).title).toBe('The AI agent is turned off on this workspace.')
    expect(workspaceBlock(status({ enabled: false, setup: { issues: 'bad' } }), prod).code).toBe('agent_disabled')
  })
})

describe('researchBlock: what stops the research agents', () => {
  it('follows the server research block', () => {
    expect(researchBlock(status(), prod)).toBeNull()
    const off = status({
      swarm: { enabled: false, max_agents: 50 },
      research: { available: false, reason: 'research_disabled', message: 'The research agents are turned off on this workspace.' },
      setup: { ready: false, issues: [issue('research_disabled', { action: 'Ask your workspace admin to turn them on.' })] },
    })
    expect(researchBlock(off, prod)).toEqual({
      code: 'research_disabled',
      scope: 'research',
      title: 'The research agents are turned off on this workspace.',
      action: 'Ask your workspace admin to turn them on.',
      setting: '',
    })
  })

  it('trusts research.available over the older fields', () => {
    // The server says yes: an off-looking swarm flag from an old field does not win.
    expect(researchBlock(status({ swarm: { enabled: false } }), prod)).toBeNull()
  })

  it('names AGENT_SWARM_ENABLED to staff only', () => {
    const base = { swarm: { enabled: false }, research: { available: false, reason: 'research_disabled', message: '' } }
    expect(researchBlock(status(base), prod).setting).toBe('')
    const staff = status({ ...base, setup: { issues: [issue('research_disabled', { setting: 'AGENT_SWARM_ENABLED' })] } })
    expect(researchBlock(staff, prod).setting).toBe('AGENT_SWARM_ENABLED')
  })

  it('marks agent-wide reasons as workspace blocks', () => {
    const s = status({ research: { available: false, reason: 'allowance_exceeded', message: "This month's free AI allowance is used up." } })
    expect(researchBlock(s, prod)).toMatchObject({ code: 'allowance_exceeded', scope: 'workspace', title: "This month's free AI allowance is used up." })
  })

  it('says nothing can be measured, with every key to set for staff', () => {
    const none = ENGINES.map((e) => ({ ...e, configured: false }))
    const customer = status({
      engines: none,
      google: { configured: false, key_settings: [] },
      research: { available: false, reason: 'nothing_to_measure', message: 'Neither Google results nor any AI engine is set up on this workspace.' },
    })
    const b = researchBlock(customer, prod)
    expect(b.title).toBe('Neither Google results nor any AI engine is set up on this workspace.')
    expect(b.action).toBe('Ask your workspace admin to set up Google results or an AI engine.')
    expect(b.setting).toBe('')
    const staff = status({
      ...customer,
      engines: none.map((e) => ({ ...e, key_setting: `${e.key.toUpperCase()}_API_KEY` })),
      google: { configured: false, key_settings: ['SERPAPI_KEY', 'SCRAPERAPI_KEY'] },
    })
    expect(researchBlock(staff, prod).setting).toBe(
      'SERPAPI_KEY or SCRAPERAPI_KEY, CHATGPT_API_KEY, CLAUDE_API_KEY, GEMINI_API_KEY, GROK_API_KEY, PERPLEXITY_API_KEY'
    )
  })

  it('uses the message for an unknown reason, and a plain fallback without one', () => {
    expect(researchBlock(status({ research: { available: false, reason: 'brand_new', message: 'New reason.' } }), prod)).toMatchObject({
      code: 'brand_new',
      title: 'New reason.',
    })
    expect(researchBlock(status({ research: { available: false } }), prod)).toMatchObject({
      code: 'research_unavailable',
      title: "The research agents can't run right now.",
    })
  })

  describe('an older server without the research block', () => {
    const old = (over) => {
      const { research, setup, ...rest } = status(over)
      expect(research && setup).toBeTruthy()
      return rest
    }

    it('reads swarm.enabled', () => {
      expect(researchBlock(old(), prod)).toBeNull()
      expect(researchBlock(old({ swarm: { enabled: false } }), prod)).toMatchObject({
        code: 'research_disabled',
        title: 'The research agents are turned off on this workspace.',
      })
    })

    it('reads the workspace first', () => {
      expect(researchBlock(old({ enabled: false, swarm: { enabled: false } }), prod).code).toBe('agent_disabled')
    })

    it('needs Google or one engine', () => {
      const none = ENGINES.map((e) => ({ ...e, configured: false }))
      expect(researchBlock(old({ engines: none, google: undefined, serp_configured: false }), prod).code).toBe('nothing_to_measure')
      // One engine is enough; so is Google alone.
      expect(researchBlock(old({ engines: none.map((e, i) => ({ ...e, configured: i === 0 })), google: undefined, serp_configured: false }), prod)).toBeNull()
      expect(researchBlock(old({ engines: none }), prod)).toBeNull()
      // Not knowing the engines is not "none".
      expect(researchBlock(old({ engines: undefined, google: undefined, serp_configured: false }), prod)).toBeNull()
    })
  })
})

describe('agentBlock', () => {
  it('reads the research block for the research agents', () => {
    const s = status({ research: { available: false, reason: 'research_disabled', message: 'Off.' } })
    expect(agentBlock('research_agents', s, prod).title).toBe('Off.')
    // The writers are not stopped by the research agents being off.
    expect(agentBlock('landing_page', s, prod)).toBeNull()
    expect(agentBlock('gap_analyst', s, prod)).toBeNull()
  })

  it('stops every agent on a workspace block', () => {
    for (const key of ['gap_analyst', 'landing_page', 'pr_writer', 'research_agents']) {
      expect(agentBlock(key, status({ configured: false }), prod).code).toBe('agent_not_configured')
    }
  })

  it('stops a writer the allowance cannot start, with the amount for paid accounts', () => {
    const s = status({
      allowance: { cap_usd: '5.00', spent_usd: '4.60', exceeded: false, show_usd: true },
      writers: { landing_page: { available: false, needs_usd: '0.32' }, aeo_article: { available: true } },
    })
    expect(agentBlock('landing_page', s, prod)).toEqual({
      code: 'writer_allowance',
      scope: 'agent',
      title: 'Needs at least $0.32 of AI allowance; $0.40 left this month.',
      action: 'The allowance renews at the start of your next billing month.',
      setting: '',
    })
    expect(agentBlock('aeo_article', s, prod)).toBeNull()
    // The Gap Analyst is not a writer: no writer check.
    expect(agentBlock('gap_analyst', s, prod)).toBeNull()
    expect(agentBlock('unknown_agent', s, prod)).toBeNull()
  })
})

describe('blockHelp', () => {
  it('joins what to do with the setting and the staff note', () => {
    expect(blockHelp(null)).toBe('')
    expect(blockHelp({ action: 'Do this.', setting: '' })).toBe('Do this.')
    expect(blockHelp({ action: 'Do this.', setting: 'AGENT_ENABLED' })).toBe('Do this. Setting: AGENT_ENABLED.')
    expect(blockHelp({ action: '', setting: 'X' })).toBe('Setting: X.')
    expect(blockHelp({ action: 'Try again.', setting: '', staffNote: 'Check the process.' })).toBe('Try again. Check the process.')
  })
})

describe('allowanceLine: free prompt runs, or dollars for paid accounts', () => {
  const free = (runs, allowance = { show_usd: false, cap_usd: '3.00', spent_usd: '1.00' }) =>
    status({ prompt_runs: { unlimited: false, ...runs }, allowance })

  it('counts free prompt runs and never shows dollars to a free account', () => {
    expect(allowanceLine(free({ limit: 20, remaining: 13 }))).toBe('13 free prompt runs left this month')
    expect(allowanceLine(free({ limit: 20, remaining: 1 }))).toBe('1 free prompt run left this month')
    expect(allowanceLine(free({ limit: 20, remaining: 0 }))).toBe('No free prompt runs left this month')
    // remaining missing: from the limit, the used and the reserved.
    expect(allowanceLine(free({ limit: 20, used: 15, reserved: 2 }))).toBe('3 free prompt runs left this month')
    expect(allowanceLine(free({ limit: 20, used: 25 }))).toBe('No free prompt runs left this month')
    // Nothing usable: nothing, and still no dollars.
    expect(allowanceLine(free({}))).toBe('')
    expect(allowanceLine(free({ remaining: 'x', limit: null }))).toBe('')
  })

  it('never shows dollars when show_usd is false, even without a runs block', () => {
    expect(allowanceLine(status({ prompt_runs: undefined, allowance: { show_usd: false, cap_usd: '3.00', spent_usd: '1.00' } }))).toBe('')
  })

  it('shows what is left to a paid account the server lets see dollars', () => {
    expect(allowanceLine(status())).toBe('$26.25 of AI allowance left this month')
    expect(allowanceLine(status({ allowance: { cap_usd: '5', spent_usd: '9', show_usd: true } }))).toBe('$0.00 of AI allowance left this month')
  })

  it('says nothing for an unlimited cap, a missing show_usd or a broken amount', () => {
    expect(allowanceLine(status({ allowance: { cap_usd: 0, spent_usd: 0, show_usd: true } }))).toBe('')
    expect(allowanceLine(status({ allowance: { cap_usd: '5.00', spent_usd: '1.00' } }))).toBe('')
    expect(allowanceLine(status({ allowance: { cap_usd: '5.00', spent_usd: 'x', show_usd: true } }))).toBe('')
    expect(allowanceLine(null)).toBe('')
    expect(allowanceLine({})).toBe('')
  })

  it('hidesDollars follows show_usd and the runs block', () => {
    expect(hidesDollars(null)).toBe(false)
    expect(hidesDollars(status())).toBe(false)
    expect(hidesDollars(status({ allowance: { show_usd: false } }))).toBe(true)
    expect(hidesDollars(status({ prompt_runs: { unlimited: false, limit: 20, remaining: 4 } }))).toBe(true)
  })
})

describe('setupSummary', () => {
  it('lists what is set up and what is not, for customers without settings', () => {
    expect(setupSummary(null, prod)).toBeNull()
    expect(setupSummary(status(), prod)).toEqual({
      google: { configured: true, note: '', setting: '' },
      engines: {
        ready: ['ChatGPT', 'Claude'],
        missing: [
          { key: 'gemini', label: 'Gemini', setting: '' },
          { key: 'grok', label: 'Grok', setting: '' },
          { key: 'perplexity', label: 'Perplexity', setting: '' },
        ],
      },
      allowance: '$26.25 of AI allowance left this month',
    })
  })

  it('gives staff the settings to change', () => {
    const s = status({
      engines: ENGINES.map((e) => ({ ...e, key_setting: e.configured ? '' : `${e.key.toUpperCase()}_API_KEY` })),
      google: { configured: false, key_settings: ['SERPAPI_KEY', 'SCRAPERAPI_KEY'] },
    })
    const out = setupSummary(s, prod)
    expect(out.google).toEqual({ configured: false, note: '', setting: 'SERPAPI_KEY or SCRAPERAPI_KEY' })
    expect(out.engines.missing.map((e) => e.setting)).toEqual(['GEMINI_API_KEY', 'GROK_API_KEY', 'PERPLEXITY_API_KEY'])
  })

  it('notes Google results that cover page one only', () => {
    expect(setupSummary(status({ google: { configured: true, reliable_pages: 1, key_settings: [] } }), prod).google.note).toBe('page one only')
  })

  it('falls back to serp_configured, and says nothing when neither is sent', () => {
    expect(setupSummary(status({ google: undefined, serp_configured: false }), prod).google).toEqual({ configured: false, note: '', setting: '' })
    expect(setupSummary(status({ google: undefined, serp_configured: undefined }), prod).google).toBeNull()
  })

  it('skips malformed engine rows and treats only true as set up', () => {
    const out = setupSummary(status({ engines: [null, { label: 'No key' }, { key: 'x', configured: 'yes' }, { key: 'claude', label: 'Claude', configured: true }] }), prod)
    expect(out.engines.ready).toEqual(['Claude'])
    expect(out.engines.missing).toEqual([{ key: 'x', label: 'x', setting: '' }])
    expect(setupSummary(status({ engines: 'bad' }), prod).engines).toEqual({ ready: [], missing: [] })
  })
})

describe('the research ceiling', () => {
  it('reads swarm.max_agents', () => {
    expect(researchCeiling(status())).toBe(50)
    expect(researchCeiling(status({ swarm: { max_agents: '30' } }))).toBe(30)
    expect(researchCeiling(status({ swarm: { max_agents: 0 } }))).toBeNull()
    expect(researchCeiling(status({ swarm: { max_agents: 'lots' } }))).toBeNull()
    expect(researchCeiling(status({ swarm: undefined }))).toBeNull()
    expect(researchCeiling(null)).toBeNull()
  })

  it('counts the prompts one research covers like the server plan (plan.py max_prompts_for)', () => {
    // Google + 2 engines: 2 + 2 + 3 = 7 agents a prompt; 50 / 7 = 7, capped at 5.
    expect(researchPromptLimit(status())).toBe(MAX_RESEARCH_PROMPTS)
    expect(MAX_RESEARCH_PROMPTS).toBe(5)
    // All five engines and Google: 10 a prompt.
    const five = ENGINES.map((e) => ({ ...e, configured: true }))
    expect(researchPromptLimit(status({ engines: five }))).toBe(5)
    expect(researchPromptLimit(status({ engines: five, swarm: { max_agents: 30 } }))).toBe(3)
    expect(researchPromptLimit(status({ engines: five, swarm: { max_agents: 29 } }))).toBe(2)
    // At least one, even when one prompt does not fit.
    expect(researchPromptLimit(status({ engines: five, swarm: { max_agents: 4 } }))).toBe(1)
    // Without Google: engines + 2 + 1 (2 engines: 5 a prompt; 12 / 5 = 2).
    expect(researchPromptLimit(status({ google: { configured: false }, swarm: { max_agents: 12 } }))).toBe(2)
    // Google only: 2 + 2 = 4 a prompt.
    const none = ENGINES.map((e) => ({ ...e, configured: false }))
    expect(researchPromptLimit(status({ engines: none, swarm: { max_agents: 12 } }))).toBe(3)
    // Unknown engines count as all five.
    expect(researchPromptLimit(status({ engines: undefined, swarm: { max_agents: 30 } }))).toBe(3)
  })

  it('has no count without a ceiling or with nothing to measure', () => {
    expect(researchPromptLimit(status({ swarm: undefined }))).toBeNull()
    const none = ENGINES.map((e) => ({ ...e, configured: false }))
    expect(researchPromptLimit(status({ engines: none, google: { configured: false } }))).toBeNull()
  })
})

describe('the research plan: competitor pages', () => {
  const five = ENGINES.map((e) => ({ ...e, configured: true }))

  it('fits the competitor check (2 competitor pages a prompt) in the ceiling', () => {
    // 1 Google page + 2 competitor pages + 5 engines + 2 gaps + 1 citations = 11; 50 / 11 = 4.
    expect(researchPromptLimit(status({ engines: five }), { competitorPages: 2 })).toBe(4)
    expect(researchFit(status({ engines: five }), { competitorPages: 2 }).perPrompt).toBe(11)
    // The default plan reads one competitor page: 10 a prompt, 5 prompts.
    expect(researchPromptLimit(status({ engines: five }), {})).toBe(5)
    expect(researchFit(status({ engines: five })).perPrompt).toBe(10)
    // 4 x 11 = 44 fits; 5 x 11 = 55 would be refused (tools/swarm.py _check_size).
    const n = researchPromptLimit(status({ engines: five }), { competitorPages: 2 })
    expect(n * 11).toBeLessThanOrEqual(50)
    expect((n + 1) * 11).toBeGreaterThan(50)
    expect(researchPromptLimit(status({ engines: five, swarm: { max_agents: 30 } }), { competitorPages: 2 })).toBe(2)
    // No competitor pages: 9 a prompt.
    expect(researchFit(status({ engines: five }), { competitorPages: 0 }).perPrompt).toBe(9)
  })

  it('reads no competitor pages without Google results', () => {
    // 5 engines + 2 + 1 = 8, whatever the competitor pages.
    const noGoogle = status({ engines: five, google: { configured: false } })
    expect(researchFit(noGoogle, { competitorPages: 2 }).perPrompt).toBe(8)
    expect(researchPromptLimit(noGoogle, { competitorPages: 2 })).toBe(5)
  })

  it('ignores a bad competitor page count', () => {
    expect(researchFit(status({ engines: five }), { competitorPages: 'x' }).perPrompt).toBe(9)
    expect(researchFit(status({ engines: five }), { competitorPages: -3 }).perPrompt).toBe(9)
    expect(researchFit(status({ engines: five }), undefined).perPrompt).toBe(10)
  })
})

describe('the research plan: free prompt runs', () => {
  const five = ENGINES.map((e) => ({ ...e, configured: true }))
  // A free account: runs counted, no dollars.
  const free = (runs, over = {}) =>
    status({
      engines: five,
      allowance: { cap_usd: '3.00', spent_usd: '0.00', exceeded: false, show_usd: false },
      prompt_runs: { unlimited: false, limit: 20, used: 0, reserved: 0, ...runs },
      ...over,
    })

  it('reads the runs left: remaining, else limit - used - reserved', () => {
    expect(promptRunsLeft(free({ remaining: 3 }))).toBe(3)
    expect(promptRunsLeft(free({ remaining: undefined, used: 15, reserved: 2 }))).toBe(3)
    expect(promptRunsLeft(free({ remaining: undefined, used: 25 }))).toBe(0)
    expect(promptRunsLeft(free({ remaining: undefined, limit: null }))).toBeNull()
    expect(promptRunsLeft(status())).toBeNull()
    expect(promptRunsLeft(status({ prompt_runs: undefined }))).toBeNull()
    expect(promptRunsLeft(null)).toBeNull()
  })

  it('caps the prompts at the runs left over the engines set up', () => {
    // A new free account: 20 runs, 5 engines: 4 prompts (20 runs), not 5 (25).
    expect(researchPromptLimit(free({ remaining: 20 }))).toBe(4)
    expect(researchFit(free({ remaining: 20 })).limitedBy).toBe('runs')
    // 13 left: 2 prompts (10 runs).
    expect(researchPromptLimit(free({ remaining: 13 }))).toBe(2)
    // 5 left: exactly one prompt on every engine.
    expect(researchPromptLimit(free({ remaining: 5 }))).toBe(1)
    // Plenty left: the ceiling limits it.
    const big = free({ limit: 100, remaining: 100 })
    expect(researchPromptLimit(big)).toBe(5)
    expect(researchFit(big).limitedBy).toBe('ceiling')
    expect(researchFit(big).short).toBe('')
    // The runs and the competitor pages together: the smaller wins.
    expect(researchPromptLimit(free({ limit: 100, remaining: 100 }), { competitorPages: 2 })).toBe(4)
    expect(researchPromptLimit(free({ remaining: 10 }), { competitorPages: 2 })).toBe(2)
  })

  it('never offers a plan the runs left cannot pay for', () => {
    for (let left = 0; left <= 30; left += 1) {
      for (let k = 1; k <= 5; k += 1) {
        const engines = ENGINES.map((e, i) => ({ ...e, configured: i < k }))
        const n = researchPromptLimit(free({ remaining: left }, { engines }))
        if (n === null) expect(left, `${left} left, ${k} engines`).toBeLessThan(k)
        else expect(n * k, `${left} left, ${k} engines`).toBeLessThanOrEqual(left)
      }
    }
  })

  it('has no prompt count when not even one prompt fits, and says why', () => {
    // The reviewer's case: 3 left, 5 engines.
    const few = researchFit(free({ remaining: 3 }))
    expect(few.prompts).toBeNull()
    expect(few.short).toBe('few_runs')
    expect(researchPromptLimit(free({ remaining: 3 }))).toBeNull()
    const none = researchFit(free({ remaining: 0 }))
    expect(none.prompts).toBeNull()
    expect(none.short).toBe('no_runs')
    expect(none.runsLeft).toBe(0)
  })

  it('counts only the engines set up', () => {
    // 2 engines set up, 3 left: one prompt.
    expect(researchPromptLimit(free({ remaining: 3 }, { engines: ENGINES }))).toBe(1)
    // Unknown engines count as all five.
    expect(researchPromptLimit(free({ remaining: 9 }, { engines: undefined }))).toBe(1)
    expect(researchFit(free({ remaining: 9 }, { engines: undefined })).enginesKnown).toBe(false)
  })

  it('needs no runs for Google results alone', () => {
    const none = ENGINES.map((e) => ({ ...e, configured: false }))
    const fit = researchFit(free({ remaining: 0 }, { engines: none }))
    // 1 Google page + 1 competitor page + 2 gaps = 4; 50 / 4 = 12, capped at 5.
    expect(fit.prompts).toBe(5)
    expect(fit.short).toBe('')
    expect(fit.limitedBy).toBe('ceiling')
  })

  it('leaves a paid account on the ceiling', () => {
    expect(researchPromptLimit(status({ engines: five }))).toBe(5)
    expect(researchFit(status({ engines: five })).runsLeft).toBeNull()
    // A paid account whose server hides dollars but counts no runs.
    expect(researchPromptLimit(status({ engines: five, allowance: { show_usd: false } }))).toBe(5)
  })

  it('words what the runs left allow', () => {
    expect(researchRunsLine(researchFit(free({ remaining: 13 })))).toBe(
      'With 13 free prompt runs left and 5 AI engines set up, one research covers up to 2 prompts.'
    )
    expect(researchRunsLine(researchFit(free({ remaining: 5 })))).toBe(
      'With 5 free prompt runs left and 5 AI engines set up, one research covers up to 1 prompt.'
    )
    const one = [{ key: 'chatgpt', label: 'ChatGPT', configured: true }]
    expect(researchRunsLine(researchFit(free({ remaining: 3 }, { engines: one, swarm: { max_agents: 50 } })))).toBe(
      'With 3 free prompt runs left and 1 AI engine set up, one research covers up to 3 prompts.'
    )
    expect(researchRunsLine(researchFit(free({ remaining: 3 })))).toBe(
      '3 free prompt runs left: one prompt asks all 5 AI engines set up here, so ask for fewer engines.'
    )
    expect(researchRunsLine(researchFit(free({ remaining: 1 })))).toBe(
      '1 free prompt run left: one prompt asks all 5 AI engines set up here, so ask for fewer engines.'
    )
    expect(researchRunsLine(researchFit(free({ remaining: 0 })))).toBe(
      'No free prompt runs are left this month, so a research cannot ask the AI engines until they renew.'
    )
    // The ceiling limits it, or no runs are counted: nothing to add.
    expect(researchRunsLine(researchFit(free({ limit: 100, remaining: 100 })))).toBe('')
    expect(researchRunsLine(researchFit(status()))).toBe('')
    expect(researchRunsLine(null)).toBe('')
  })

  it('words the runs a research takes', () => {
    const fit = researchFit(free({ remaining: 13 }))
    expect(researchRunsCost(fit, 2)).toBe('Up to 2 prompts × 5 AI engines = 10 free prompt runs; 13 left this month.')
    expect(researchRunsCost(fit, 1)).toBe('Up to 1 prompt × 5 AI engines = 5 free prompt runs; 13 left this month.')
    const one = [{ key: 'chatgpt', label: 'ChatGPT', configured: true }]
    expect(researchRunsCost(researchFit(free({ remaining: 1 }, { engines: one })), 1)).toBe(
      'Up to 1 prompt × 1 AI engine = 1 free prompt run; 1 left this month.'
    )
    // Unknown prompts, runs or engines, or Google only: nothing stated.
    expect(researchRunsCost(fit, null)).toBe('')
    expect(researchRunsCost(fit, 0)).toBe('')
    expect(researchRunsCost(researchFit(status()), 2)).toBe('')
    expect(researchRunsCost(researchFit(free({ remaining: 9 }, { engines: undefined })), 1)).toBe('')
    const none = ENGINES.map((e) => ({ ...e, configured: false }))
    expect(researchRunsCost(researchFit(free({ remaining: 9 }, { engines: none })), 3)).toBe('')
    expect(researchRunsCost(null, 2)).toBe('')
  })
})

describe('listNames', () => {
  it('joins labels in plain English', () => {
    expect(listNames([])).toBe('')
    expect(listNames(['ChatGPT'])).toBe('ChatGPT')
    expect(listNames(['ChatGPT', 'Claude'])).toBe('ChatGPT and Claude')
    expect(listNames(['ChatGPT', '', 'Claude', 'Gemini'])).toBe('ChatGPT, Claude and Gemini')
    expect(listNames(null)).toBe('')
  })
})
