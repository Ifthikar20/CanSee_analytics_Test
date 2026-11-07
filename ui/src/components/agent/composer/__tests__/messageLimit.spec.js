import { describe, expect, it } from 'vitest'
import { COUNT_FROM, MAX_MESSAGE_CHARS, lengthCopy, messageLength } from '@/components/agent/composer/messageLimit'

describe('messageLength', () => {
  it('matches the server limit of services/runs.py', () => {
    expect(MAX_MESSAGE_CHARS).toBe(20000)
  })

  it('counts the trimmed text without NULs, as the server does', () => {
    expect(messageLength('  hello\0  ').count).toBe(5)
    expect(messageLength(`${'a'.repeat(MAX_MESSAGE_CHARS)}   `).over).toBe(false)
    expect(messageLength('a'.repeat(MAX_MESSAGE_CHARS + 1)).over).toBe(true)
  })

  it('counts an emoji as one character, not two UTF-16 units', () => {
    const emoji = String.fromCodePoint(0x1f600)
    const text = emoji.repeat(MAX_MESSAGE_CHARS)
    expect(text.length).toBe(MAX_MESSAGE_CHARS * 2)
    expect(messageLength(text)).toEqual({ count: MAX_MESSAGE_CHARS, near: true, over: false })
  })

  it('is near the limit from the counter threshold', () => {
    expect(messageLength('a'.repeat(COUNT_FROM - 1)).near).toBe(false)
    expect(messageLength('a'.repeat(COUNT_FROM)).near).toBe(true)
  })

  it('says how long the message is and what the limit is', () => {
    const over = lengthCopy({ count: 25000, over: true })
    expect(over.short).toBe(`Too long · ${(25000).toLocaleString()} / ${(20000).toLocaleString()}`)
    expect(over.long).toContain('too long to send')
    expect(lengthCopy({ count: 18500, over: false }).short).toBe(`${(18500).toLocaleString()} / ${(20000).toLocaleString()}`)
  })
})
