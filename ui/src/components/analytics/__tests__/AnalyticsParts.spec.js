import { afterEach, describe, expect, it } from 'vitest'
import { DOMWrapper, flushPromises, mount } from '@vue/test-utils'
import { defineComponent, h } from 'vue'
import { createMemoryHistory, createRouter } from 'vue-router'
import MethodChip from '../MethodChip.vue'
import PeriodSelect from '../PeriodSelect.vue'
import PromptSelect from '../PromptSelect.vue'
import SourceSelect from '../SourceSelect.vue'
import SourceCapabilities from '../SourceCapabilities.vue'
import RecentRuns from '../RecentRuns.vue'
import CrawlerPathsTable from '../CrawlerPathsTable.vue'
import { countryRun, finishedRun, trafficSources } from '@/pages/analytics/__tests__/__fixtures__/analyticsPayloads'

const Blank = defineComponent({ render: () => h('div') })
const mounted = []

async function routerAt(path) {
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/traffic', name: 'traffic', component: Blank },
      { path: '/settings/connections', name: 'settings-connections', component: Blank },
    ],
  })
  await router.push(path)
  await router.isReady()
  return router
}

function track(wrapper) {
  mounted.push(wrapper)
  return wrapper
}

afterEach(() => {
  while (mounted.length) mounted.pop().unmount()
  document.body.innerHTML = ''
})

describe('MethodChip', () => {
  it('shows the label and its note on focus', async () => {
    const wrapper = track(
      mount(MethodChip, { props: { method: 'google_setting', label: 'Google set to GB, US connection' }, attachTo: document.body }),
    )
    const chip = wrapper.find('button.mchip')
    expect(chip.text()).toBe('Google set to GB, US connection')
    await chip.trigger('focus')
    await flushPromises()
    expect(new DOMWrapper(document.body).text()).toContain(
      "Cansee searched Google with its country setting on this country, through a connection elsewhere. Results follow Google's country setting; results tied to a city can differ.",
    )
  })

  it('is a plain chip for a method without a note, and nothing without a label', () => {
    const plain = track(mount(MethodChip, { props: { method: 'default', label: 'Google default (US)' } }))
    expect(plain.find('span.mchip').text()).toBe('Google default (US)')
    expect(plain.find('button').exists()).toBe(false)
    const none = track(mount(MethodChip, { props: { method: 'asked', label: '' } }))
    expect(none.html()).toBe('<!--v-if-->')
  })
})

describe('selects', () => {
  it('offers the periods and emits the choice', async () => {
    const wrapper = track(mount(PeriodSelect, { props: { modelValue: '30d' } }))
    expect(wrapper.find('label').text()).toContain('Period')
    expect(wrapper.findAll('option').map((o) => o.text())).toEqual(['Last 7 days', 'Last 30 days', 'Last 90 days'])
    await wrapper.find('select').setValue('90d')
    expect(wrapper.emitted('update:modelValue')[0]).toEqual(['90d'])
    const two = track(mount(PeriodSelect, { props: { modelValue: '30d', periods: ['30d', '90d'] } }))
    expect(two.findAll('option')).toHaveLength(2)
  })

  it('clips long prompts', () => {
    const text = 'x'.repeat(80)
    const wrapper = track(mount(PromptSelect, { props: { prompts: [{ prompt_id: 'p1', text }] } }))
    const option = wrapper.findAll('option')[1].text()
    expect(option).toHaveLength(60)
    expect(option.endsWith('…')).toBe(true)
  })

  it('names what Auto resolves to and lists unconnected sources disabled', () => {
    const { sources } = trafficSources()
    const wrapper = track(mount(SourceSelect, { props: { modelValue: 'auto', sources, autoSource: 'pixel' } }))
    expect(wrapper.findAll('option').map((o) => [o.text(), o.element.disabled])).toEqual([
      ['Auto (Cansee pixel)', false],
      ['Cansee pixel', false],
      ['Google Analytics 4 (not connected)', true],
      ['Cloudflare', false],
    ])
    const none = track(mount(SourceSelect, { props: { modelValue: 'auto', sources: [], autoSource: '' } }))
    expect(none.findAll('option')[0].text()).toBe('Auto')
  })
})

