import { describe, expect, it } from 'vitest'
import { isAgentRequest, normalizeLine, splitPromptLines } from '../promptIntent'

describe('normalizeLine', () => {
    it('lowercases, collapses spaces and drops the trailing ?.!', () => {
        expect(normalizeLine('  How   is MY site doing?!  ')).toBe('how is my site doing')
        expect(normalizeLine('How’s my traffic...')).toBe("how's my traffic")
        expect(normalizeLine(null)).toBe('')
    })
})

describe('isAgentRequest', () => {
    it.each([
        'show me how the app is doing',
        'How is my traffic this month?',
        "what's our visibility on ChatGPT",
        'Why are my rankings dropping',
        'analyse our competitors',
        'summarize my report',
        'compare my site with notion.so',
        'check our ranking for crm',
        'is Cansee tracking this?',
        'open the dashboard',
        'prompts for this project',
        'How’s my account',
        'tell me how we compare',
        'how am i doing on gemini',
    ])('is a request for the agent: %s', (line) => {
        expect(isAgentRequest(line)).toBe(true)
    })

    it.each([
        'best note taking app for small teams',
        'can you recommend a CRM for a small team?',
        'I need a CRM that works with Gmail',
        'show me the best laptops',
        'how is notion different from evernote',
        // Whole words only.
        'is the apple watch worth it',
        'my siteground plan renewal price',
        'how is mysql different from postgres',
        'what is myfitnesspal',
        'checkmate strategies for beginners',
        '',
    ])('stays a buyer question: %s', (line) => {
        expect(isAgentRequest(line)).toBe(false)
    })
})

describe('splitPromptLines', () => {
    it('keeps the order typed', () => {
        expect(
            splitPromptLines(['best crm', 'how is my site doing', 'crm for startups', 'show me our traffic']),
        ).toEqual({ requests: ['how is my site doing', 'show me our traffic'], questions: ['best crm', 'crm for startups'] })
        expect(splitPromptLines(null)).toEqual({ requests: [], questions: [] })
    })
})
