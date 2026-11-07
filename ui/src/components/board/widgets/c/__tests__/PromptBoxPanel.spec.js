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
vi.mock('@/composables/board/useBoardSource', () => import('./__fixtures__/board'))

const { mountOnBoard, resetSources, setSource } = await import('./__fixtures__/board')
const { doneRun, fullRun, httpError, ok, rankingPayload, runPayload, summaryOf } = await import('./__fixtures__/payloads')
const { noteRunAsked, resetPromptBoxNotes } = await import('../usePromptBoxRun')
const { default: PromptBoxPanel } = await import('../PromptBoxPanel.vue')

const mounted = []

const FIRST = doneRun({ id: 'r-2', text: 'best wiki for small teams', created_at: new Date().toISOString() })
const OLDER = doneRun({ id: 'r-1', created_at: '2026-11-02T09:00:00Z' })

function answerGets(runs) {
    promptBox.get.mockImplementation(async (wid, id, opts = {}) => {
        const run = runs.find((r) => r.id === id)
        if (!run) throw httpError(404, 'not_found', 'Run not found.')
        return ok(opts.full ? fullRun(run) : run)
    })
}

async function render(path = '/projects/w1/analytics?widget=prompt-box') {
    const out = await mountOnBoard(PromptBoxPanel, { panel: true, path })
    mounted.push(out.wrapper)
    return out
}

const button = (wrapper, label) => wrapper.findAll('button').find((b) => b.text() === label)

beforeEach(() => {
    resetSources()
    resetPromptBoxNotes()
    Object.values(promptBox).forEach((fn) => fn.mockReset())
    setSource('ranking', { data: rankingPayload() })
    promptBox.list.mockResolvedValue(ok([summaryOf(FIRST), summaryOf(OLDER)]))
    answerGets([FIRST, OLDER])
})

afterEach(() => {
    while (mounted.length) mounted.pop().unmount()
    document.body.innerHTML = ''
})

