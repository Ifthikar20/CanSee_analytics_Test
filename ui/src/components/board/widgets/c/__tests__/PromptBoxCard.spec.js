import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises } from '@vue/test-utils'

const promptBox = vi.hoisted(() => ({
    estimate: vi.fn(),
    create: vi.fn(),
    list: vi.fn(),
    get: vi.fn(),
    cancel: vi.fn(),
    track: vi.fn(),
}))
vi.mock('@/api/promptBox', () => ({ default: promptBox }))
const agent = vi.hoisted(() => ({ askAgent: vi.fn(async () => true) }))
vi.mock('@/lib/agent/askAgent', () => agent)
vi.mock('@/composables/board/useBoardSource', () => import('./__fixtures__/board'))

const { mountOnBoard, resetSources, setSource } = await import('./__fixtures__/board')
const { doneRun, estimatePayload, httpError, ok, overviewEngines, rankingPayload, runPayload, summaryOf } = await import(
    './__fixtures__/payloads'
)
const { POLL_MS } = await import('../specs')
const { resetPromptBoxNotes } = await import('../usePromptBoxRun')
const { default: PromptBoxCard } = await import('../PromptBoxCard.vue')

const mounted = []

async function render({ runs = [], props = {} } = {}) {
    promptBox.list.mockResolvedValue(ok(runs))
    const out = await mountOnBoard(PromptBoxCard, { props: { size: 'full', ...props } })
    mounted.push(out.wrapper)
    return out
}

const input = (wrapper) => wrapper.find('textarea')
const line = (wrapper) => wrapper.find('.pb-line').text()
const askButton = (wrapper) => wrapper.findAll('button').find((b) => b.text() === 'Ask')
const button = (wrapper, label) => wrapper.findAll('button').find((b) => b.text() === label)
const engineRows = (wrapper) =>
    wrapper.findAll('.pb-engine').map((row) => ({
        label: row.find('.bd-bars-label').text(),
        value: row.find('.bd-bars-value').text(),
        hint: row.find('.bd-bars-hint').exists() ? row.find('.bd-bars-hint').text() : '',
        notes: row.findAll('.pb-note').map((n) => n.text()),
    }))

// Type into the box, then let the 400ms estimate go out and answer.
async function type(wrapper, text) {
    await input(wrapper).setValue(text)
    await vi.advanceTimersByTimeAsync(400)
    await flushPromises()
}

beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    resetSources()
    resetPromptBoxNotes()
    Object.values(promptBox).forEach((fn) => fn.mockReset())
    agent.askAgent.mockClear()
    setSource('overview', { data: overviewEngines() })
    setSource('ranking', { data: rankingPayload() })
    promptBox.estimate.mockResolvedValue(ok(estimatePayload()))
})

afterEach(() => {
    while (mounted.length) mounted.pop().unmount()
    vi.useRealTimers()
    document.body.innerHTML = ''
})

