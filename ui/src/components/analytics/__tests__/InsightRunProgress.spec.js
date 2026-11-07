import { afterEach, describe, expect, it } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import InsightRunProgress from '../InsightRunProgress.vue'
import { run } from '@/composables/analytics/__tests__/__fixtures__/insightRuns'

const mounted = []

function setup(props) {
  const wrapper = mount(InsightRunProgress, { props, attachTo: document.body })
  mounted.push(wrapper)
  return wrapper
}

const buttonByText = (root, text) => [...root.querySelectorAll('button')].find((b) => b.textContent.trim() === text)

afterEach(() => {
  while (mounted.length) mounted.pop().unmount()
  document.body.innerHTML = ''
})

describe('InsightRunProgress', () => {
  it('shows a running run with its progress', () => {
    const wrapper = setup({ run: run() })
    expect(wrapper.find('h2').text()).toBe('Answer analysis running')
    const bar = wrapper.find('[role="progressbar"]')
    expect(bar.attributes('aria-valuenow')).toBe('8')
    expect(bar.attributes('aria-valuemax')).toBe('40')
    expect(bar.attributes('aria-valuetext')).toBe('8 of 40')
    expect(wrapper.text()).toContain('8 of 40')
    // No summary or cost before it ends.
    expect(wrapper.text()).not.toContain('done ·')
  })

  it('asks before stopping, and Keep running leaves it alone', async () => {
    const wrapper = setup({ run: run() })
    await wrapper.find('button').trigger('click')
    await flushPromises()
    const confirm = document.body.querySelector('[role="alertdialog"]')
    expect(confirm.textContent).toContain('Stop this run?')
    expect(confirm.textContent).toContain('Work that already finished is kept. The rest is not run and not billed.')
    buttonByText(confirm, 'Keep running').click()
    await flushPromises()
    expect(wrapper.emitted('stop')).toBeUndefined()

    await wrapper.find('button').trigger('click')
    await flushPromises()
    buttonByText(document.body.querySelector('[role="alertdialog"]'), 'Stop').click()
    await flushPromises()
    expect(wrapper.emitted('stop')).toHaveLength(1)
  })

  it('says Stopping... once a stop was asked', () => {
    const wrapper = setup({ run: run({ cancel_requested: true }) })
    expect(wrapper.text()).toContain('Stopping...')
    expect(buttonByText(wrapper.element, 'Stop')).toBeUndefined()
  })

  it('reads a finished run: duration, summary and what it used', async () => {
    const wrapper = setup({
      run: run({
        status: 'done',
        duration_ms: 125000,
        progress: { total: 40, queued: 0, running: 0, done: 38, failed: 2, skipped: 0, cancelled: 0 },
        cost: { ai_usd: '0.0812', google_pages: 0, scraperapi_credits: null },
      }),
    })
    expect(wrapper.find('h2').text()).toBe('Answer analysis finished in 2 min 5 s')
    expect(wrapper.text()).toContain('38 done · 2 failed')
    expect(wrapper.text()).not.toContain('skipped')
    expect(wrapper.text()).toContain('Used $0.08 of AI allowance.')
    await buttonByText(wrapper.element, 'Dismiss').click()
    expect(wrapper.emitted('dismiss')).toHaveLength(1)
  })

  it('counts Google pages and their credits, or says nothing was billed', () => {
    let wrapper = setup({
      run: run({
        kind: 'prompt_research',
        kind_label: 'Prompt research',
        status: 'partial',
        duration_ms: 9000,
        progress: { total: 3, queued: 0, running: 0, done: 2, failed: 1, skipped: 0, cancelled: 0 },
        cost: { ai_usd: '0.0019', google_pages: 2, scraperapi_credits: 50 },
      }),
    })
    expect(wrapper.find('h2').text()).toBe('Prompt research finished in 9 s')
    expect(wrapper.text()).toContain('Used $0.0019 of AI allowance and 2 Google pages (about 50 ScraperAPI credits).')

    wrapper = setup({
      run: run({
        kind: 'site_audit',
        kind_label: 'Crawler audit',
        status: 'done',
        duration_ms: 30000,
        progress: { total: 12, queued: 0, running: 0, done: 12, failed: 0, skipped: 0, cancelled: 0 },
        cost: { ai_usd: '0.0000', google_pages: 0, scraperapi_credits: null },
      }),
    })
    expect(wrapper.text()).toContain('Nothing was billed.')
  })

  it('reads stopped, interrupted and failed runs', () => {
    let wrapper = setup({
      run: run({ status: 'cancelled', progress: { total: 40, queued: 0, running: 0, done: 10, failed: 1, skipped: 1, cancelled: 28 } }),
    })
    expect(wrapper.find('h2').text()).toBe('Stopped after 12 of 40')
    expect(wrapper.text()).toContain('10 done · 1 failed · 1 skipped · 28 stopped')

    wrapper = setup({
      run: run({ status: 'interrupted', progress: { total: 40, queued: 0, running: 0, done: 9, failed: 31, skipped: 0, cancelled: 0 } }),
    })
    expect(wrapper.find('h2').text()).toBe('Interrupted after 9 of 40')

    wrapper = setup({
      run: run({
        status: 'failed',
        progress: { total: 2, queued: 0, running: 0, done: 0, failed: 2, skipped: 0, cancelled: 0 },
        error: { code: 'allowance_exceeded', message: 'The monthly AI allowance is used up.' },
      }),
    })
    expect(wrapper.find('h2').text()).toBe('The run could not finish')
    expect(wrapper.text()).toContain('The monthly AI allowance is used up.')
  })

  it('shows why a stop failed', () => {
    const wrapper = setup({ run: run(), stopError: "We couldn't stop this run. Try again." })
    expect(wrapper.find('[role="alert"]').text()).toBe("We couldn't stop this run. Try again.")
  })
})
