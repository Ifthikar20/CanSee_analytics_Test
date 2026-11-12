import { describe, expect, it } from 'vitest'
import { BOARD_SIZE, rankRows, rankedBrands, rowSentence, yourPlace } from '../answerRank'

const brand = (name, visibility_pct, is_you = false) => ({ name, visibility_pct, is_you, by_engine: {} })
const BOARD = [brand('Evernote', 62), brand('Obsidian', 50), brand('Coda', 38), brand('Notion', 25, true), brand('Bear', 13), brand('Roam', 0)]

describe('rankedBrands', () => {
    it('is empty without a leaderboard', () => {
        for (const bad of [null, undefined, 'x', {}, []]) expect(rankedBrands(bad)).toEqual([])
    })

    it('numbers the brands by their share and sizes the bars against the largest', () => {
        const rows = rankedBrands(BOARD)
        expect(rows.map((r) => [r.index, r.name, r.text])).toEqual([
            ['01', 'Evernote', '62%'],
            ['02', 'Obsidian', '50%'],
            ['03', 'Coda', '38%'],
            ['04', 'Notion', '25%'],
            ['05', 'Bear', '13%'],
            ['', 'Roam', 'Not named'],
        ])
        expect(rows[0].width).toBe(100)
        expect(rows[1].width).toBeCloseTo((50 / 62) * 100)
        expect(rows.at(-1).width).toBe(0)
        expect(rows.filter((r) => r.you).map((r) => r.name)).toEqual(['Notion'])
        expect(new Set(rows.map((r) => r.key)).size).toBe(rows.length)
    })

    it('gives one brand the whole bar', () => {
        expect(rankedBrands([brand('Notion', 40, true)])).toMatchObject([{ index: '01', rank: 1, you: true, width: 100, text: '40%', atLeast: false }])
    })

    it('lets brands with the same share share a place', () => {
        const rows = rankedBrands([brand('A', 40), brand('B', 60), brand('C', 40), brand('D', 10)])
        expect(rows.map((r) => [r.name, r.rank])).toEqual([['B', 1], ['A', 2], ['C', 2], ['D', 4]])
    })

    it('sorts by share whatever order the API sends, keeping its order for ties', () => {
        expect(rankedBrands([brand('Low', 5), brand('High', 90), brand('Mid', 50)]).map((r) => r.name)).toEqual(['High', 'Mid', 'Low'])
    })

    it('gives no place to a brand that was not named or not measured', () => {
        const rows = rankedBrands([brand('A', 30), brand('Zero', 0), brand('Unknown', null), brand('Text', '40'), brand('NaN', NaN)])
        expect(rows.map((r) => [r.name, r.rank, r.text, r.width])).toEqual([
            ['A', 1, '30%', 100],
            ['Zero', null, 'Not named', 0],
            ['Unknown', null, 'Not measured', 0],
            ['Text', null, 'Not measured', 0],
            ['NaN', null, 'Not measured', 0],
        ])
    })

    it('draws no bars when every share is zero', () => {
        expect(rankedBrands([brand('A', 0), brand('B', 0, true)]).map((r) => [r.rank, r.width])).toEqual([[null, 0], [null, 0]])
    })

    it('drops rows without a name and keeps long names whole', () => {
        const long = 'A very long brand name that goes on and on and on'
        const rows = rankedBrands([null, brand('', 50), brand('   ', 50), { visibility_pct: 9 }, brand(long, 20), brand(42, 10)])
        expect(rows.map((r) => r.name)).toEqual([long, '42'])
    })

    it('prints small shares with a decimal, like every other card', () => {
        expect(rankedBrands([brand('A', 4.5)])[0].text).toBe('4.5%')
    })

    it('marks your place "at least" when you were added below a full board', () => {
        const full = Array.from({ length: BOARD_SIZE }, (_, i) => brand(`B${i + 1}`, 90 - i * 10))
        const you = rankedBrands([...full, brand('You Inc', 5, true)]).find((r) => r.you)
        expect(you).toMatchObject({ rank: 9, atLeast: true, index: '09+' })
        // On the board itself, the place is exact.
        const on = rankedBrands([...full.slice(0, 7), brand('You Inc', 15, true)]).find((r) => r.you)
        expect(on).toMatchObject({ rank: 8, atLeast: false, index: '08' })
        // Added below, but never named: still no place at all.
        const out = rankedBrands([...full, brand('You Inc', 0, true)]).find((r) => r.you)
        expect(out).toMatchObject({ rank: null, atLeast: false, index: '' })
        // A competitor in the last row of a long list is not "at least".
        expect(rankedBrands([...full, brand('Other', 5)]).at(-1).atLeast).toBe(false)
    })
})

