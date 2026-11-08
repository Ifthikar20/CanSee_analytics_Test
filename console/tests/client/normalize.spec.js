import { describe, expect, it } from 'vitest';

import {
  normalizeAccount, normalizePage, normalizeUser, overviewPeriod, overviewTiles, planLabel,
} from '../../client/src/lib/normalize.js';

// Payloads exactly as the backend's internal admin API builds them
// (apps/accounts/api/v1/admin_views.py and services/token_usage.py).
function usageBlock(month, allTime, cost = { month: '0.000000', all_time: '0.000000' }) {
  return {
    tokens: {
      month: { input: Math.floor(month / 2), output: month - Math.floor(month / 2), total: month, requests: 1 },
      all_time: { input: Math.floor(allTime / 2), output: allTime - Math.floor(allTime / 2), total: allTime, requests: 3 },
    },
    cost_usd: cost,
  };
}

const PERIOD = { month_start: '2026-11-01T00:00:00+00:00', as_of: '2026-11-08T12:00:00+00:00' };

const OWNER_SEAT = {
  user_id: '0b6c1f0e-1111-4aaa-8bbb-000000000001',
  email: 'owner@acme.co',
  full_name: 'Olive Owner',
  role: 'owner',
  joined_via: 'created',
  joined_at: '2026-09-01T10:00:00+00:00',
  active: true,
  last_login: '2026-11-07T09:00:00+00:00',
  ...usageBlock(4000, 90000),
};
const MEMBER_SEAT = {
  user_id: '0b6c1f0e-1111-4aaa-8bbb-000000000002',
  email: 'member@acme.co',
  full_name: '',
  role: 'member',
  joined_via: 'invite',
  joined_at: '2026-10-01T10:00:00+00:00',
  active: false,
  last_login: null,
  ...usageBlock(500, 10000),
};

const ORG_ACCOUNT = {
  type: 'organization',
  id: '7d1e0000-2222-4ccc-8ddd-000000000001',
  name: 'Acme',
  plan: 'prompts_200',
  plan_name: '200 prompts ($140/mo)',
  seat_limit_source: 'plan',
  seat_limit: 5,
  seats_used: 2,
  pending_invites: 1,
  seats_available: 2,
  over_limit: false,
  owner: { id: OWNER_SEAT.user_id, email: OWNER_SEAT.email, full_name: OWNER_SEAT.full_name },
  created_at: '2026-09-01T10:00:00+00:00',
  ...usageBlock(4500, 100000, { month: '0.012000', all_time: '0.400000' }),
  seats: [OWNER_SEAT, MEMBER_SEAT],
};

const SOLO_SEAT = {
  user_id: '0b6c1f0e-1111-4aaa-8bbb-000000000003',
  email: 'solo@example.com',
  full_name: 'Sam Solo',
  role: 'owner',
  joined_via: 'individual',
  joined_at: '2026-10-05T10:00:00+00:00',
  active: true,
  last_login: null,
  ...usageBlock(1234, 56789),
};
const SOLO_ACCOUNT = {
  type: 'individual',
  id: SOLO_SEAT.user_id,
  name: 'Sam Solo',
  plan: 'prompts_100',
  plan_name: '100 prompts ($80/mo)',
  seat_limit_source: 'plan',
  seat_limit: 1,
  seats_used: 1,
  pending_invites: 0,
  seats_available: 0,
  over_limit: false,
  owner: { id: SOLO_SEAT.user_id, email: SOLO_SEAT.email, full_name: SOLO_SEAT.full_name },
  created_at: '2026-10-05T10:00:00+00:00',
  tokens: SOLO_SEAT.tokens,
  cost_usd: SOLO_SEAT.cost_usd,
  seats: [SOLO_SEAT],
};

const USER_ROW = {
  id: OWNER_SEAT.user_id,
  email: 'owner@acme.co',
  full_name: 'Olive Owner',
  plan: 'prompts_200',
  plan_name: '200 prompts ($140/mo)',
  plan_source: 'organization',
  subscription_status: 'active',
  projects: 2,
  active: true,
  verified: true,
  joined: '2026-09-01T10:00:00+00:00',
  last_login: '2026-11-07T09:00:00+00:00',
  organization: { id: ORG_ACCOUNT.id, name: 'Acme', role: 'owner' },
  prompts: 12,
  audits: 4,
  tokens_total: 90000,
  ai_cost_usd: 0.3,
  integrations: ['gsc'],
  ...usageBlock(4000, 90000),
};

