// Edges of the payload normalizers: which source wins when several are
// sent, and that a value the backend did not send is never invented.

import { describe, expect, it } from 'vitest';

import {
  PLAN_LABELS, normalizeAccount, normalizeMember, normalizePage, normalizeUser, overviewPeriod, overviewTiles,
  planLabel, toCount,
} from '../../client/src/lib/normalize.js';

const nested = (month, allTime) => ({ tokens: { month: { total: month }, all_time: { total: allTime } } });

describe('toCount', () => {
  it.each([
    [0, 0],
    [1, 1],
    ['0', 0],
    ['1200', 1200],
    ['0.012345', 0.012345],
    [-1, -1],
    [9007199254740991, 9007199254740991],
  ])('reads %j as %j', (raw, value) => {
    expect(toCount(raw)).toBe(value);
  });

  it.each([
    [null], [undefined], [''], [true], [false], ['n/a'], [Number.NaN], [Number.POSITIVE_INFINITY], [{}], [[1, 2]],
  ])('reads %j as missing', (raw) => {
    expect(toCount(raw)).toBeNull();
  });
});

describe('token sources', () => {
  it('prefers the nested month total over every legacy month name', () => {
    const row = { ...nested(4000, 90000), tokens_month: 1, tokens_this_month: 2, usage: { tokens_month: 3 } };
    expect(normalizeUser(row).tokensMonth).toBe(4000);
    expect(normalizeMember(row).tokensMonth).toBe(4000);
    expect(normalizeAccount(row).tokensMonth).toBe(4000);
  });

  it('falls back through the legacy month names in order', () => {
    expect(normalizeUser({ tokens_month: 1, tokens_this_month: 2, usage: { tokens_month: 3 } }).tokensMonth).toBe(1);
    expect(normalizeUser({ tokens_this_month: 2, usage: { tokens_month: 3 } }).tokensMonth).toBe(2);
    expect(normalizeUser({ usage: { tokens_month: 3 } }).tokensMonth).toBe(3);
  });

  it('falls back through the legacy all-time names in order', () => {
    expect(normalizeUser({ tokens_all_time: 1, tokens_total: 2, usage: { tokens_all_time: 3 } }).tokensAllTime).toBe(1);
    expect(normalizeUser({ tokens_total: 2, usage: { tokens_all_time: 3 } }).tokensAllTime).toBe(2);
    expect(normalizeUser({ usage: { tokens_all_time: 3 } }).tokensAllTime).toBe(3);
  });

  it('keeps a month of zero as zero, not as missing, and does not fall back past it', () => {
    const user = normalizeUser({ ...nested(0, 0), tokens_month: 55, tokens_total: 66 });
    expect(user.tokensMonth).toBe(0);
    expect(user.tokensAllTime).toBe(0);
  });

  it('never mixes month and all-time figures', () => {
    expect(normalizeUser({ tokens: { all_time: { total: 9 } } })).toMatchObject({ tokensMonth: null, tokensAllTime: 9 });
    expect(normalizeUser({ tokens: { month: { total: 9 } } })).toMatchObject({ tokensMonth: 9, tokensAllTime: null });
  });

  it('reads a boolean or empty token value as missing', () => {
    expect(normalizeUser({ tokens_month: true, tokens_total: '' })).toMatchObject({ tokensMonth: null, tokensAllTime: null });
  });
});

describe('normalizeUser', () => {
  it('returns every field as missing for an empty row', () => {
    expect(normalizeUser()).toEqual({
      id: null, email: null, name: null, plan: null, planLabel: null, organization: null,
      joined: null, lastLogin: null, tokensMonth: null, tokensAllTime: null,
    });
  });

  it('keeps id 0 as "0"', () => {
    expect(normalizeUser({ id: 0 }).id).toBe('0');
  });

  it('reads the organization from a flat name and id', () => {
    expect(normalizeUser({ organization: 'Acme', organization_id: 4 }).organization).toEqual({ id: '4', name: 'Acme' });
    expect(normalizeUser({ organization_name: 'Beta' }).organization).toEqual({ id: null, name: 'Beta' });
    expect(normalizeUser({ organization: { id: 1, name: '  ' } }).organization).toBeNull();
    expect(normalizeUser({ organization: { name: 'NoId' } }).organization).toEqual({ id: null, name: 'NoId' });
  });

  it('treats a blank name or email as missing', () => {
    expect(normalizeUser({ email: '   ', full_name: '' })).toMatchObject({ email: null, name: null });
    expect(normalizeUser({ name: 'Fallback' }).name).toBe('Fallback');
  });

  it('reads joined from the first date the backend sends', () => {
    expect(normalizeUser({ joined: 'a', date_joined: 'b', created_at: 'c' }).joined).toBe('a');
    expect(normalizeUser({ date_joined: 'b', created_at: 'c' }).joined).toBe('b');
    expect(normalizeUser({ created_at: 'c' }).joined).toBe('c');
  });
});