describe('rankRows', () => {
    it('shows the first six brands', () => {
        expect(rankRows(BOARD).map((r) => r.name)).toEqual(['Evernote', 'Obsidian', 'Coda', 'Notion', 'Bear', 'Roam'])
        expect(rankRows(BOARD, { limit: 2 }).map((r) => r.name)).toEqual(['Evernote', 'Notion'])
    })

    it('gives the last row to you when you rank lower, with your real place', () => {
        const board = [brand('A', 90), brand('B', 80), brand('C', 70), brand('D', 60), brand('E', 50), brand('F', 40), brand('G', 30), brand('Me', 20, true)]
        const rows = rankRows(board)
        expect(rows.map((r) => r.name)).toEqual(['A', 'B', 'C', 'D', 'E', 'Me'])
        expect(rows.at(-1)).toMatchObject({ you: true, index: '08', rank: 8 })
        // The bars still measure against the leader, not against the rows shown.
        expect(rows.at(-1).width).toBeCloseTo((20 / 90) * 100)
    })

    it('never shows you twice, and copes with no you at all', () => {
        expect(rankRows(BOARD).filter((r) => r.you)).toHaveLength(1)
        const none = rankRows(BOARD.map((b) => ({ ...b, is_you: false })))
        expect(none.filter((r) => r.you)).toHaveLength(0)
        expect(none).toHaveLength(6)
    })

    it('is empty for an empty board and survives a bad limit', () => {
        expect(rankRows([])).toEqual([])
        expect(rankRows(BOARD, { limit: 0 })).toHaveLength(1)
        expect(rankRows(BOARD, { limit: NaN })).toHaveLength(6)
        expect(rankRows(BOARD, { limit: 99 })).toHaveLength(6)
    })
})

describe('the words of the ranking', () => {
    it('reads each row as a sentence', () => {
        const rows = rankedBrands([...BOARD, brand('Ghost', null)])
        expect(rowSentence(rows[0])).toBe('Number 1: Evernote, named in 62% of answers.')
        expect(rowSentence(rows[3])).toBe('Number 4: Notion (you), named in 25% of answers.')
        expect(rowSentence(rows[5])).toBe('Roam: not named in these answers.')
        expect(rowSentence(rows[6])).toBe('Ghost: not measured.')
        expect(rowSentence(null)).toBe('')
    })

    it('says where you stand, or what stands in the way', () => {
        expect(yourPlace(BOARD)).toBe('You are number 4 of the brands AI names.')
        expect(yourPlace([brand('A', 50), brand('Me', 0, true)])).toBe('These answers did not name you.')
        expect(yourPlace([brand('A', 50), brand('Me', null, true)])).toBe('Your share of these answers is not measured yet.')
        expect(yourPlace([brand('A', 50)])).toBe('')
        expect(yourPlace(null)).toBe('')
        const full = Array.from({ length: BOARD_SIZE }, (_, i) => brand(`B${i + 1}`, 90 - i * 10))
        expect(yourPlace([...full, brand('Me', 5, true)])).toBe('You are number 9 or lower of the brands AI names.')
        expect(rowSentence(rankedBrands([...full, brand('Me', 5, true)]).at(-1))).toBe('Number 9 or lower: Me (you), named in 5% of answers.')
    })
})
