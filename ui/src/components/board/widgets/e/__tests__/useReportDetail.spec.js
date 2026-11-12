// The newest report's detail: one request per report version, shared by
// every user, silent on failure and never an answer for another report.
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises } from '@vue/test-utils'
import { effectScope, nextTick, ref } from 'vue'

const api = vi.hoisted(() => ({ getArtifact: vi.fn() }))
vi.mock('@/api/agent', () => ({ default: api }))

const { resetReportDetails, useReportDetail } = await import('../useReportDetail')

function use(websiteId, report) {
    const scope = effectScope()
    const detail = scope.run(() => useReportDetail(websiteId, report))
    return { detail, stop: () => scope.stop() }
}

const answer = (id) => ({ data: { id, data: { header: {} } } })

beforeEach(() => {
    resetReportDetails()
    api.getArtifact.mockReset()
    api.getArtifact.mockImplementation((wid, id) => Promise.resolve(answer(id)))
})

describe('useReportDetail', () => {
    it('loads the detail of the report, quietly', async () => {
        const { detail } = use('w1', { id: 'r1', version: 2 })
        expect(detail.value).toBeNull()
        await flushPromises()
        expect(detail.value).toEqual(answer('r1').data)
        expect(api.getArtifact).toHaveBeenCalledWith('w1', 'r1', { _silentError: true })
    })

    it('asks nothing without a project or a report', async () => {
        const a = use('', { id: 'r1', version: 1 })
        const b = use('w1', null)
        const c = use('w1', {})
        await flushPromises()
        expect(api.getArtifact).not.toHaveBeenCalled()
        expect([a.detail.value, b.detail.value, c.detail.value]).toEqual([null, null, null])
    })

    it('shares one request between users and keeps the answer for the next one', async () => {
        const first = use('w1', { id: 'r1', version: 2 })
        const second = use('w1', { id: 'r1', version: 2 })
        await flushPromises()
        expect(api.getArtifact).toHaveBeenCalledTimes(1)
        expect(second.detail.value).toBe(first.detail.value)
        const later = use('w1', { id: 'r1', version: 2 })
        // Kept: there at once, with no request.
        expect(later.detail.value).toBe(first.detail.value)
        expect(api.getArtifact).toHaveBeenCalledTimes(1)
    })

    it('asks again for a new version, another report and another project', async () => {
        const wid = ref('w1')
        const report = ref({ id: 'r1', version: 1 })
        const { detail } = use(wid, report)
        await flushPromises()
        report.value = { id: 'r1', version: 2 }
        await nextTick()
        // The older version's detail is not shown for the new one.
        expect(detail.value).toBeNull()
        await flushPromises()
        report.value = { id: 'r2', version: 1 }
        await flushPromises()
        expect(detail.value.id).toBe('r2')
        wid.value = 'w2'
        await flushPromises()
        expect(api.getArtifact.mock.calls.map((c) => [c[0], c[1]])).toEqual([['w1', 'r1'], ['w1', 'r1'], ['w1', 'r2'], ['w2', 'r2']])
        report.value = null
        await nextTick()
        expect(detail.value).toBeNull()
    })

    it('drops an answer that arrives after the report changed', async () => {
        let release
        api.getArtifact.mockImplementationOnce(() => new Promise((resolve) => { release = () => resolve(answer('r1')) }))
        const report = ref({ id: 'r1', version: 1 })
        const { detail } = use('w1', report)
        report.value = { id: 'r2', version: 1 }
        await flushPromises()
        expect(detail.value.id).toBe('r2')
        release()
        await flushPromises()
        expect(detail.value.id).toBe('r2')
    })

    it('stays empty when the request fails or answers nothing, and tries again next time', async () => {
        api.getArtifact.mockRejectedValueOnce(new Error('down'))
        const failed = use('w1', { id: 'r1', version: 1 })
        await flushPromises()
        expect(failed.detail.value).toBeNull()
        api.getArtifact.mockResolvedValueOnce({ data: null })
        const empty = use('w1', { id: 'r1', version: 1 })
        await flushPromises()
        expect(empty.detail.value).toBeNull()
        const again = use('w1', { id: 'r1', version: 1 })
        await flushPromises()
        expect(again.detail.value.id).toBe('r1')
        expect(api.getArtifact).toHaveBeenCalledTimes(3)
    })

    it('forgets everything on reset', async () => {
        use('w1', { id: 'r1', version: 1 })
        await flushPromises()
        resetReportDetails()
        use('w1', { id: 'r1', version: 1 })
        await flushPromises()
        expect(api.getArtifact).toHaveBeenCalledTimes(2)
    })
})