describe('PromptBoxCard', () => {
    it('shows a skeleton until the runs answer, then the box and why to ask several times', async () => {
        let answer
        promptBox.list.mockReturnValue(new Promise((resolve) => (answer = resolve)))
        const { wrapper } = await mountOnBoard(PromptBoxCard, { props: { size: 'full' } })
        mounted.push(wrapper)
        expect(wrapper.find('.bd-skel').exists()).toBe(true)
        answer(ok([]))
        await flushPromises()
        const box = input(wrapper)
        expect(box.attributes('placeholder')).toBe(
            'Type a question a buyer would ask, for example: best note taking app for small teams',
        )
        expect(wrapper.find(`label[for="${box.attributes('id')}"]`).text()).toBe('Question')
        expect(wrapper.find('.pb-intro').text()).toBe(
            'One answer can misjudge you. Asking several times shows how often each engine really names you.',
        )
        expect(wrapper.find('select').element.value).toBe('3')
        expect(wrapper.find('.pb-times').text()).toContain('Times per engine')
        expect(wrapper.findAll('select option').map((o) => o.text())).toEqual(['1', '3', '5', '10'])
        expect(wrapper.findAll('.pb-chip').map((c) => [c.text(), c.attributes('aria-pressed')])).toEqual([
            ['ChatGPT', 'true'],
            ['Claude', 'true'],
        ])
    })

    it("says so when the runs can't load, and Try again asks again", async () => {
        promptBox.list.mockRejectedValueOnce(httpError(500))
        const { wrapper } = await mountOnBoard(PromptBoxCard, { props: { size: 'full' } })
        mounted.push(wrapper)
        expect(wrapper.find('.pb-state-title').text()).toBe("We couldn't load Ask AI.")
        promptBox.list.mockResolvedValueOnce(ok([]))
        await button(wrapper, 'Try again').trigger('click')
        await flushPromises()
        expect(input(wrapper).exists()).toBe(true)
    })

    it('estimates 400ms after a change, with the count and the engines chosen', async () => {
        const { wrapper } = await render()
        await input(wrapper).setValue('best crm for startups')
        await vi.advanceTimersByTimeAsync(399)
        expect(promptBox.estimate).not.toHaveBeenCalled()
        await vi.advanceTimersByTimeAsync(1)
        await flushPromises()
        expect(promptBox.estimate).toHaveBeenCalledWith('w1', {
            text: 'best crm for startups',
            samples: 3,
            engines: ['chatgpt', 'claude'],
        })
        expect(line(wrapper)).toBe('6 answers, up to $0.48 of your AI allowance ($2.24 left this month).')

        promptBox.estimate.mockResolvedValueOnce(ok(estimatePayload({ answers: 10, usd_max: '0.8000' })))
        await wrapper.find('select').setValue('5')
        await vi.advanceTimersByTimeAsync(400)
        await flushPromises()
        expect(promptBox.estimate).toHaveBeenLastCalledWith('w1', { text: 'best crm for startups', samples: 5, engines: ['chatgpt', 'claude'] })
        expect(line(wrapper)).toBe('10 answers, up to $0.80 of your AI allowance ($2.24 left this month).')

        // Claude off; the last engine left cannot be turned off.
        await wrapper.findAll('.pb-chip')[1].trigger('click')
        await vi.advanceTimersByTimeAsync(400)
        await flushPromises()
        expect(promptBox.estimate).toHaveBeenLastCalledWith('w1', { text: 'best crm for startups', samples: 5, engines: ['chatgpt'] })
        const chatgpt = wrapper.findAll('.pb-chip')[0]
        expect(chatgpt.attributes('aria-disabled')).toBe('true')
        await chatgpt.trigger('click')
        expect(chatgpt.attributes('aria-pressed')).toBe('true')
        await vi.advanceTimersByTimeAsync(400)
        expect(promptBox.estimate).toHaveBeenCalledTimes(3)

        // Nothing goes out under 3 characters.
        await input(wrapper).setValue('ab')
        await vi.advanceTimersByTimeAsync(400)
        expect(promptBox.estimate).toHaveBeenCalledTimes(3)
        expect(line(wrapper)).toBe('')
    })

    it('keeps Ask and Enter inert until the estimate for what is on screen has arrived', async () => {
        let answer
        promptBox.estimate.mockReturnValueOnce(new Promise((resolve) => (answer = resolve)))
        promptBox.create.mockResolvedValue(ok(runPayload()))
        const { wrapper } = await render()
        await input(wrapper).setValue('best crm for startups')
        expect(askButton(wrapper).attributes('disabled')).toBeDefined()
        await input(wrapper).trigger('keydown', { key: 'Enter' })
        await vi.advanceTimersByTimeAsync(400)
        await input(wrapper).trigger('keydown', { key: 'Enter' })
        await askButton(wrapper).trigger('click')
        expect(promptBox.create).not.toHaveBeenCalled()

        answer(ok(estimatePayload()))
        await flushPromises()
        expect(askButton(wrapper).attributes('disabled')).toBeUndefined()

        // A new word: the shown line is for the old text until its own estimate lands.
        let second
        promptBox.estimate.mockReturnValueOnce(new Promise((resolve) => (second = resolve)))
        await input(wrapper).setValue('best crm for small startups')
        expect(askButton(wrapper).attributes('disabled')).toBeDefined()
        expect(wrapper.find('.pb-line').classes()).toContain('is-pending')
        await input(wrapper).trigger('keydown', { key: 'Enter' })
        expect(promptBox.create).not.toHaveBeenCalled()
        await vi.advanceTimersByTimeAsync(400)
        second(ok(estimatePayload({ confirm: { answers: 6, ai_usd_max: '0.4800' } })))
        await flushPromises()

        await input(wrapper).trigger('keydown', { key: 'Enter' })
        await flushPromises()
        expect(promptBox.create).toHaveBeenCalledTimes(1)
        expect(promptBox.create).toHaveBeenCalledWith('w1', {
            text: 'best crm for small startups',
            samples: 3,
            engines: ['chatgpt', 'claude'],
            confirm: { answers: 6, ai_usd_max: '0.4800' },
        })
    })

    it('replaces the line with a blocker and keeps Ask off', async () => {
        promptBox.estimate.mockResolvedValue(
            ok(
                estimatePayload({
                    can_run: false,
                    blockers: [{ code: 'daily_limit', message: 'This project used its 100 Ask AI answers for today. Try again tomorrow.' }],
                }),
            ),
        )
        const { wrapper } = await render()
        await type(wrapper, 'best crm for startups')
        expect(line(wrapper)).toBe('This project used its 100 Ask AI answers for today. Try again tomorrow.')
        expect(askButton(wrapper).attributes('disabled')).toBeDefined()
    })

    it('leaves the allowance out when it is unlimited, and refuses a question over 300 characters', async () => {
        promptBox.estimate.mockResolvedValue(ok(estimatePayload({ allowance: { unlimited: true, left_usd: null } })))
        const { wrapper } = await render()
        await type(wrapper, 'best crm for startups')
        expect(line(wrapper)).toBe('6 answers, up to $0.48.')
        await type(wrapper, 'x'.repeat(301))
        expect(line(wrapper)).toBe('Ask one question, up to 300 characters.')
        expect(promptBox.estimate).toHaveBeenCalledTimes(1)
        expect(askButton(wrapper).attributes('disabled')).toBeDefined()
    })

    it('keeps the box one line: a line break becomes a space', async () => {
        const { wrapper } = await render()
        await input(wrapper).setValue('best crm\nfor startups')
        expect(input(wrapper).element.value).toBe('best crm for startups')
    })

    it('steers a question about your own data to the agent, or asks the engines anyway', async () => {
        promptBox.create.mockResolvedValue(ok(runPayload({ text: 'how is my visibility doing' })))
        const { wrapper, router } = await render()
        await type(wrapper, 'how is my visibility doing')
        await askButton(wrapper).trigger('click')
        const notice = wrapper.find('.pb-notice')
        expect(notice.attributes('role')).toBe('alert')
        expect(notice.find('.pb-notice-title').text()).toBe('This looks like a question for the agent.')
        expect(notice.find('.pb-notice-body').text()).toBe(
            "Ask AI puts a buyer's question to the AI engines. To ask about your own data, ask the agent.",
        )
        expect(promptBox.create).not.toHaveBeenCalled()

        await button(wrapper, 'Ask the agent').trigger('click')
        expect(agent.askAgent).toHaveBeenCalledWith(router, {
            websiteId: 'w1',
            from: 'prompt-box',
            text: 'how is my visibility doing',
        })
        expect(promptBox.create).not.toHaveBeenCalled()

        await button(wrapper, 'Ask the engines anyway').trigger('click')
        await flushPromises()
        expect(promptBox.create).toHaveBeenCalledWith('w1', expect.objectContaining({ text: 'how is my visibility doing' }))
        expect(wrapper.find('.pb-notice').exists()).toBe(false)
    })

    it('asks with the confirm it showed, follows the run until it ends, and Stop stops it', async () => {
        promptBox.create.mockResolvedValue(ok(runPayload()))
        promptBox.get.mockResolvedValueOnce(ok(runPayload({ progress: { total: 6, done: 4, failed: 0, running: 2 } })))
        promptBox.cancel.mockResolvedValue(ok(runPayload({ progress: { total: 6, done: 4, failed: 0, running: 2 } })))
        const { wrapper } = await render()
        await type(wrapper, 'best note taking app for small teams')
        await askButton(wrapper).trigger('click')
        await flushPromises()
        expect(promptBox.create).toHaveBeenCalledWith('w1', {
            text: 'best note taking app for small teams',
            samples: 3,
            engines: ['chatgpt', 'claude'],
            confirm: { answers: 6, ai_usd_max: '0.4800' },
        })
        expect(wrapper.find('.pb-question').text()).toBe('best note taking app for small teams')
        expect(wrapper.find('.pb-progress-line').text()).toBe('Asking... 2 of 6 answers')
        expect(wrapper.find('.pb-progress-line').attributes('role')).toBe('status')
        // One run at a time.
        expect(askButton(wrapper).attributes('disabled')).toBeDefined()

        await vi.advanceTimersByTimeAsync(POLL_MS)
        await flushPromises()
        expect(promptBox.get).toHaveBeenCalledWith('w1', 'r-1')
        expect(wrapper.find('.pb-progress-line').text()).toBe('Asking... 4 of 6 answers')

        await button(wrapper, 'Stop').trigger('click')
        await flushPromises()
        expect(promptBox.cancel).toHaveBeenCalledWith('w1', 'r-1')

        promptBox.get.mockResolvedValueOnce(
            ok(doneRun({ status: 'cancelled', progress: { total: 6, done: 4, failed: 0, running: 0 } })),
        )
        await vi.advanceTimersByTimeAsync(POLL_MS)
        await flushPromises()
        expect(wrapper.find('.pb-progress-line').exists()).toBe(false)
        expect(wrapper.text()).toContain('Stopped after 4 of 6 answers.')
        // A run that ended asks for the line again (what is left changed).
        expect(promptBox.estimate).toHaveBeenCalledTimes(2)
        await vi.advanceTimersByTimeAsync(POLL_MS * 5)
        expect(promptBox.get).toHaveBeenCalledTimes(2)
    })

    it('shows the new cost when it changed, and asks again with it', async () => {
        const changed = estimatePayload({ answers: 6, usd_max: '0.9600', confirm: { answers: 6, ai_usd_max: '0.9600' } })
        promptBox.create
            .mockRejectedValueOnce(httpError(409, 'estimate_changed', 'The cost changed. Check the new estimate and confirm again.', { estimate: changed }))
            .mockResolvedValueOnce(ok(runPayload()))
        const { wrapper } = await render()
        await type(wrapper, 'best crm for startups')
        await askButton(wrapper).trigger('click')
        await flushPromises()
        expect(line(wrapper)).toBe('6 answers, up to $0.96 of your AI allowance ($2.24 left this month).')
        expect(wrapper.text()).toContain('The cost changed. Check it and ask again.')
        await askButton(wrapper).trigger('click')
        await flushPromises()
        expect(promptBox.create).toHaveBeenLastCalledWith('w1', expect.objectContaining({ confirm: { answers: 6, ai_usd_max: '0.9600' } }))
    })

    it("shows the latest run: each engine's share with its likely range, and No answers at 0", async () => {
        const run = doneRun()
        promptBox.get.mockResolvedValue(ok(run))
        const { wrapper, board } = await render({ runs: [summaryOf(run)] })
        expect(promptBox.get).toHaveBeenCalledWith('w1', 'r-1')
        expect(engineRows(wrapper)).toEqual([
            { label: 'ChatGPT', value: 'No answers', hint: '', notes: ['3 answers failed: The engine did not respond in time.'] },
            {
                label: 'Claude: named in 2 of 3 answers',
                value: '67%',
                hint: 'Likely 21% to 94%',
                notes: ['Average rank #1.5 when named'],
            },
        ])
        // Every bar is you: the accent; no bar for an engine with no answer.
        expect(wrapper.findAll('.bd-bars-fill')).toHaveLength(1)
        expect(wrapper.find('.bd-bars-fill').classes()).toContain('is-you')
        expect(wrapper.find('.bd-foot-text').text()).toBe(
            'These answers stay here. Tracked prompts are measured the same way every day by Autopilot.',
        )
        await button(wrapper, 'Read the answers').trigger('click')
        expect(board.open).toHaveBeenCalledWith('prompt-box', { run: 'r-1' })
    })

    it('tracks the question: Autopilot asks it from its next run', async () => {
        const run = doneRun()
        promptBox.get.mockResolvedValue(ok(run))
        promptBox.track.mockResolvedValue(ok({ id: 'p-7', brand_prompt_id: 'bp-7' }))
        const { wrapper, board } = await render({ runs: [summaryOf(run)] })
        await button(wrapper, 'Track this prompt').trigger('click')
        await flushPromises()
        expect(promptBox.track).toHaveBeenCalledWith('w1', 'best note taking app for small teams')
        expect(wrapper.find('.pb-track-note').text()).toBe('Tracked. Autopilot asks it from its next run.')
        expect(board.invalidate.mock.calls.map((c) => c[0])).toEqual(['ranking', 'overview', 'visibility'])
    })

    it('tracks the question and says to turn Autopilot on when it is off', async () => {
        setSource('ranking', { data: rankingPayload({ autopilot: { enabled: false, last_run: null, next_run_at: null } }) })
        const run = doneRun()
        promptBox.get.mockResolvedValue(ok(run))
        promptBox.track.mockResolvedValue(ok({ id: 'p-7', brand_prompt_id: 'bp-7' }))
        const { wrapper } = await render({ runs: [summaryOf(run)] })
        await button(wrapper, 'Track this prompt').trigger('click')
        await flushPromises()
        const note = wrapper.find('.pb-track-note')
        expect(note.text()).toBe('Tracked. Turn on Autopilot to check it every day.')
        expect(note.find('a').attributes('href')).toBe('/settings/autopilot')
    })

    it("says when the plan is full, and nothing was tracked", async () => {
        const run = doneRun()
        promptBox.get.mockResolvedValue(ok(run))
        const message = 'Your plan tracks up to 5 prompts and 5 are tracked. Archive some or choose the 100 or 200 prompt plan.'
        promptBox.track.mockRejectedValue(httpError(403, 'tracked_prompt_limit', message, { limit: 5, used: 5, adding: 1 }))
        const { wrapper, board } = await render({ runs: [summaryOf(run)] })
        await button(wrapper, 'Track this prompt').trigger('click')
        await flushPromises()
        const note = wrapper.find('.pb-track-note')
        expect(note.attributes('role')).toBe('alert')
        expect(note.text()).toBe(`${message} See plans`)
        expect(note.find('a').attributes('href')).toBe('/billing')
        expect(board.invalidate).not.toHaveBeenCalled()
        expect(button(wrapper, 'Track this prompt')).toBeTruthy()
    })

    it('says when the question is already tracked, and opens it', async () => {
        const run = doneRun({ tracked: { prompt_id: 'p-9', brand_prompt_id: 'bp-9' } })
        promptBox.get.mockResolvedValue(ok(run))
        const { wrapper, board } = await render({ runs: [summaryOf(run)] })
        expect(button(wrapper, 'Track this prompt')).toBeUndefined()
        expect(wrapper.find('.pb-track-note').text()).toBe('You already track this prompt.')
        await button(wrapper, 'Open it').trigger('click')
        expect(board.open).toHaveBeenCalledWith('prompts', { prompt: 'p-9' })
    })

    it("says why the cost couldn't be read, keeps Ask off, and Try again asks for it", async () => {
        promptBox.estimate.mockRejectedValueOnce(httpError(500, 'error', 'Something went wrong on our end. Please try again.'))
        const { wrapper } = await render()
        await type(wrapper, 'best crm for startups')
        expect(line(wrapper)).toBe('Something went wrong on our end. Please try again.')
        expect(askButton(wrapper).attributes('disabled')).toBeDefined()
        await button(wrapper, 'Try again').trigger('click')
        await flushPromises()
        expect(promptBox.estimate).toHaveBeenCalledTimes(2)
        expect(line(wrapper)).toBe('6 answers, up to $0.48 of your AI allowance ($2.24 left this month).')
        expect(askButton(wrapper).attributes('disabled')).toBeUndefined()
    })

    it('tells a viewer that only members can ask', async () => {
        promptBox.estimate.mockRejectedValue(httpError(404, 'not_found', 'Not found.'))
        const { wrapper } = await render()
        await type(wrapper, 'best crm for startups')
        expect(line(wrapper)).toBe('Only members of this project can ask.')
        expect(askButton(wrapper).attributes('disabled')).toBeDefined()
        expect(input(wrapper).attributes('disabled')).toBeDefined()
    })

    it("says AI engines aren't available yet and locks the box without a configured engine", async () => {
        setSource('overview', { data: overviewEngines([]) })
        const { wrapper } = await render()
        expect(line(wrapper)).toBe("AI engines aren't available yet.")
        expect(input(wrapper).attributes('disabled')).toBeDefined()
        expect(wrapper.findAll('.pb-chip')).toHaveLength(0)
        expect(promptBox.estimate).not.toHaveBeenCalled()
    })

    it('shows a run already asking for this project when Ask finds one', async () => {
        promptBox.create.mockRejectedValue(
            httpError(409, 'run_in_progress', 'A question is already being asked for this project.', { run_id: 'r-5' }),
        )
        promptBox.get.mockResolvedValue(ok(runPayload({ id: 'r-5', text: 'best wiki for teams' })))
        const { wrapper } = await render()
        await type(wrapper, 'best crm for startups')
        await askButton(wrapper).trigger('click')
        await flushPromises()
        expect(wrapper.find('.pb-error').text()).toBe('A question is already being asked for this project.')
        expect(promptBox.get).toHaveBeenCalledWith('w1', 'r-5')
        expect(wrapper.find('.pb-question').text()).toBe('best wiki for teams')
    })
})