describe('normalizeMember', () => {
  it('is active unless the backend says active: false', () => {
    expect(normalizeMember({}).active).toBe(true);
    expect(normalizeMember({ active: null }).active).toBe(true);
    expect(normalizeMember({ active: true }).active).toBe(true);
    expect(normalizeMember({ active: false }).active).toBe(false);
  });

  it('is pending only on pending: true or status "pending"', () => {
    expect(normalizeMember({}).pending).toBe(false);
    expect(normalizeMember({ pending: 'yes' }).pending).toBe(false);
    expect(normalizeMember({ status: 'active' }).pending).toBe(false);
    expect(normalizeMember({ pending: true }).pending).toBe(true);
    expect(normalizeMember({ status: 'pending' }).pending).toBe(true);
  });

  it('reads the user id and email from a nested user object', () => {
    expect(normalizeMember({ user: { id: 5, email: 'n@x.co', full_name: 'N' } }))
      .toMatchObject({ userId: '5', email: 'n@x.co', name: 'N' });
    expect(normalizeMember({ user_id: 'a', user: { id: 'b' }, id: 'c' }).userId).toBe('a');
    expect(normalizeMember({ id: 'c' }).userId).toBe('c');
  });
});

describe('normalizeAccount', () => {
  it('reads over_limit only when it is exactly true', () => {
    expect(normalizeAccount({ over_limit: true }).overLimit).toBe(true);
    for (const value of [false, 1, 'true', 'yes', null, undefined]) {
      expect(normalizeAccount({ over_limit: value }).overLimit, String(value)).toBe(false);
    }
  });

  it('reads the kind from kind, then type', () => {
    for (const kind of ['individual', 'personal', 'user']) {
      expect(normalizeAccount({ kind }).kind).toBe('individual');
      expect(normalizeAccount({ type: kind }).kind).toBe('individual');
    }
    expect(normalizeAccount({ kind: 'organization', type: 'individual' }).kind).toBe('organization');
    expect(normalizeAccount({}).kind).toBe('organization');
  });

  it('prefers flat seat counts over a nested seats block', () => {
    const account = normalizeAccount({ seat_limit: 5, seats_used: 2, seats: { used: 9, limit: 9, max: 9 } });
    expect(account).toMatchObject({ seatLimit: 5, seatsUsed: 2, members: [] });
    expect(normalizeAccount({ seats: { used: 3, limit: 4, max: 9 } })).toMatchObject({ seatLimit: 4, seatsUsed: 3 });
  });

  it('keeps zero seats used and zero pending invites as zero', () => {
    expect(normalizeAccount({ seat_limit: 1, seats_used: 0, pending_invites: 0, seats_available: 1 }))
      .toMatchObject({ seatLimit: 1, seatsUsed: 0, pendingInvites: 0, seatsAvailable: 1 });
  });

  it('reads seats from the seats list first, then members, seats_detail and seat_members', () => {
    expect(normalizeAccount({ seats: [{ user_id: 's' }], members: [{ user_id: 'm' }] }).members.map((m) => m.userId)).toEqual(['s']);
    expect(normalizeAccount({ members: [{ user_id: 'm' }], seats_detail: [{ user_id: 'd' }] }).members.map((m) => m.userId)).toEqual(['m']);
    expect(normalizeAccount({ seats_detail: [{ user_id: 'd' }] }).members.map((m) => m.userId)).toEqual(['d']);
    expect(normalizeAccount({ seat_members: [{ user_id: 'x' }] }).members.map((m) => m.userId)).toEqual(['x']);
    expect(normalizeAccount({ members: 'not a list' }).members).toEqual([]);
  });

  it.each([
    ['free', 1, 'Free'],
    ['prompts_100', 1, '100 prompts'],
    ['prompts_200', 5, '200 prompts'],
    ['business', -1, 'Business'],
  ])('keeps the backend seat limit for the %s plan as sent (%s)', (plan, limit, label) => {
    const account = normalizeAccount({ plan, seat_limit: limit, seats_used: 1 });
    expect(account).toMatchObject({ plan, planLabel: label, seatLimit: limit, seatsUsed: 1 });
  });
});

describe('normalizePage', () => {
  it('uses the row count when the backend sends no total', () => {
    expect(normalizePage({ rows: [{ id: 1 }, { id: 2 }, { id: 3 }] }, normalizeUser).total).toBe(3);
    expect(normalizePage({ results: [{ id: 1 }] }, normalizeUser).total).toBe(1);
  });

  it('keeps a total of zero even with rows present', () => {
    expect(normalizePage({ total: 0, rows: [{ id: 1 }] }, normalizeUser).total).toBe(0);
  });

  it('prefers total over count and rows over results', () => {
    const page = normalizePage({ total: 10, count: 20, rows: [{ id: 'r' }], results: [{ id: 'x' }, { id: 'y' }] }, normalizeUser);
    expect(page.total).toBe(10);
    expect(page.rows.map((r) => r.id)).toEqual(['r']);
  });

  it('defaults offset to 0 and limit to missing', () => {
    expect(normalizePage({ rows: [] }, normalizeUser)).toEqual({ total: 0, limit: null, offset: 0, period: null, rows: [] });
  });

  it('ignores a period that is not an object', () => {
    expect(normalizePage({ rows: [], period: '2026-11' }, normalizeUser).period).toBeNull();
  });
});

