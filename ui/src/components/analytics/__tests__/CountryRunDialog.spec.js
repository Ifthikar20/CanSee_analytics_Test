import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DOMWrapper, flushPromises, mount } from '@vue/test-utils'
import {
  apiError,
  countryEstimate,
  countryOptions,
  countryRun,
  ok,
} from '@/pages/analytics/__tests__/__fixtures__/analyticsPayloads'

vi.mock('@/api/countries', () => ({ default: { estimate: vi.fn(), startRun: vi.fn() } }))
const toast = { success: vi.fn(), error: vi.fn() }
vi.mock('@/composables/useToast', () => ({ useToast: () => toast }))

const { default: countriesApi } = await import('@/api/countries')
const { default: CountryRunDialog } = await import('../CountryRunDialog.vue')

const TRAFFIC = [{ code: 'US', value: 30 }, { code: 'GB', value: 8 }, { code: 'DE', value: 3 }]
const mounted = []

async function openDialog(props = {}) {
  const wrapper = mount(CountryRunDialog, {
    props: { open: false, websiteId: 'w1', options: countryOptions(), trafficCountries: TRAFFIC, ...props },
    attachTo: document.body,
  })
  mounted.push(wrapper)
  await wrapper.setProps({ open: true })
  await flushPromises()
  return wrapper
}

// The dialog is portalled to document.body.
const body = () => new DOMWrapper(document.body)
const runButton = () => body().findAll('.crd-foot button').at(-1)

async function settle() {
  await vi.advanceTimersByTimeAsync(300)
  await flushPromises()
}

async function pick(name) {
  const button = body().findAll('.crd-suggest-btn').find((b) => b.text() === name)
  await button.trigger('click')
  await flushPromises()
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  countriesApi.estimate.mockReset()
  countriesApi.startRun.mockReset()
  countriesApi.estimate.mockResolvedValue(ok(countryEstimate()))
  toast.success.mockReset()
})

afterEach(() => {
  while (mounted.length) mounted.pop().unmount()
  vi.useRealTimers()
  document.body.innerHTML = ''
})

