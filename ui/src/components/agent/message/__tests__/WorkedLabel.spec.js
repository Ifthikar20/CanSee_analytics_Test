import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { enableAutoUnmount, mount } from '@vue/test-utils'
import WorkedLabel from '@/components/agent/message/WorkedLabel.vue'

enableAutoUnmount(afterEach)

const NOW = Date.parse('2026-11-08T10:00:00Z')

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(NOW)
})

afterEach(() => {
  vi.useRealTimers()
})

function mountLabel(props) {
  return mount(WorkedLabel, { props: { running: true, startedAt: NOW, ...props } })
}

describe('WorkedLabel while a run waits for a free slot', () => {
  it('says so with the place in line when the server reports it', () => {
    const w = mountLabel({ phase: 'queued', queue: { position: 3, ahead: 2, slots: 6 } })
    expect(w.find('.ag-worked-text').text()).toBe('Waiting for a free slot')
    expect(w.find('.ag-worked-note').text()).toBe('2 replies ahead')
  })

  it('names the next reply in line and a single reply ahead', async () => {
    const w = mountLabel({ phase: 'queued', queue: { position: 1, ahead: 0, slots: 6 } })
    expect(w.find('.ag-worked-note').text()).toBe('Next in line')
    await w.setProps({ queue: { position: 2, ahead: 1, slots: 6 } })
    expect(w.find('.ag-worked-note').text()).toBe('1 reply ahead')
  })

  it('infers the wait when the server reports no line and the run stays queued', async () => {
    const w = mountLabel({ phase: 'queued', queue: null })
    expect(w.find('.ag-worked-text').text()).toBe('Starting')
    await vi.advanceTimersByTimeAsync(4000)
    expect(w.find('.ag-worked-text').text()).toBe('Starting')
    await vi.advanceTimersByTimeAsync(1500)
    expect(w.find('.ag-worked-text').text()).toBe('Waiting for a free slot')
    expect(w.find('.ag-worked-note').exists()).toBe(false)
  })

  it('goes back to Working once the run starts', async () => {
    const w = mountLabel({ phase: 'queued', queue: { position: 1, ahead: 0, slots: 6 } })
    await w.setProps({ phase: 'running', queue: null })
    expect(w.find('.ag-worked-text').text()).toBe('Working')
    expect(w.find('.ag-worked-note').exists()).toBe(false)
  })

  it('keeps the transport note ahead of the place in line', () => {
    const w = mountLabel({ phase: 'queued', queue: { position: 2, ahead: 1, slots: 6 }, transport: 'offline' })
    expect(w.find('.ag-worked-text').text()).toBe('Waiting for a free slot')
    expect(w.find('.ag-worked-note').text()).toBe('Connection lost, retrying')
  })

  it('shows Stopping for a queued run being cancelled', () => {
    const w = mountLabel({ phase: 'cancelling', queue: { position: 2, ahead: 1, slots: 6 } })
    expect(w.find('.ag-worked-text').text()).toBe('Stopping')
  })
})