describe('backend admin API payloads', () => {
  it('reads a users page row with nested month and all-time tokens', () => {
    const page = normalizePage({ total: 1, limit: 50, offset: 0, period: PERIOD, rows: [USER_ROW] }, normalizeUser);
    expect(page.period).toEqual(PERIOD);
    expect(page.rows[0]).toMatchObject({
      id: OWNER_SEAT.user_id,
      email: 'owner@acme.co',
      name: 'Olive Owner',
      planLabel: '200 prompts ($140/mo)',
      organization: { id: ORG_ACCOUNT.id, name: 'Acme' },
      lastLogin: '2026-11-07T09:00:00+00:00',
      tokensMonth: 4000,
      tokensAllTime: 90000,
    });
  });

  it('prefers the nested all-time total over the legacy tokens_total', () => {
    const user = normalizeUser({ ...USER_ROW, tokens_total: 1 });
    expect(user.tokensAllTime).toBe(90000);
  });

  it('reads an organization account with its seats list', () => {
    const page = normalizePage(
      { total: 2, organizations: 1, individual_accounts: 1, limit: 25, offset: 0, period: PERIOD, rows: [ORG_ACCOUNT, SOLO_ACCOUNT] },
      normalizeAccount,
    );
    const [org, solo] = page.rows;
    expect(org).toMatchObject({
      id: ORG_ACCOUNT.id,
      name: 'Acme',
      kind: 'organization',
      planLabel: '200 prompts ($140/mo)',
      seatLimit: 5,
      seatsUsed: 2,
      pendingInvites: 1,
      seatsAvailable: 2,
      overLimit: false,
      tokensMonth: 4500,
      tokensAllTime: 100000,
    });
    expect(org.members).toHaveLength(2);
    expect(org.members[0]).toMatchObject({
      userId: OWNER_SEAT.user_id, email: 'owner@acme.co', name: 'Olive Owner', role: 'owner',
      active: true, tokensMonth: 4000, tokensAllTime: 90000,
    });
    expect(org.members[1]).toMatchObject({
      userId: MEMBER_SEAT.user_id, name: null, role: 'member', active: false, tokensMonth: 500, tokensAllTime: 10000,
    });
    expect(solo).toMatchObject({
      kind: 'individual', planLabel: '100 prompts ($80/mo)', seatLimit: 1, seatsUsed: 1, seatsAvailable: 0,
      tokensMonth: 1234, tokensAllTime: 56789,
    });
    expect(solo.members).toHaveLength(1);
    expect(solo.members[0]).toMatchObject({ userId: SOLO_SEAT.user_id, tokensMonth: 1234, tokensAllTime: 56789 });
  });

  it('keeps unlimited seats as -1 and an empty seats list as no members', () => {
    const account = normalizeAccount({ ...ORG_ACCOUNT, seat_limit: -1, seats_available: -1, seats_used: 0, seats: [] });
    expect(account.seatLimit).toBe(-1);
    expect(account.seatsAvailable).toBe(-1);
    expect(account.members).toEqual([]);
  });

  it('builds the overview tiles from the totals block', () => {
    const raw = {
      users: { total: 3, new_7d: 1, new_30d: 2, verified: 3 },
      subscriptions: { active: 2, trialing: 0, past_due: 0, canceled: 1 },
      projects: { total: 4 },
      audits: { total: 9, last_7d: 2 },
      ai_usage: { tokens_30d: 999999, cost_30d_usd: 9.99 },
      totals: {
        period: PERIOD,
        users: 3,
        organizations: 1,
        individual_accounts: 1,
        accounts: 2,
        seats_used: 3,
        pending_invites: 1,
        ...usageBlock(5734, 156789, { month: '0.012345', all_time: '0.400000' }),
        unattributed: usageBlock(66, 700),
      },
      generated_at: '2026-11-08T12:00:00+00:00',
    };
    const byKey = Object.fromEntries(overviewTiles(raw).map((t) => [t.key, t]));
    expect(byKey.users.value).toBe(3);
    expect(byKey.accounts.value).toBe(2);
    expect(byKey.orgs.value).toBe(1);
    expect(byKey.individual.value).toBe(1);
    expect(byKey.seats.value).toBe(3);
    expect(byKey.pending_invites.value).toBe(1);
    expect(byKey.tokens).toMatchObject({ label: 'Tokens this month (UTC)', value: 5734, format: 'count' });
    expect(byKey.cost).toMatchObject({ label: 'AI cost this month (UTC)', value: 0.012345, format: 'usd' });
    expect(byKey.tokens_all.value).toBe(156789);
    expect(byKey.cost_all.value).toBe(0.4);
    expect(byKey.unattributed.value).toBe(66);
    expect(overviewPeriod(raw)).toEqual(PERIOD);
  });
});

describe('normalizeUser', () => {
  it('reads the current backend directory row', () => {
    const user = normalizeUser({
      id: 'c0ffee00-0000-4000-8000-000000000001',
      email: 'ana@acme.co',
      full_name: 'Ana Lima',
      plan: 'prompts_200',
      joined: '2026-01-02T00:00:00Z',
      last_login: null,
      tokens_total: 98765,
    });
    expect(user).toMatchObject({
      id: 'c0ffee00-0000-4000-8000-000000000001',
      email: 'ana@acme.co',
      name: 'Ana Lima',
      planLabel: '200 prompts',
      organization: null,
      lastLogin: null,
      tokensAllTime: 98765,
      tokensMonth: null,
    });
  });

  it('reads the extended contract with month tokens and an organization', () => {
    const user = normalizeUser({
      id: 7,
      email: 'b@acme.co',
      plan: 'pro',
      plan_name: 'Pro ($45/mo)',
      organization: { id: 3, name: 'Acme' },
      tokens_month: '1200',
      tokens_all_time: 0,
    });
    expect(user.id).toBe('7');
    expect(user.planLabel).toBe('Pro ($45/mo)');
    expect(user.organization).toEqual({ id: '3', name: 'Acme' });
    expect(user.tokensMonth).toBe(1200);
    expect(user.tokensAllTime).toBe(0);
  });

  it('never invents a number the backend did not send', () => {
    const user = normalizeUser({ id: 'x', tokens_month: null, tokens_total: 'n/a' });
    expect(user.tokensMonth).toBeNull();
    expect(user.tokensAllTime).toBeNull();
  });
});