describe('planLabel', () => {
  it('maps every known plan key', () => {
    expect(PLAN_LABELS).toEqual({
      free: 'Free', pro: 'Pro', business: 'Business', enterprise: 'Business', scale: 'Business',
      prompts_100: '100 prompts', prompts_200: '200 prompts',
    });
    for (const [key, label] of Object.entries(PLAN_LABELS)) expect(planLabel(key)).toBe(label);
  });

  it('falls back to the key when the backend name is blank', () => {
    expect(planLabel('free', '  ')).toBe('Free');
    expect(planLabel('', null)).toBeNull();
  });
});

describe('overviewTiles', () => {
  const byKey = (raw) => Object.fromEntries(overviewTiles(raw).map((t) => [t.key, t]));

  it('prefers the totals block over the older figures for every tile', () => {
    const tiles = byKey({
      users: { total: 99 },
      organizations: { total: 99 },
      seats: { used: 99 },
      ai_usage: { tokens_month: 99, cost_month_usd: 99, tokens_all_time: 99 },
      tokens: { month: 99, all_time: 99 },
      totals: {
        users: 3, organizations: 1, seats_used: 4,
        tokens: { month: { total: 500 }, all_time: { total: 7000 } },
        cost_usd: { month: '0.25', all_time: '1.50' },
      },
    });
    expect(tiles.users.value).toBe(3);
    expect(tiles.orgs.value).toBe(1);
    expect(tiles.seats.value).toBe(4);
    expect(tiles.tokens).toMatchObject({ value: 500, label: 'Tokens this month (UTC)' });
    expect(tiles.cost).toMatchObject({ value: 0.25, label: 'AI cost this month (UTC)', format: 'usd' });
    expect(tiles.tokens_all.value).toBe(7000);
    expect(tiles.cost_all).toMatchObject({ value: 1.5, format: 'usd' });
  });

  it('shows a month of zero tokens and zero cost as zero, not the 30-day figure', () => {
    const tiles = byKey({
      ai_usage: { tokens_30d: 999, cost_30d_usd: 9.99 },
      totals: { tokens: { month: { total: 0 } }, cost_usd: { month: '0.000000' } },
    });
    expect(tiles.tokens).toMatchObject({ value: 0, label: 'Tokens this month (UTC)' });
    expect(tiles.cost).toMatchObject({ value: 0, label: 'AI cost this month (UTC)' });
  });

  it('keeps the display order', () => {
    const keys = overviewTiles({
      users: { total: 1, new_30d: 1 },
      subscriptions: { active: 1, trialing: 1, past_due: 1 },
      ai_usage: { tokens_30d: 1, cost_30d_usd: 1 },
      totals: {
        users: 1, accounts: 1, organizations: 1, individual_accounts: 1, seats_used: 1, pending_invites: 1,
        tokens: { all_time: { total: 1 } }, cost_usd: { all_time: 1 }, unattributed: { tokens: { month: { total: 1 } } },
      },
    }).map((t) => t.key);
    expect(keys).toEqual([
      'users', 'new_30d', 'accounts', 'orgs', 'individual', 'seats', 'pending_invites', 'active', 'trialing',
      'past_due', 'tokens', 'cost', 'tokens_all', 'cost_all', 'unattributed',
    ]);
  });

  it('returns no tiles for an empty payload', () => {
    expect(overviewTiles({})).toEqual([]);
    expect(overviewTiles()).toEqual([]);
    expect(overviewTiles({ totals: 'nope' })).toEqual([]);
  });

  it('formats only money tiles as dollars', () => {
    const tiles = overviewTiles({
      users: { total: 1 },
      ai_usage: { tokens_30d: 1, cost_30d_usd: 1 },
      totals: { tokens: { all_time: { total: 1 } }, cost_usd: { all_time: 1 } },
    });
    const usd = tiles.filter((t) => t.format === 'usd').map((t) => t.key);
    expect(usd).toEqual(['cost', 'cost_all']);
    expect(tiles.filter((t) => t.format !== 'count' && t.format !== 'usd')).toEqual([]);
  });

  it('reads the period only from the totals block', () => {
    expect(overviewPeriod({ period: { month_start: 'x' } })).toBeNull();
    expect(overviewPeriod({ totals: { period: 'x' } })).toBeNull();
    expect(overviewPeriod({ totals: { period: { month_start: 'x' } } })).toEqual({ month_start: 'x' });
    expect(overviewPeriod(null)).toBeNull();
  });
});