describe('SourceCapabilities', () => {
  it('reads every status in words', async () => {
    const router = await routerAt('/traffic')
    const sources = [
      { key: 'pixel', label: 'Cansee pixel', status: 'not_installed', connected: true, measures: { visitors: 'visitors', countries: true, ai_referrals: true, ai_crawlers: false } },
      { key: 'ga4', label: 'Google Analytics 4', status: 'pending_selection', measures: { visitors: 'users', countries: true, ai_referrals: true, ai_crawlers: false } },
      { key: 'ga_hosted', label: 'Cansee Google tag', status: 'disabled', measures: { visitors: 'live_only' } },
      { key: 'cloudflare', label: 'Cloudflare', status: 'pending_selection', measures: { visitors: 'requests', countries: true, ai_referrals: false, ai_crawlers: 'unknown' } },
    ]
    const wrapper = track(mount(SourceCapabilities, { props: { sources }, global: { plugins: [router] } }))
    const rows = wrapper.findAll('tbody tr').map((r) => r.findAll('th, td').map((c) => c.text()))
    expect(rows.map((r) => r[1])).toEqual(['Installed, no visits yet', 'Choose a property', 'Turned off', 'Choose a zone'])
    // Not connected yet: whether crawlers can be counted depends on the plan.
    expect(rows[3][5]).toBe('If the plan allows')
    expect(rows[3][5]).not.toBe('Checking...')
    expect(wrapper.find('a').text()).toBe('Manage connections')

    // A pixel that was never verified is not installed, not "no visits yet".
    await wrapper.setProps({ sources: [{ ...sources[0], connected: false }] })
    expect(wrapper.find('tbody tr td').text()).toBe('Not installed')
  })

  it('leaves out the link to Connections on Connections itself', async () => {
    const router = await routerAt('/settings/connections')
    const wrapper = track(mount(SourceCapabilities, { props: { sources: trafficSources().sources }, global: { plugins: [router] } }))
    expect(wrapper.findAll('tbody tr')).toHaveLength(4)
    expect(wrapper.find('a').exists()).toBe(false)
  })
})

describe('RecentRuns', () => {
  it('lists each check with its countries, status, progress and cost', () => {
    const runs = [
      finishedRun({ id: 'r2', status: 'partial', progress: { total: 12, done: 10, failed: 2, skipped: 0, cancelled: 0 } }),
      countryRun({ id: 'r1', status: 'cancelled', progress: { total: 12, done: 3, failed: 0, skipped: 0, cancelled: 9 } }),
    ]
    const wrapper = track(mount(RecentRuns, { props: { runs } }))
    const items = wrapper.findAll('.rr-item')
    expect(items).toHaveLength(2)
    expect(items[0].find('.rr-status').text()).toBe('Partly done')
    expect(items[0].findAll('.rr-chip').map((c) => c.text())).toEqual(['United Kingdom', 'Germany'])
    expect(items[0].find('.rr-line').text()).toContain('10 of 12 checks')
    expect(items[0].find('.rr-cost').text()).toBe(
      'Used 4 Google pages (about 100 ScraperAPI credits) and $0.09 of AI allowance.',
    )
    expect(items[1].find('.rr-status').text()).toBe('Stopped')
    expect(items[1].find('.rr-by').text()).toBe('By Site Owner')
  })

  it('says when there is nothing yet', () => {
    const wrapper = track(mount(RecentRuns, { props: { runs: [] } }))
    expect(wrapper.text()).toBe('No checks yet.')
  })
})

describe('CrawlerPathsTable', () => {
  it('names the crawlers of each path', () => {
    const wrapper = track(
      mount(CrawlerPathsTable, {
        props: {
          paths: [{ path: '/blog', requests: 1204, bots: ['gptbot', 'unknownbot'] }],
          bots: [{ key: 'gptbot', name: 'GPTBot' }],
        },
      }),
    )
    expect(wrapper.find('h3').text()).toBe('Most crawled pages')
    expect(wrapper.findAll('tbody th, tbody td').map((c) => c.text())).toEqual(['/blog', '1,204', 'GPTBot, unknownbot'])
    const empty = track(mount(CrawlerPathsTable, { props: { paths: [] } }))
    expect(empty.find('.cpt-empty').exists()).toBe(true)
  })
})