describe('PromptBoxPanel', () => {
    it('shows the latest run when none is named: the question, each engine and every answer', async () => {
        const { wrapper } = await render()
        expect(promptBox.get).toHaveBeenCalledWith('w1', 'r-2')
        expect(wrapper.find('h3.pbp-question').text()).toBe('best wiki for small teams')
        expect(wrapper.find('.pbp-meta').text()).toBe('Asked just now, 3 per engine, AI $0.07')

        const engines = wrapper.findAll('.pbp-engine')
        expect(engines.map((e) => e.find('h3').text())).toEqual(['ChatGPT', 'Claude'])
        expect(engines[0].find('.pbp-engine-line').text()).toBe('No answers')
        expect(engines[1].find('.pbp-engine-line').text()).toBe('Named in 2 of 3 answers')
        expect(engines[1].findAll('.pbp-note').map((n) => n.text()).slice(0, 2)).toEqual([
            'Likely 21% to 94%',
            'Average rank #1.5 when named',
        ])

        const heads = (engine) => engine.findAll('.pbp-answer-head').map((h) => h.findAll('span').map((s) => s.text()))
        expect(heads(engines[0])).toEqual([
            ['Answer 1', 'Failed: The engine did not respond in time.'],
            ['Answer 2', 'Failed: The engine did not respond in time.'],
            ['Answer 3', 'Failed: The engine did not respond in time.'],
        ])
        expect(heads(engines[1])).toEqual([
            ['Answer 1', 'Named, rank #1', 'Positive'],
            ['Answer 2', 'Named, rank #2', 'Neutral'],
            ['Answer 3', 'Not named'],
        ])
        const first = engines[1].findAll('.pbp-answer')[0]
        expect(first.findAll('.pbp-note').map((n) => n.text())).toEqual(['Also named: Obsidian', '4 sources'])
        expect(first.find('.pbp-excerpt').text()).toBe('Obsidian and Notion are the usual picks for small teams.')
        // A failed answer has nothing to read.
        expect(engines[0].findAll('button').length).toBe(0)
    })

    it('shows the run named in the panel key, and Recent questions switch it', async () => {
        const { wrapper, board, router } = await render('/projects/w1/analytics?widget=prompt-box&run=r-1')
        expect(promptBox.get).toHaveBeenCalledWith('w1', 'r-1')
        expect(wrapper.find('h3.pbp-question').text()).toBe('best note taking app for small teams')

        const rows = wrapper.findAll('.pbp-recent-row')
        expect(wrapper.find('.pbp-recent-title').text()).toBe('Recent questions')
        expect(rows.map((r) => r.find('.pbp-recent-text').text())).toEqual(['best wiki for small teams', 'best note taking app for small teams'])
        expect(rows[1].attributes('aria-current')).toBe('true')
        expect(rows[0].attributes('aria-current')).toBeUndefined()
        expect(rows[0].findAll('.pbp-recent-meta span').slice(1).map((s) => s.text())).toEqual(['ChatGPT: No answers', 'Claude: 2/3'])

        await rows[0].trigger('click')
        expect(board.open).toHaveBeenCalledWith('prompt-box', { run: 'r-2' })
        await router.replace('/projects/w1/analytics?widget=prompt-box&run=r-2')
        await flushPromises()
        expect(promptBox.get).toHaveBeenLastCalledWith('w1', 'r-2')
        expect(wrapper.find('h3.pbp-question').text()).toBe('best wiki for small teams')
        expect(document.activeElement).toBe(wrapper.find('h3.pbp-question').element)
    })

    it('loads the full text once, and opens cited links in a new tab', async () => {
        const { wrapper } = await render()
        const claude = () => wrapper.findAll('.pbp-engine')[1]
        await claude().findAll('.pbp-answer')[0].find('button').trigger('click')
        await flushPromises()
        expect(promptBox.get).toHaveBeenCalledWith('w1', 'r-2', { full: true })
        const full = claude().findAll('.pbp-answer')[0].find('.pbp-full')
        expect(full.find('.pbp-full-text').text()).toBe('Full answer claude-1.\nSecond paragraph.')
        const links = full.findAll('a')
        // A link that is not http(s) is never drawn.
        expect(links).toHaveLength(1)
        expect(links[0].attributes('href')).toBe('https://example.com/notes')
        expect(links[0].attributes('target')).toBe('_blank')
        expect(links[0].attributes('rel')).toBe('noopener')
        expect(links[0].text()).toBe('example.com/notes')

        await claude().findAll('.pbp-answer')[1].find('button').trigger('click')
        await flushPromises()
        expect(claude().findAll('.pbp-answer')[1].find('.pbp-full-text').text()).toBe('Full answer claude-2.\nSecond paragraph.')
        expect(promptBox.get.mock.calls.filter((c) => c[2]?.full)).toHaveLength(1)
    })

    it('says why the full text did not load, and leaves the excerpt', async () => {
        const { wrapper } = await render()
        promptBox.get.mockRejectedValueOnce(httpError(500, 'error', 'Something went wrong on our end. Please try again.'))
        const answer = () => wrapper.findAll('.pbp-engine')[1].findAll('.pbp-answer')[0]
        await answer().find('button').trigger('click')
        await flushPromises()
        expect(answer().find('.pbp-error').text()).toBe('Something went wrong on our end. Please try again.')
        expect(answer().find('.pbp-excerpt').exists()).toBe(true)
    })

    it('follows a run that is still asking, with Stop, and lists a new question asked from the card', async () => {
        const asking = runPayload({ id: 'r-3', created_at: new Date().toISOString() })
        promptBox.list.mockResolvedValue(ok([summaryOf(asking), summaryOf(FIRST)]))
        answerGets([asking, FIRST])
        promptBox.cancel.mockResolvedValue(ok(asking))
        const { wrapper } = await render()
        expect(wrapper.find('.pbp-progress-line').text()).toBe('Asking... 2 of 6 answers')
        await button(wrapper, 'Stop').trigger('click')
        await flushPromises()
        expect(promptBox.cancel).toHaveBeenCalledWith('w1', 'r-3')

        noteRunAsked('w1')
        await flushPromises()
        expect(promptBox.list).toHaveBeenCalledTimes(2)
    })

    it('shows a question asked from the card as the latest, without pulling focus out of the card', async () => {
        const { wrapper, router } = await render()
        const outside = document.createElement('button')
        document.body.appendChild(outside)
        outside.focus()

        const asked = runPayload({ id: 'r-3', text: 'best crm for startups', created_at: new Date().toISOString() })
        promptBox.list.mockResolvedValue(ok([summaryOf(asked), summaryOf(FIRST), summaryOf(OLDER)]))
        answerGets([asked, FIRST, OLDER])
        noteRunAsked('w1')
        await flushPromises()
        expect(wrapper.find('h3.pbp-question').text()).toBe('best crm for startups')
        expect(document.activeElement).toBe(outside)

        // Read the answers for the run already shown: its question takes focus.
        await router.replace('/projects/w1/analytics?widget=prompt-box&run=r-3')
        await flushPromises()
        expect(document.activeElement).toBe(wrapper.find('h3.pbp-question').element)
    })

    it('tracks the question shown, as the card does', async () => {
        promptBox.track.mockResolvedValue(ok({ id: 'p-7', brand_prompt_id: 'bp-7' }))
        const { wrapper, board } = await render()
        await button(wrapper, 'Track this prompt').trigger('click')
        await flushPromises()
        expect(promptBox.track).toHaveBeenCalledWith('w1', 'best wiki for small teams')
        expect(wrapper.find('.pb-track-note').text()).toBe('Tracked. Autopilot asks it from its next run.')
        expect(board.invalidate).toHaveBeenCalledWith('ranking')
    })

    it('says why nothing shows: no question yet, a run that is gone, or runs that failed to load', async () => {
        promptBox.list.mockResolvedValueOnce(ok([]))
        let { wrapper } = await render()
        expect(wrapper.find('.pbp-intro').text()).toBe(
            'One answer can misjudge you. Asking several times shows how often each engine really names you.',
        )

        ;({ wrapper } = await render('/projects/w1/analytics?widget=prompt-box&run=r-404'))
        expect(wrapper.find('.pbp-state-title').text()).toBe('Run not found.')

        promptBox.list.mockRejectedValueOnce(httpError(500))
        ;({ wrapper } = await render())
        expect(wrapper.find('.pbp-state-title').text()).toBe("We couldn't load Ask AI.")
        await button(wrapper, 'Try again').trigger('click')
        await flushPromises()
        expect(wrapper.find('h3.pbp-question').text()).toBe('best wiki for small teams')
    })
})
