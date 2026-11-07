import { describe, expect, it } from 'vitest'
import {
  canFrameLive,
  displayUrl,
  firstLetter,
  googleSearchUrl,
  hostOf,
  isHttpUrl,
  isOwnSite,
  normalizeAddress,
  resolveHref,
} from '../url'

describe('normalizeAddress', () => {
  it('adds https to bare hosts and keeps paths', () => {
    expect(normalizeAddress('example.com')).toBe('https://example.com/')
    expect(normalizeAddress('  example.com/pricing?a=1 ')).toBe('https://example.com/pricing?a=1')
    expect(normalizeAddress('example.com:8080/x')).toBe('https://example.com:8080/x')
    expect(normalizeAddress('//example.com/a')).toBe('https://example.com/a')
  })

  it('keeps explicit http and https', () => {
    expect(normalizeAddress('http://example.com/a')).toBe('http://example.com/a')
    expect(normalizeAddress('HTTPS://Example.com')).toBe('https://example.com/')
  })

  it('refuses other schemes, spaces and single words', () => {
    expect(normalizeAddress('javascript:alert(1)')).toBeNull()
    expect(normalizeAddress('data:text/html,<b>x</b>')).toBeNull()
    expect(normalizeAddress('mailto:someone@example.com')).toBeNull()
    expect(normalizeAddress('ftp://example.com')).toBeNull()
    expect(normalizeAddress('best note app')).toBeNull()
    expect(normalizeAddress('notes')).toBeNull()
    expect(normalizeAddress('')).toBeNull()
    expect(normalizeAddress(null)).toBeNull()
  })
})

describe('isHttpUrl and resolveHref', () => {
  it('accepts only absolute http(s)', () => {
    expect(isHttpUrl('https://example.com')).toBe(true)
    expect(isHttpUrl('java\tscript:alert(1)')).toBe(false)
    expect(isHttpUrl('/relative')).toBe(false)
    expect(isHttpUrl('')).toBe(false)
  })

  it('resolves relative links against the page and drops unsafe ones', () => {
    expect(resolveHref('/about', 'https://example.com/a/b')).toBe('https://example.com/about')
    expect(resolveHref('c', 'https://example.com/a/b')).toBe('https://example.com/a/c')
    expect(resolveHref('javascript:alert(1)', 'https://example.com/')).toBeNull()
    expect(resolveHref(' JaVa\nScRiPt:alert(1)', 'https://example.com/')).toBeNull()
    expect(resolveHref('mailto:a@example.com', 'https://example.com/')).toBeNull()
    expect(resolveHref('', 'https://example.com/')).toBeNull()
  })
})

describe('labels', () => {
  it('derives hosts and display URLs', () => {
    expect(hostOf('https://www.example.com/x')).toBe('example.com')
    expect(hostOf('not a url')).toBe('')
    expect(displayUrl('https://www.example.com/')).toBe('example.com')
    expect(displayUrl('https://example.com/a%20b?q=1')).toBe('example.com/a b?q=1')
  })

  it('picks the first letter or digit for avatars', () => {
    expect(firstLetter('www.notion.so')).toBe('N')
    expect(firstLetter('9to5mac.com')).toBe('9')
    expect(firstLetter('  ')).toBe('?')
  })

  it('builds Google search links with page offsets', () => {
    expect(googleSearchUrl('best note app', 2, 'US')).toBe(
      'https://www.google.com/search?q=best+note+app&start=10&gl=us'
    )
    expect(googleSearchUrl('q', 1)).toBe('https://www.google.com/search?q=q')
    expect(googleSearchUrl('')).toBeNull()
  })
})

describe('canFrameLive', () => {
  const app = 'https://cansee.ai'

  it('needs frameable, https and a foreign site', () => {
    expect(canFrameLive({ url: 'https://example.com', frameable: true }, app)).toBe(true)
    expect(canFrameLive({ url: 'https://example.com', frameable: false }, app)).toBe(false)
    expect(canFrameLive({ url: 'http://example.com', frameable: true }, app)).toBe(false)
    expect(canFrameLive({ url: 'https://cansee.ai/x', frameable: true }, app)).toBe(false)
    expect(canFrameLive({ url: 'https://www.cansee.ai/x', frameable: true }, app)).toBe(false)
    expect(canFrameLive({ url: 'https://docs.cansee.ai/x', frameable: true }, app)).toBe(false)
    expect(canFrameLive(null, app)).toBe(false)
  })

  it('uses the final URL after redirects', () => {
    const capture = { url: 'https://example.com', final_url: 'http://example.com/', frameable: true }
    expect(canFrameLive(capture, app)).toBe(false)
  })

  it('compares sites by host', () => {
    expect(isOwnSite('https://notcansee.ai', app)).toBe(false)
    expect(isOwnSite('https://cansee.ai.evil.com', app)).toBe(false)
  })
})
