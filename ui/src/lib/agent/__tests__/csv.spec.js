import { describe, expect, it } from 'vitest'
import { AD_CAMPAIGN_COLUMNS, adCampaignRows, csvField, guardCell, serpRows, toCsv, toTsv } from '../csv'

describe('csvField', () => {
  it('quotes fields with commas, quotes and line breaks (RFC 4180)', () => {
    expect(csvField('plain')).toBe('plain')
    expect(csvField('a,b')).toBe('"a,b"')
    expect(csvField('say "hi"')).toBe('"say ""hi"""')
    expect(csvField('line1\nline2')).toBe('"line1\nline2"')
    expect(csvField('cr\rhere')).toBe('"cr\rhere"')
  })

  it('writes empty cells for null and undefined and keeps numbers', () => {
    expect(csvField(null)).toBe('')
    expect(csvField(undefined)).toBe('')
    expect(csvField(-12.5)).toBe('-12.5')
    expect(csvField(Number.NaN)).toBe('')
  })
})

describe('formula injection guard', () => {
  it('prefixes text that a spreadsheet would evaluate', () => {
    for (const bad of ['=SUM(A1)', '+1', '-1', '@cmd', '\tx', '\rx', '＝1+1']) {
      expect(guardCell(bad).startsWith("'")).toBe(true)
    }
    expect(guardCell('safe = text')).toBe('safe = text')
    expect(guardCell(-5)).toBe('-5')
  })

  it('guards before quoting', () => {
    expect(csvField('=HYPERLINK("http://x","y")')).toBe('"\'=HYPERLINK(""http://x"",""y"")"')
  })

  it('can be switched off', () => {
    expect(csvField('=1', { guard: false })).toBe('=1')
  })
})

describe('toCsv and toTsv', () => {
  it('joins rows with CRLF and starts with a BOM', () => {
    const out = toCsv([
      ['a', 'b'],
      ['1', 'x,y'],
    ])
    expect(out).toBe('﻿a,b\r\n1,"x,y"\r\n')
    expect(toCsv([['a']], { bom: false })).toBe('a\r\n')
  })

  it('flattens tabs and line breaks in TSV cells', () => {
    expect(toTsv([['a\tb', 'c\nd'], ['=1', 2]])).toBe("a b\tc d\n'=1\t2\n")
  })
})

describe('adCampaignRows', () => {
  const campaign = {
    campaign: {
      name: 'Battery care',
      objective: 'leads',
      platform: 'google_search',
      daily_budget: 40,
      bid_strategy: 'Maximize clicks',
      final_url: 'https://shop.test/battery',
    },
    ad_groups: [
      {
        name: 'Range',
        keywords: [
          { text: 'ebike battery range', match: 'phrase' },
          { text: 'battery care', match: 'exact' },
        ],
        negatives: ['free'],
        ads: [{ headlines: ['H1', 'H2', 'H3'], descriptions: ['D1', 'D2'], path1: 'battery', path2: 'care' }],
      },
    ],
    sitelinks: [{ text: 'Guide', url: 'https://shop.test/guide', description1: 'Read it' }],
    warnings: [],
  }

  it('lays out a header, the campaign, groups, keywords, negatives, ads and sitelinks', () => {
    const rows = adCampaignRows(campaign)
    const col = (name) => AD_CAMPAIGN_COLUMNS.indexOf(name)
    expect(rows[0]).toEqual(AD_CAMPAIGN_COLUMNS)
    expect(rows).toHaveLength(1 + 1 + 1 + 2 + 1 + 1 + 1)
    expect(rows[1][col('Campaign Type')]).toBe('Search')
    expect(rows[1][col('Budget')]).toBe(40)
    expect(rows[3][col('Keyword')]).toBe('ebike battery range')
    expect(rows[3][col('Criterion Type')]).toBe('Phrase')
    expect(rows[5][col('Criterion Type')]).toBe('Negative Broad')
    expect(rows[6][col('Headline 3')]).toBe('H3')
    expect(rows[6][col('Description 2')]).toBe('D2')
    expect(rows[6][col('Path 1')]).toBe('battery')
    expect(rows[7][col('Link Text')]).toBe('Guide')
    expect(rows[7][col('Final URL')]).toBe('https://shop.test/guide')
  })

  it('copies over-limit text unchanged', () => {
    const long = 'x'.repeat(45)
    const rows = adCampaignRows({ campaign: { name: 'c' }, ad_groups: [{ name: 'g', ads: [{ headlines: [long] }] }] })
    expect(rows[3][AD_CAMPAIGN_COLUMNS.indexOf('Headline 1')]).toBe(long)
  })

  it('tolerates partial snapshots', () => {
    expect(adCampaignRows({})).toHaveLength(2)
    expect(adCampaignRows(null)).toHaveLength(2)
  })
})

describe('serpRows', () => {
  it('exports positions with your and competitor flags', () => {
    const rows = serpRows({
      results: [
        { position: 1, title: 'A', url: 'https://a.test', domain: 'a.test', snippet: 's', is_yours: true },
        { position: 2, title: 'B', url: 'https://b.test', domain: 'b.test', is_competitor: true, competitor_name: 'Bee' },
      ],
    })
    expect(rows[1]).toEqual([1, 'A', 'https://a.test', 'a.test', 's', 'Yes', 'No'])
    expect(rows[2][6]).toBe('Bee')
  })
})
