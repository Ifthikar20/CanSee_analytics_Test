import { describe, expect, it } from 'vitest'
import atlas from 'world-atlas/countries-110m.json'
import { BY_NAME, ISO_NUMERIC_TO_A2, MAP_CODES, POINT_COUNTRIES, mapCode } from '@/lib/charts/geo/isoNumeric'
import { countryName } from '@/lib/charts/format'

const geometries = atlas.objects.countries.geometries

describe('ISO_NUMERIC_TO_A2', () => {
  it('maps every id in the atlas, and only those', () => {
    const ids = geometries.map((g) => g.id).filter(Boolean)
    expect(ids).toHaveLength(174)
    for (const id of ids) expect(ISO_NUMERIC_TO_A2[id], id).toMatch(/^[A-Z]{2}$/)
    expect(Object.keys(ISO_NUMERIC_TO_A2).sort()).toEqual([...ids].sort())
    const codes = Object.values(ISO_NUMERIC_TO_A2)
    expect(new Set(codes).size).toBe(codes.length)
  })

  it('agrees with ISO 3166-1 on the spot checks', () => {
    expect(ISO_NUMERIC_TO_A2['036']).toBe('AU')
    expect(ISO_NUMERIC_TO_A2['840']).toBe('US')
    expect(ISO_NUMERIC_TO_A2['826']).toBe('GB')
    expect(ISO_NUMERIC_TO_A2['158']).toBe('TW')
    expect(ISO_NUMERIC_TO_A2['275']).toBe('PS')
    expect(ISO_NUMERIC_TO_A2['732']).toBe('EH')
    expect(ISO_NUMERIC_TO_A2['728']).toBe('SS')
    expect(ISO_NUMERIC_TO_A2['010']).toBe('AQ')
  })

  it('names every code as a country the reader knows', () => {
    // The display name is the code itself only when CLDR does not know it.
    for (const code of Object.values(ISO_NUMERIC_TO_A2)) expect(countryName(code), code).not.toBe(code)
  })
})

describe('the features without an id', () => {
  it('matches the three by name; Kosovo is XK and the other two draw as no data', () => {
    const unnamed = geometries.filter((g) => !g.id).map((g) => g.properties.name)
    expect(unnamed.sort()).toEqual(['Kosovo', 'N. Cyprus', 'Somaliland'])
    expect(BY_NAME).toEqual({ Kosovo: 'XK', 'N. Cyprus': null, Somaliland: null })
  })
})

describe('MAP_CODES', () => {
  it('holds every drawn code: polygons, Kosovo and the dots, never Antarctica', () => {
    for (const code of ['SG', 'HK', 'BH', 'MT', 'XK', 'GB', 'US', 'AU']) expect(MAP_CODES.has(code), code).toBe(true)
    expect(MAP_CODES.has('AQ')).toBe(false)
    expect(MAP_CODES.has('MO')).toBe(false)
    expect(MAP_CODES.size).toBe(173 + 1 + 4)
    expect(Object.keys(POINT_COUNTRIES)).toEqual(['SG', 'HK', 'BH', 'MT'])
  })

  it('keys codes as the charts do', () => {
    expect(mapCode('uk')).toBe('GB')
    expect(mapCode(' de ')).toBe('DE')
    expect(mapCode(null)).toBe('')
  })
})
