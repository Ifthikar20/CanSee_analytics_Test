import { describe, expect, it } from 'vitest'
import { countIssue, describePath, matchSyntax, measure, sheetWarnings } from '../views/sheetModel'
import { charCount, formatBytes, formatMs, regionName } from '../format'
import { documentHtml, exportActions, exportErrorText } from '../exporters'
import { pageErrorInfo } from '../pageMode'
import { safeFilename } from '@/lib/agent/download'
import { UNSETTLED_HTML } from '@/lib/agent/srcdoc'

describe('sheet model', () => {
  it('describes warning paths in plain words', () => {
    expect(describePath('ad_groups[0].ads[1].headlines[3]')).toBe('Ad group 1 › Ad 2 › Headline 4')
    expect(describePath('ad_groups.1.keywords.0')).toBe('Ad group 2 › Keyword 1')
    expect(describePath('sitelinks[2].description1')).toBe('Sitelink 3 › Description 1')
    expect(describePath('campaign.final_url')).toBe('Campaign › Final URL')
    expect(describePath('something.odd')).toBe('something.odd')
  })

  it('counts characters as people do and flags limits', () => {
    expect(measure('x'.repeat(30), 30).over).toBe(false)
    expect(measure('x'.repeat(31), 30)).toEqual({ length: 31, limit: 30, over: true })
    expect(charCount('café')).toBe(4)
  })

  it('writes keywords in Google syntax', () => {
    expect(matchSyntax('ebike battery', 'exact')).toBe('[ebike battery]')
    expect(matchSyntax('ebike battery', 'phrase')).toBe('"ebike battery"')
    expect(matchSyntax('ebike battery', 'broad')).toBe('ebike battery')
  })

  it('merges sheet and artifact warnings without duplicates', () => {
    const list = sheetWarnings({ warnings: [{ path: 'campaign.name', message: 'Missing' }] }, [
      { path: 'campaign.name', message: 'Missing' },
      'Plain text warning',
    ])
    expect(list).toHaveLength(2)
    expect(list[0].where).toBe('Campaign › Name')
  })

  it('checks headline and description counts', () => {
    expect(countIssue(2, [3, 15], 'headline')).toBe('2 headlines; Google needs at least 3.')
    expect(countIssue(16, [3, 15], 'headline')).toBe('16 headlines; Google allows at most 15.')
    expect(countIssue(5, [3, 15], 'headline')).toBe('')
  })
})

describe('formatters', () => {
  it('formats sizes, durations and regions', () => {
    expect(formatBytes(512)).toBe('512 B')
    expect(formatBytes(84 * 1024)).toBe('84 KB')
    expect(formatMs(640)).toBe('640 ms')
    expect(formatMs(1500)).toBe('1.5 s')
    expect(regionName('gb')).toBe('United Kingdom')
    expect(regionName('Berlin, Germany')).toBe('Berlin, Germany')
    expect(regionName('')).toBe('')
  })

  it('makes safe file names', () => {
    expect(safeFilename('Battery: landing / page?', 'html')).toBe('Battery landing page.html')
    expect(safeFilename('..', 'md')).toBe('export.md')
  })
})

describe('exports', () => {
  it('offers the formats each kind supports', () => {
    expect(exportActions('page').map((a) => a.key)).toEqual(['page-html', 'copy-html'])
    expect(exportActions('report').map((a) => a.key)).toEqual(['md', 'doc-html', 'print'])
    expect(exportActions('sheet').map((a) => a.key)).toEqual(['csv', 'tsv', 'copy-table'])
    expect(exportActions('newtab')).toEqual([])
  })

  it('builds a standalone document without copy buttons and with the appendix for reports', () => {
    const html = documentHtml({
      title: 'Report <x>',
      markdown: '# Title\n\n```js\nconst a = 1\n```',
      data: { serp: [{ query: 'q', page: 1, results: [], brand_positions: [] }], engines: [], pages: [] },
      report: true,
    })
    expect(html.startsWith('<!DOCTYPE html>')).toBe(true)
    expect(html).toContain('<title>Report &lt;x&gt;</title>')
    expect(html).not.toContain('<button')
    expect(html).toContain('Research data')
    expect(html).not.toMatch(/data-v-/)
  })

  it('says why a page export was refused', () => {
    expect(exportErrorText(new Error(UNSETTLED_HTML))).toBe("This page's HTML couldn't be cleaned safely, so it wasn't exported.")
    expect(exportErrorText(new Error('copy_failed'))).toBe("That export didn't work. Try again.")
  })

  it('words page fetch errors by code', () => {
    expect(pageErrorInfo({ code: 'timeout', message: 'Read timed out' })).toEqual({
      code: 'timeout',
      title: 'The page took too long to respond.',
      body: 'Read timed out',
    })
    expect(pageErrorInfo({ code: 'weird', message: 'Odd failure' }).title).toBe('Odd failure')
    expect(pageErrorInfo(null)).toBe(null)
    // The browse service's limits on markup and on pages read at once.
    expect(pageErrorInfo({ code: 'too_complex', message: 'The page has more than 80,000 HTML tags, too many to read here.' })).toEqual({
      code: 'too_complex',
      title: 'The page has too much markup to read here.',
      body: 'The page has more than 80,000 HTML tags, too many to read here.',
    })
    const busy = 'Too many pages are being read right now. Try again in a moment.'
    expect(pageErrorInfo({ code: 'busy', message: busy })).toEqual({ code: 'busy', title: busy, body: '' })
  })
})
