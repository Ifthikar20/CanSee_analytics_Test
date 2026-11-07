import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AGENT_FONT_FAMILY, _resetAgentFont, ensureAgentFont } from '../font'

const realFonts = Object.getOwnPropertyDescriptor(document, 'fonts')

beforeEach(() => {
  _resetAgentFont()
})

afterEach(() => {
  vi.unstubAllGlobals()
  if (realFonts) Object.defineProperty(document, 'fonts', realFonts)
  else delete document.fonts
})

describe('ensureAgentFont', () => {
  it('registers Inter Agent once with the variable weight range and swap', async () => {
    const added = []
    const created = []
    class FakeFontFace {
      constructor(family, source, descriptors) {
        Object.assign(this, { family, source, descriptors })
        created.push(this)
      }
      load() {
        return Promise.resolve(this)
      }
    }
    vi.stubGlobal('FontFace', FakeFontFace)
    Object.defineProperty(document, 'fonts', { value: { add: (f) => added.push(f) }, configurable: true })

    await expect(ensureAgentFont()).resolves.toBe(true)
    await ensureAgentFont()
    expect(created).toHaveLength(1)
    expect(added).toHaveLength(1)
    expect(created[0].family).toBe(AGENT_FONT_FAMILY)
    expect(created[0].source).toMatch(/^url\(.+InterVariable-subset\.woff2.*\) format\('woff2'\)$/)
    expect(created[0].descriptors).toMatchObject({ weight: '100 900', display: 'swap' })
  })

  it('resolves false when the face fails to load', async () => {
    vi.stubGlobal(
      'FontFace',
      class {
        load() {
          return Promise.reject(new Error('network'))
        }
      },
    )
    Object.defineProperty(document, 'fonts', { value: { add() {} }, configurable: true })
    await expect(ensureAgentFont()).resolves.toBe(false)
  })

  it('resolves false without the FontFace API', async () => {
    vi.stubGlobal('FontFace', undefined)
    await expect(ensureAgentFont()).resolves.toBe(false)
  })
})
