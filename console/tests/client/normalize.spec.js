import { describe, expect, it } from 'vitest';

import {
  normalizeAccount, normalizePage, normalizeUser, overviewTiles, planLabel,
} from '../../client/src/lib/normalize.js';

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
