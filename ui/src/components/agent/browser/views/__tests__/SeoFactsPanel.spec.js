import { afterEach, describe, expect, it } from 'vitest'
import { enableAutoUnmount, mount } from '@vue/test-utils'
import SeoFactsPanel from '../SeoFactsPanel.vue'

enableAutoUnmount(afterEach)

const SEO = {
  title: 'A title that runs on and on well past what Google shows in a result, sixty plus characters',
  title_length: 92,
  meta_description: 'Short.',
  meta_description_length: 6,
  canonical: 'https://elsewhere.test/page',
  robots: 'noindex, follow',
  h1: [],
  h2: [],
}

describe('SeoFactsPanel', () => {
  it('explains each flag in a HelpTip that keyboard and touch reach, not in title=', () => {
    const w = mount(SeoFactsPanel, { props: { seo: SEO, pageUrl: 'https://acme.test/page' }, attachTo: document.body })
    expect(w.findAll('.ag-fact-flag[title]')).toHaveLength(0)
    const tips = w.findAll('button.cs-helptip').map((b) => [
      b.text(),
      document.getElementById(b.attributes('aria-describedby')).textContent,
    ])
    expect(tips).toEqual([
      ['Long', 'Google usually shows about 50 to 60 characters of a title.'],
      ['Short', 'Short descriptions are often replaced by Google.'],
      ['Points elsewhere', "The canonical URL is not this page's address."],
      ['noindex', 'This page asks search engines not to index it.'],
    ])
  })
})