describe('CountryRunDialog', () => {
  it('drops a queued estimate when it unmounts', async () => {
    const wrapper = await openDialog()
    await pick('United Kingdom')
    mounted.splice(mounted.indexOf(wrapper), 1)
    wrapper.unmount()
    await settle()
    expect(countriesApi.estimate).not.toHaveBeenCalled()
  })

  it('opens with the defaults and asks for a country before estimating', async () => {
    await openDialog()
    expect(body().text()).toContain('Check rankings in other countries')
    expect(body().text()).toContain(
      'Cansee searches Google and asks the AI engines your prompts as if from each country. Nothing runs until you confirm the cost.',
    )
    expect(body().text()).toContain('Up to 5 countries')
    expect(body().text()).toContain('Up to 10 prompts')
    expect(body().text()).toContain('Choose at least one country to see the cost.')
    // Both tracked prompts and both configured engines start checked.
    const prompts = body().findAll('.crd-checks')[0].findAll('input')
    expect(prompts.map((i) => i.element.checked)).toEqual([true, true])
    const engines = body().findAll('.crd-checks')[1].findAll('input')
    expect(engines.map((i) => [i.element.checked, i.element.disabled])).toEqual([
      [true, false],
      [true, false],
      [false, true],
      [false, true],
      [false, true],
    ])
    expect(body().findAll('.crd-checks')[1].text()).toContain('Not configured')
    expect(body().text()).toContain('Asked to answer for each country')
    expect(body().find('.crd-suggest-label').text()).toBe('From your visitors:')
    expect(body().findAll('.crd-suggest-btn').map((b) => b.text())).toEqual([
      'United States',
      'United Kingdom',
      'Germany',
    ])
    expect(runButton().attributes('disabled')).toBeDefined()
    await settle()
    expect(countriesApi.estimate).not.toHaveBeenCalled()
  })

  it('estimates 300 ms after the last change and shows the cost', async () => {
    await openDialog()
    await pick('United Kingdom')
    await vi.advanceTimersByTimeAsync(200)
    await pick('Germany')
    await vi.advanceTimersByTimeAsync(200)
    expect(countriesApi.estimate).not.toHaveBeenCalled()
    await settle()
    expect(countriesApi.estimate).toHaveBeenCalledTimes(1)
    expect(countriesApi.estimate).toHaveBeenCalledWith('w1', {
      countries: ['gb', 'de'],
      prompt_ids: ['p1', 'p2'],
      engines: ['chatgpt', 'claude'],
      include_google: true,
      google_pages: 1,
    })
    const estimate = body().find('.crd-estimate').text()
    expect(estimate).toContain('Google: up to 4 results pages, about 100 ScraperAPI credits.')
    expect(estimate).toContain('88 of 100 Google pages left today for this project.')
    expect(estimate).toContain('AI engines: 8 answers, up to $0.16 of your AI allowance ($4.08 left this month).')
    expect(estimate).toContain('These are upper bounds; checks stop early when your site is found and failed requests are not billed.')
    expect(runButton().text()).toBe('Run for up to $0.16 and 100 credits')
    expect(runButton().attributes('disabled')).toBeUndefined()
  })

  it('finds a country by name in the searchable list', async () => {
    await openDialog()
    const input = body().find('input[role="combobox"]')
    expect(input.attributes('aria-label')).toBe('Search countries')
    await input.setValue('germ')
    await flushPromises()
    const options = body().findAll('[role="option"]')
    expect(options.map((o) => o.text())).toEqual(['GermanyGoogle: Google set to DE, US connection'])
    await options[0].trigger('click')
    await flushPromises()
    expect(body().find('.crd-chosen').text()).toContain('Germany')
    await settle()
    expect(countriesApi.estimate).toHaveBeenCalledWith('w1', expect.objectContaining({ countries: ['de'] }))
  })

  it('dims the previous estimate and disables the run while a new one loads', async () => {
    await openDialog()
    await pick('United Kingdom')
    await settle()
    await body().find('input[name="crd-pages"][value="2"]').setValue(true)
    await flushPromises()
    expect(body().find('.crd-estimate').classes()).toContain('is-stale')
    expect(runButton().attributes('disabled')).toBeDefined()
    await settle()
    expect(countriesApi.estimate).toHaveBeenLastCalledWith('w1', expect.objectContaining({ google_pages: 2 }))
    expect(body().find('.crd-estimate').classes()).not.toContain('is-stale')
  })

  it('shows blockers and keeps the run disabled', async () => {
    countriesApi.estimate.mockResolvedValue(
      ok(
        countryEstimate({
          blockers: [{ code: 'daily_limit', message: 'This project has 2 Google pages left today; this check needs up to 4.' }],
          can_run: false,
        }),
      ),
    )
    await openDialog()
    await pick('United Kingdom')
    await settle()
    expect(body().find('.crd-blocker').text()).toBe('This project has 2 Google pages left today; this check needs up to 4.')
    expect(runButton().attributes('disabled')).toBeDefined()
  })

  it('asks for Google or an engine', async () => {
    await openDialog()
    await pick('United Kingdom')
    const checks = body().findAll('.crd-checks')[1].findAll('input')
    await checks[0].setValue(false)
    await checks[1].setValue(false)
    await body().findAll('.crd-field')[3].find('input[type="checkbox"]').setValue(false)
    await settle()
    expect(body().find('.crd-estimate').text()).toBe('Choose Google or at least one AI engine.')
    expect(countriesApi.estimate).not.toHaveBeenCalled()
  })

  it('starts the run with the confirmed estimate', async () => {
    const run = countryRun()
    countriesApi.startRun.mockResolvedValue(ok(run))
    const wrapper = await openDialog()
    await pick('United Kingdom')
    await settle()
    await runButton().trigger('click')
    await flushPromises()
    expect(countriesApi.startRun).toHaveBeenCalledWith('w1', {
      countries: ['gb'],
      prompt_ids: ['p1', 'p2'],
      engines: ['chatgpt', 'claude'],
      include_google: true,
      google_pages: 1,
      confirm: { google_pages: 4, engine_answers: 8, ai_usd_max: '0.1600' },
    })
    expect(wrapper.emitted('started')[0]).toEqual([run])
    expect(wrapper.emitted('update:open').at(-1)).toEqual([false])
    expect(toast.success).toHaveBeenCalledWith('Country check started.')
  })

  it('shows the new estimate when the cost changed, and confirms that one', async () => {
    const changed = countryEstimate({
      google: { ...countryEstimate().google, pages_max: 6, credits_max: 150 },
      confirm: { google_pages: 6, engine_answers: 8, ai_usd_max: '0.1600' },
    })
    countriesApi.startRun
      .mockRejectedValueOnce(
        apiError(409, 'estimate_changed', 'The estimate changed.', { estimate: changed }),
      )
      .mockResolvedValueOnce(ok(countryRun()))
    const wrapper = await openDialog()
    await pick('United Kingdom')
    await settle()
    await runButton().trigger('click')
    await flushPromises()
    expect(body().text()).toContain('The cost changed. Check the new estimate and confirm again.')
    expect(body().find('.crd-estimate').text()).toContain('Google: up to 6 results pages, about 150 ScraperAPI credits.')
    expect(runButton().text()).toBe('Run for up to $0.16 and 150 credits')
    expect(wrapper.emitted('started')).toBeUndefined()
    // No new estimate request: the server's own estimate is the one to confirm.
    expect(countriesApi.estimate).toHaveBeenCalledTimes(1)

    await runButton().trigger('click')
    await flushPromises()
    expect(countriesApi.startRun).toHaveBeenLastCalledWith(
      'w1',
      expect.objectContaining({ confirm: { google_pages: 6, engine_answers: 8, ai_usd_max: '0.1600' } }),
    )
    expect(wrapper.emitted('started')).toHaveLength(1)
  })

  it('shows any other start error inline', async () => {
    countriesApi.startRun.mockRejectedValue(apiError(409, 'run_in_progress', 'A country check is running for this project.'))
    const wrapper = await openDialog()
    await pick('United Kingdom')
    await settle()
    await runButton().trigger('click')
    await flushPromises()
    expect(body().find('[role="alert"]').text()).toBe('A country check is running for this project.')
    expect(wrapper.emitted('started')).toBeUndefined()
  })

  it('keeps to the limits and preselects the prompt from the page', async () => {
    const options = countryOptions({
      limits: { max_countries: 1, max_prompts: 1, max_pages: 1, max_google_pages: 50, max_engine_answers: 100 },
    })
    await openDialog({ options, presetPromptId: 'p2' })
    expect(body().text()).toContain('Up to 1 countries')
    const prompts = body().findAll('.crd-checks')[0].findAll('input')
    expect(prompts.map((i) => [i.element.checked, i.element.disabled])).toEqual([
      [false, true],
      [true, false],
    ])
    // One page only: no Top 20.
    expect(body().text()).toContain('Top 10')
    expect(body().text()).not.toContain('Top 20')
    await pick('United Kingdom')
    expect(body().find('.crd-suggest').exists()).toBe(false)
    expect(body().find('.crd-chosen').text()).toContain('United Kingdom')
    await body().find('.crd-chip-x').trigger('click')
    await flushPromises()
    expect(body().find('.crd-chosen').exists()).toBe(false)
  })

  it('says when Google is not available and uses SerpAPI dollars', async () => {
    const off = await openDialog({ options: countryOptions({ google: { configured: false } }) })
    const google = body().findAll('.crd-field')[3]
    expect(google.find('input').element.disabled).toBe(true)
    expect(google.text()).toContain("Google results aren't available yet.")
    off.unmount()
    mounted.splice(mounted.indexOf(off), 1)

    countriesApi.estimate.mockResolvedValue(
      ok(
        countryEstimate({
          google: { ...countryEstimate().google, provider: 'serpapi', provider_label: 'SerpAPI', credits_max: 0, usd_max: '0.0600' },
          allowance: { unlimited: true, cap_usd: null, left_usd: null, enough: true },
        }),
      ),
    )
    await openDialog()
    await pick('United Kingdom')
    await settle()
    const text = body().find('.crd-estimate').text()
    expect(text).toContain('Google: up to 4 results pages, up to $0.06.')
    expect(text).toContain('AI engines: 8 answers, up to $0.16.')
    expect(runButton().text()).toBe('Run for up to $0.22')
  })
})
