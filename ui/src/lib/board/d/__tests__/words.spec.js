import { describe, expect, it } from 'vitest'
import { listWords, num, pad2, plural, text } from '../words'

describe('group D words', () => {
    it('keeps finite numbers and turns everything else into null', () => {
        expect(num(0)).toBe(0)
        expect(num(-3.5)).toBe(-3.5)
        for (const bad of [NaN, Infinity, -Infinity, '12', null, undefined, {}, [], true]) expect(num(bad), String(bad)).toBeNull()
    })

    it('trims text and drops what is not text', () => {
        expect(text('  Notion ')).toBe('Notion')
        for (const bad of [null, undefined, 12, {}, ['a']]) expect(text(bad)).toBe('')
    })

    it('counts with the right noun and thousands separators', () => {
        expect(plural(0, 'prompt', 'prompts')).toBe('0 prompts')
        expect(plural(1, 'prompt', 'prompts')).toBe('1 prompt')
        expect(plural(1204, 'prompt', 'prompts')).toBe('1,204 prompts')
    })

    it('joins names the way a sentence does', () => {
        expect(listWords([])).toBe('')
        expect(listWords(null)).toBe('')
        expect(listWords(['ChatGPT'])).toBe('ChatGPT')
        expect(listWords(['ChatGPT', 'Claude'])).toBe('ChatGPT and Claude')
        expect(listWords(['ChatGPT', 'Claude', 'Gemini'])).toBe('ChatGPT, Claude and Gemini')
        expect(listWords(['ChatGPT', '', null, ' Claude '])).toBe('ChatGPT and Claude')
    })

    it('prints a place in at least two digits', () => {
        expect(pad2(1)).toBe('01')
        expect(pad2(12)).toBe('12')
        expect(pad2(120)).toBe('120')
    })
})
