import { beforeEach, describe, expect, it, vi } from 'vitest'
import { promptGap, reportHeader } from './__fixtures__/reportHeader.js'

const downloadText = vi.hoisted(() => vi.fn())
const printHtml = vi.hoisted(() => vi.fn())
vi.mock('@/lib/agent/download', async (importOriginal) => ({ ...(await importOriginal()), downloadText, printHtml }))

const { documentHtml, documentMarkdown, runExport } = await import('../exporters')

const MARKDOWN = '# Notion vs competitors\n\nSummary.'
const withTemplate = () => ({ gaps: [promptGap()], template: 'competitor_comparison', header: reportHeader() })
const oldReport = () => ({ serp: [], pages: [], engines: [], swarm: null })

beforeEach(() => {
  downloadText.mockReset()
  printHtml.mockReset()
})

describe('report exports', () => {
  it('puts the header first in the HTML export, then the text, then the research data with the gaps', () => {
    const html = documentHtml({ title: 'Report', markdown: MARKDOWN, data: withTemplate(), report: true })
    const doc = new DOMParser().parseFromString(html, 'text/html')
    const main = doc.querySelector('main')
    expect(main.firstElementChild.tagName).toBe('HEADER')
    expect(main.firstElementChild.textContent).toContain('Competitor comparison')
    expect(main.firstElementChild.textContent).toContain('Evernote')
    expect(main.firstElementChild.textContent).not.toContain('Sample')
    expect(html.indexOf('Competitor comparison')).toBeLessThan(html.indexOf('Notion vs competitors'))
    expect(html).toContain('Prompt gaps')
    expect(html).toContain('Google ahead -35')
    // Vue's scoped-style attributes and comments are gone.
    expect(html).not.toMatch(/data-v-|<!--/)
    // The export CSS styles the header without the app's stylesheet.
    expect(html).toContain('.ag-rh{')
  })

  it('leaves an old report without a header', () => {
    const html = documentHtml({ title: 'Report', markdown: MARKDOWN, data: oldReport(), report: true })
    expect(new DOMParser().parseFromString(html, 'text/html').querySelector('main header')).toBeNull()
    expect(html).toContain('Research data')
  })

  it.each([
    ['a list', []],
    ['a string', 'header'],
    ['null', null],
  ])('leaves a report whose header is %s unlabelled in both exports', (_, header) => {
    const data = { ...oldReport(), template: 'competitor_comparison', header }
    const html = documentHtml({ title: 'Report', markdown: MARKDOWN, data, report: true })
    expect(new DOMParser().parseFromString(html, 'text/html').querySelector('main header')).toBeNull()
    expect(html).not.toContain('Competitor comparison')
    expect(documentMarkdown({ markdown: MARKDOWN, data, report: true })).toBe(MARKDOWN)
  })

  it('never adds a header to a document export', () => {
    const html = documentHtml({ title: 'Doc', markdown: MARKDOWN, data: withTemplate(), report: false })
    expect(new DOMParser().parseFromString(html, 'text/html').querySelector('main header')).toBeNull()
    expect(html).not.toContain('Research data')
  })

  it('prepends the header to the Markdown export of a report only', () => {
    const md = documentMarkdown({ markdown: MARKDOWN, data: withTemplate(), report: true })
    expect(md.startsWith('**Template: Competitor comparison**\n\n- Project: Notion (https://www.notion.so/)')).toBe(true)
    expect(md.endsWith(`---\n\n${MARKDOWN}`)).toBe(true)
    expect(documentMarkdown({ markdown: MARKDOWN, data: oldReport(), report: true })).toBe(MARKDOWN)
    expect(documentMarkdown({ markdown: MARKDOWN, data: withTemplate(), report: false })).toBe(MARKDOWN)
    expect(documentMarkdown({ markdown: '', data: null, report: true })).toBe('')
  })

  it('downloads the .md with the header, and prints with it', async () => {
    await runExport('md', { kind: 'report', title: 'Report', content: MARKDOWN, data: withTemplate() })
    const [text, name, type] = downloadText.mock.calls[0]
    expect(text.startsWith('**Template: Competitor comparison**')).toBe(true)
    expect(text).toContain(MARKDOWN)
    expect(name).toMatch(/\.md$/)
    expect(type).toBe('text/markdown;charset=utf-8')

    await runExport('md', { kind: 'document', title: 'Doc', content: MARKDOWN, data: withTemplate() })
    expect(downloadText.mock.calls[1][0]).toBe(MARKDOWN)

    await runExport('print', { kind: 'report', title: 'Report', content: MARKDOWN, data: withTemplate() })
    expect(printHtml.mock.calls[0][0]).toContain('Competitor comparison')

    await runExport('doc-html', { kind: 'report', title: 'Report', content: MARKDOWN, data: oldReport() })
    expect(downloadText.mock.calls[2][0]).not.toContain('Report details')
  })
})
