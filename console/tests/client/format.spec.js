import { describe, expect, it } from 'vitest';

import {
  MISSING, formatCount, formatDateTime, formatSeats, formatUsd, periodLabel,
} from '../../client/src/lib/format.js';

describe('format', () => {
  it('formats counts with thousands separators and shows missing values as a dash', () => {
    expect(formatCount(0)).toBe('0');
    expect(formatCount(1234567)).toBe('1,234,567');
    expect(formatCount(null)).toBe(MISSING);
    expect(formatCount(undefined)).toBe(MISSING);
    expect(formatCount(Number.NaN)).toBe(MISSING);
    expect(formatCount('12')).toBe(MISSING);
  });

  it('formats dollars to the cent', () => {
    expect(formatUsd(1234.5)).toBe('$1,234.50');
    expect(formatUsd(null)).toBe(MISSING);
  });

  it('shows dates in UTC', () => {
    expect(formatDateTime('2026-11-07T23:30:00-05:00')).toBe('Nov 8, 2026, 04:30 UTC');
    expect(formatDateTime(null, 'Never')).toBe('Never');
    expect(formatDateTime('not a date')).toBe(MISSING);
  });

  it('shows seats as used / limit, with unlimited and missing limits', () => {
    expect(formatSeats(3, 5)).toBe('3 / 5');
    expect(formatSeats(1, 1)).toBe('1 / 1');
    expect(formatSeats(12, -1)).toBe('12 / Unlimited');
    expect(formatSeats(2, null)).toBe(`2 / ${MISSING}`);
  });

  it('names the usage period, preferring the backend period', () => {
    expect(periodLabel(null, new Date('2026-11-08T12:00:00Z'))).toBe('This month (UTC): November 2026');
    // Late on the last day in New York is already the next month in UTC.
    expect(periodLabel(null, new Date('2026-11-30T23:30:00-05:00'))).toBe('This month (UTC): December 2026');
    expect(periodLabel({ start: '2026-10-01T00:00:00Z', end: '2026-11-01T00:00:00Z' }, new Date('2026-11-08T00:00:00Z')))
      .toBe('This month (UTC): October 2026');
    // The backend's own period block.
    expect(periodLabel({ month_start: '2026-10-01T00:00:00+00:00', as_of: '2026-10-31T23:59:00+00:00' }, new Date('2026-12-08T00:00:00Z')))
      .toBe('This month (UTC): October 2026');
  });
});
