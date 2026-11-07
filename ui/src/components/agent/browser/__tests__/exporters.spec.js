import { describe, expect, it, vi } from 'vitest'

const downloadText = vi.hoisted(() => vi.fn())
vi.mock('@/lib/agent/download', async (importOriginal) => ({ ...(await importOriginal()), downloadText }))

const { exportActions, runExport } = await import('../exporters')

describe('exporters: llms.txt', () => {
  it('adds Download llms.txt before the document actions of an llms.txt draft', () => {
    expect(exportActions('document', 'llms_txt').map((a) => a.label)).toEqual([
      'Download llms.txt',
      'Markdown (.md)',
      'HTML (.html)',
      'Print or save as PDF',
    ])
    expect(exportActions('document').map((a) => a.key)).toEqual(['md', 'doc-html', 'print'])
    expect(exportActions('sheet', 'llms_txt').map((a) => a.key)).toEqual(['csv', 'tsv', 'copy-table'])
  })

  it('saves the file as llms.txt in plain text, whatever the draft is called', async () => {
    await runExport('llms-txt', { kind: 'document', title: 'llms.txt for Notion', content: '# Notion\n' })
    expect(downloadText).toHaveBeenCalledWith('# Notion\n', 'llms.txt', 'text/plain;charset=utf-8')
  })
})
