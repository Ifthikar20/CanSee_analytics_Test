import { describe, expect, it } from 'vitest'
import { defaultRepresentation, normalizeVizSpec, representationsFor, tableModel } from '@/lib/charts/spec'
import {
    engineStateWord,
    onSite,
    productEngines,
    productTiles,
    shoppingText,
    shoppingWord,
    siteHost,
} from '../productSpecs'
import { productDetail, productsPayload } from '@/pages/analytics/__tests__/__fixtures__/measurementPayloads'

const offered = (spec, picked = null) => representationsFor(normalizeVizSpec(spec), { picked })

describe('productTiles', () => {
    it('counts products, Google Shopping finds, engine answers and your own listings', () => {
        expect(productTiles(productsPayload()).map((t) => [t.label, t.value])).toEqual([
            ['Products', 2],
            ['Found in Google Shopping', '1 of 1'],
            ['Named by engines', '1 of 2'],
            ['Sold by you', '1 of 1'],
        ])
    })

    it('reads Not checked before any check', () => {
        const payload = productsPayload()
        payload.products.forEach((p) => (p.latest = null))
        const tiles = productTiles(payload)
        expect(tiles[0].value).toBe(2)
        for (const t of tiles.slice(1)) expect(t).toMatchObject({ value: null, stateText: 'Not checked' })
    })

    it('reads Not found for Sold by you when nothing matched', () => {
        const payload = productsPayload()
        payload.products[0].latest.google = { state: 'not_found', queries_checked: 1, queries_found: 0, best_position: null }
        const tiles = productTiles(payload)
        expect(tiles[1].value).toBe('0 of 1')
        expect(tiles[3]).toMatchObject({ value: null, stateText: 'Not found' })
    })

    it('measures a product with no products tracked as 0', () => {
        expect(productTiles(productsPayload({ products: [] }))[0].value).toBe(0)
    })
})

describe('productEngines', () => {
    it('shows the share of answers naming each product per engine; unchecked cells are Not checked', () => {
        const spec = productEngines(productsPayload())
        // Calm default: bars first, the heatmap still offered.
        expect(spec).toMatchObject({ id: 'products.engines', title: 'Named by engine', value: 'percent', type: 'bar' })
        expect(spec.label_names).toEqual({ pr1: 'Acme X200 running shoe', pr2: 'Acme trail sock' })
        expect(spec.datasets.map((d) => [d.key, d.entity, d.data, d.states])).toEqual([
            ['chatgpt', 'engine:chatgpt', [100, null], [null, 'not_checked']],
            ['claude', 'engine:claude', [0, null], [null, 'not_checked']],
        ])
        expect(offered(spec)).toEqual(['bar', 'heatmap', 'table'])
        expect(defaultRepresentation(normalizeVizSpec(spec))).toBe('bar')
        expect(tableModel(spec).rows[1].cells.map((c) => c.text)).toEqual(['Not checked', 'Not checked'])
    })
})

describe('shopping words', () => {
    it('reads a Google Shopping result in the table and the sheet', () => {
        expect(shoppingText(productDetail().queries[0].google)).toEqual({ text: '#3', sub: 'of 40 results', measured: true })
        expect(shoppingText({ state: 'found', best_position: 3 })).toEqual({ text: '#3', sub: '', measured: true })
        expect(shoppingText({ state: 'not_found', results: 40 }).text).toBe('Not in the 40 results')
        expect(shoppingText({ state: 'failed' }).text).toBe('Failed')
        expect(shoppingText({ state: 'not_configured' }).text).toBe('Not configured')
        expect(shoppingText(null).text).toBe('Not checked')
    })

    it('words Google for the ask template', () => {
        expect(shoppingWord({ state: 'found', position: 3, results: 40 })).toBe('#3 of 40 results')
        expect(shoppingWord({ state: 'found', best_position: 3 })).toBe('#3')
        expect(shoppingWord({ state: 'not_found', results: 40 })).toBe('not in the 40 results')
        expect(shoppingWord({ state: 'not_checked' })).toBeNull()
    })

    it('names engine states and tells pages of the site apart', () => {
        expect(['named', 'not_named', 'failed', 'not_checked'].map(engineStateWord)).toEqual([
            'Named',
            'Not named',
            'Failed',
            'Not checked',
        ])
        expect(siteHost('https://www.acme.com/')).toBe('acme.com')
        expect(onSite('https://acme.com/x200', 'acme.com')).toBe(true)
        expect(onSite('https://shop.acme.com/x200', 'acme.com')).toBe(true)
        expect(onSite('https://amazon.com/acme', 'acme.com')).toBe(false)
        expect(onSite('', 'acme.com')).toBe(false)
    })
})