describe('normalizeAccount', () => {
  it('reads an organization with per-seat members', () => {
    const account = normalizeAccount({
      id: 'org-1',
      kind: 'organization',
      name: 'Acme',
      plan: 'prompts_200',
      seat_limit: 5,
      seats_used: 3,
      tokens_month: 4500,
      tokens_all_time: 100000,
      members: [
        { user_id: 'u1', email: 'owner@acme.co', role: 'owner', tokens_month: 4000, tokens_all_time: 90000 },
        { user_id: 'u2', email: 'm@acme.co', role: 'member', tokens_month: 500, tokens_all_time: 10000 },
        { email: 'new@acme.co', role: 'member', status: 'pending' },
      ],
    });
    expect(account).toMatchObject({
      kind: 'organization', planLabel: '200 prompts', seatLimit: 5, seatsUsed: 3, tokensMonth: 4500,
    });
    expect(account.members).toHaveLength(3);
    expect(account.members[0]).toMatchObject({ userId: 'u1', role: 'owner', tokensMonth: 4000, tokensAllTime: 90000 });
    expect(account.members[2]).toMatchObject({ userId: null, pending: true, tokensMonth: null });
  });

  it('reads a single-seat account and a nested seats block', () => {
    const account = normalizeAccount({ id: 9, type: 'individual', plan: 'prompts_100', seats: { used: 1, max: 1 } });
    expect(account.kind).toBe('individual');
    expect(account.seatLimit).toBe(1);
    expect(account.seatsUsed).toBe(1);
    expect(account.members).toEqual([]);
  });

  it('leaves seats unknown when the backend does not report them', () => {
    const account = normalizeAccount({ id: 1, members: [{ user_id: 'a' }, { user_id: 'b' }] });
    expect(account.seatsUsed).toBeNull();
    expect(account.seatLimit).toBeNull();
  });
});

describe('normalizePage', () => {
  it('reads rows/total and results/count pages', () => {
    expect(normalizePage({ total: 120, limit: 50, offset: 50, rows: [{ id: 1 }] }, normalizeUser))
      .toMatchObject({ total: 120, limit: 50, offset: 50 });
    const drf = normalizePage({ count: 2, results: [{ id: 1 }, { id: 2 }] }, normalizeUser);
    expect(drf.total).toBe(2);
    expect(drf.rows.map((r) => r.id)).toEqual(['1', '2']);
    expect(normalizePage(null, normalizeUser)).toMatchObject({ total: 0, rows: [] });
  });
});

describe('planLabel', () => {
  it('prefers the backend name, then known keys, then the raw value', () => {
    expect(planLabel('pro', 'Pro')).toBe('Pro');
    expect(planLabel('prompts_100')).toBe('100 prompts');
    expect(planLabel('custom_x')).toBe('custom_x');
    expect(planLabel(null)).toBeNull();
  });
});

describe('overviewTiles', () => {
  it('labels 30-day usage as 30 days and omits figures the backend lacks', () => {
    const tiles = overviewTiles({
      users: { total: 12, new_30d: 3 },
      subscriptions: { active: 4, trialing: 1, past_due: 0 },
      ai_usage: { tokens_30d: 5000, cost_30d_usd: 1.5 },
    });
    const byKey = Object.fromEntries(tiles.map((t) => [t.key, t]));
    expect(byKey.tokens).toMatchObject({ label: 'Tokens, last 30 days', value: 5000 });
    expect(byKey.cost).toMatchObject({ label: 'AI cost, last 30 days', value: 1.5, format: 'usd' });
    expect(byKey.past_due.value).toBe(0);
    expect(byKey.orgs).toBeUndefined();
    expect(byKey.tokens_all).toBeUndefined();
    expect(overviewPeriod({})).toBeNull();
  });

  it('uses month figures when the backend sends them', () => {
    const tiles = overviewTiles({
      ai_usage: { tokens_month: 777, tokens_30d: 999, tokens_all_time: 10000 },
      organizations: { total: 2 },
      seats: { used: 6 },
    });
    const byKey = Object.fromEntries(tiles.map((t) => [t.key, t]));
    expect(byKey.tokens).toMatchObject({ label: 'Tokens this month (UTC)', value: 777 });
    expect(byKey.orgs.value).toBe(2);
    expect(byKey.seats.value).toBe(6);
    expect(byKey.tokens_all.value).toBe(10000);
  });
});
