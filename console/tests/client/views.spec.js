// @vitest-environment jsdom
// The numbers each view renders must be the numbers the API sent: right
// column, right format, nothing invented. Also paging, search and the
// stale-response guard.

import { flushPromises, mount } from '@vue/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createMemoryHistory, createRouter } from 'vue-router';

import PagerBar from '../../client/src/components/PagerBar.vue';
import { useRemote } from '../../client/src/lib/useRemote.js';
import AccountsView from '../../client/src/views/AccountsView.vue';
import OverviewView from '../../client/src/views/OverviewView.vue';
import LoginView from '../../client/src/views/LoginView.vue';
import UsersView from '../../client/src/views/UsersView.vue';
import { session } from '../../client/src/lib/session.js';

function jsonFetch(handler) {
  return vi.fn(async (url, init) => {
    const { status = 200, body } = handler(String(url), init);
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  });
}

async function mountAt(component, path) {
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [{ path: '/:any(.*)*', component }],
  });
  router.push(path);
  await router.isReady();
  const wrapper = mount(component, { global: { plugins: [router] }, attachTo: document.body });
  await flushPromises();
  return wrapper;
}

// Text of each cell of one table row, keyed by its column header.
function rowByHeader(table, rowIndex = 0) {
  const headers = table.findAll(':scope > thead th').map((th) => th.text());
  const row = table.findAll(':scope > tbody > tr').filter((tr) => tr.find(':scope > td').exists())[rowIndex];
  const cells = row.findAll(':scope > th, :scope > td').map((c) => c.text());
  return Object.fromEntries(headers.map((h, i) => [h, cells[i]]));
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  document.body.innerHTML = '';
});

const PERIOD = { month_start: '2026-11-01T00:00:00+00:00', as_of: '2026-11-08T12:00:00+00:00' };

describe('OverviewView', () => {
  const OVERVIEW = {
    users: { total: 99, new_30d: 2 },
    subscriptions: { active: 2, trialing: 0, past_due: 0 },
    ai_usage: { tokens_30d: 999999, cost_30d_usd: 9.99 },
    totals: {
      period: PERIOD,
      users: 3,
      organizations: 1,
      individual_accounts: 1,
      accounts: 2,
      seats_used: 3,
      pending_invites: 1,
      tokens: { month: { total: 5734 }, all_time: { total: 1234567890123 } },
      cost_usd: { month: '0.012345', all_time: '0.400000' },
      unattributed: { tokens: { month: { total: 66 } } },
    },
    generated_at: '2026-11-08T12:00:00+00:00',
  };

  it('shows each total exactly as the API sent it, money in dollars', async () => {
    const fetchMock = jsonFetch(() => ({ body: OVERVIEW }));
    vi.stubGlobal('fetch', fetchMock);
    const wrapper = await mountAt(OverviewView, '/');
    expect(fetchMock.mock.calls[0][0]).toBe('/api/overview');
    const tiles = Object.fromEntries(wrapper.findAll('dl > div').map((d) => [d.find('dt').text(), d.find('dd').text()]));
    expect(tiles).toEqual({
      Users: '3',
      'New users, last 30 days': '2',
      Accounts: '2',
      Organizations: '1',
      'Single-seat accounts': '1',
      'Seats in use': '3',
      'Pending invites': '1',
      'Active subscriptions': '2',
      Trialing: '0',
      'Past due': '0',
      'Tokens this month (UTC)': '5,734',
      'AI cost this month (UTC)': '$0.01',
      'Tokens, all time': '1,234,567,890,123',
      'AI cost, all time': '$0.40',
      'Unattributed tokens this month (pre-signup scans)': '66',
    });
    expect(wrapper.text()).toContain('Month figures: This month (UTC): November 2026');
    expect(wrapper.text()).toContain('As of Nov 8, 2026, 12:00 UTC');
  });

  it('labels 30-day figures as such when the backend has no month block', async () => {
    vi.stubGlobal('fetch', jsonFetch(() => ({ body: { ai_usage: { tokens_30d: 5000, cost_30d_usd: 1.5 } } })));
    const wrapper = await mountAt(OverviewView, '/');
    const tiles = Object.fromEntries(wrapper.findAll('dl > div').map((d) => [d.find('dt').text(), d.find('dd').text()]));
    expect(tiles).toEqual({ 'Tokens, last 30 days': '5,000', 'AI cost, last 30 days': '$1.50' });
    expect(wrapper.text()).not.toContain('Month figures');
    expect(wrapper.text()).not.toContain('As of');
  });

  it('says so when the backend returns no figures', async () => {
    vi.stubGlobal('fetch', jsonFetch(() => ({ body: {} })));
    const wrapper = await mountAt(OverviewView, '/');
    expect(wrapper.text()).toContain('No totals yet.');
    expect(wrapper.find('dl').exists()).toBe(false);
  });

  it('shows the error and retries', async () => {
    let fail = true;
    vi.stubGlobal('fetch', jsonFetch(() => (fail
      ? { status: 504, body: { error: 'The backend did not answer in time.' } }
      : { body: { totals: { users: 7 } } })));
    const wrapper = await mountAt(OverviewView, '/');
    expect(wrapper.find('[role="alert"]').text()).toContain('The backend did not answer in time.');
    fail = false;
    await wrapper.find('[role="alert"] button').trigger('click');
    await flushPromises();
    expect(wrapper.find('[role="alert"]').exists()).toBe(false);
    expect(wrapper.find('dd').text()).toBe('7');
  });
});

describe('UsersView', () => {
  it('puts month and all-time tokens in their own columns', async () => {
    vi.stubGlobal('fetch', jsonFetch(() => ({
      body: {
        total: 1, limit: 50, offset: 0, period: PERIOD,
        rows: [{
          id: 'u-1', email: 'ana@acme.co', full_name: 'Ana', plan: 'free',
          last_login: '2026-11-07T09:05:00Z', tokens: { month: { total: 12 }, all_time: { total: 3456 } },
        }],
      },
    })));
    const wrapper = await mountAt(UsersView, '/users');
    const row = rowByHeader(wrapper.find('table'));
    expect(row).toMatchObject({
      Email: 'ana@acme.co',
      Name: 'Ana',
      Plan: 'Free',
      Organization: '—',
      'Last login': 'Nov 7, 2026, 09:05 UTC',
      'Tokens this month': '12',
      'Tokens all time': '3,456',
    });
    expect(row['User ID']).toContain('u-1');
  });

  it('shows a missing figure as a dash and zero as 0', async () => {
    vi.stubGlobal('fetch', jsonFetch(() => ({
      body: { total: 2, rows: [{ id: 'a', tokens_all_time: 0 }, { id: 'b', tokens_month: 0 }] },
    })));
    const wrapper = await mountAt(UsersView, '/users');
    const table = wrapper.find('table');
    expect(rowByHeader(table, 0)).toMatchObject({ 'Tokens this month': '—', 'Tokens all time': '0' });
    expect(rowByHeader(table, 1)).toMatchObject({ 'Tokens this month': '0', 'Tokens all time': '—' });
  });

  it('sends the search term as both search and q, and starts again at offset 0', async () => {
    vi.useFakeTimers();
    const fetchMock = jsonFetch(() => ({ body: { total: 120, limit: 50, offset: 0, rows: [{ id: 'x' }] } }));
    vi.stubGlobal('fetch', fetchMock);
    const wrapper = await mountAt(UsersView, '/users');
    expect(fetchMock.mock.calls.at(-1)[0]).toBe('/api/users?limit=50&offset=0');

    await wrapper.findAll('nav button').find((b) => b.text() === 'Next').trigger('click');
    await flushPromises();
    expect(fetchMock.mock.calls.at(-1)[0]).toBe('/api/users?limit=50&offset=50');

    await wrapper.find('input[type="search"]').setValue('  acme  ');
    vi.advanceTimersByTime(300);
    await flushPromises();
    expect(fetchMock.mock.calls.at(-1)[0]).toBe('/api/users?search=acme&q=acme&limit=50&offset=0');
  });

  it('says no users match a search', async () => {
    const fetchMock = jsonFetch(() => ({ body: { total: 0, rows: [] } }));
    vi.stubGlobal('fetch', fetchMock);
    const wrapper = await mountAt(UsersView, '/users');
    await wrapper.find('input[type="search"]').setValue('zzz');
    await wrapper.find('form[role="search"]').trigger('submit');
    await flushPromises();
    expect(wrapper.text()).toContain('No users match this search.');
    expect(wrapper.text()).toContain('No email or name contains this text.');
  });
});

describe('AccountsView', () => {
  function account(overrides = {}) {
    return {
      id: 'org-1', type: 'organization', name: 'Acme', plan: 'prompts_200', plan_name: '200 prompts ($140/mo)',
      seat_limit: 5, seats_used: 2, pending_invites: 1, seats_available: 2, over_limit: false,
      tokens: { month: { total: 4500 }, all_time: { total: 100000 } },
      seats: [
        { user_id: 'u1', email: 'owner@acme.co', full_name: 'Olive', role: 'owner', active: true, tokens: { month: { total: 4000 }, all_time: { total: 90000 } } },
        { user_id: 'u2', email: 'm@acme.co', role: 'member', tokens: { month: { total: 500 }, all_time: { total: 10000 } } },
      ],
      ...overrides,
    };
  }

  async function mountAccounts(rows, extra = {}) {
    const fetchMock = jsonFetch(() => ({ body: { total: rows.length, limit: 50, offset: 0, period: PERIOD, rows, ...extra } }));
    vi.stubGlobal('fetch', fetchMock);
    const wrapper = await mountAt(AccountsView, '/accounts');
    return { wrapper, fetchMock };
  }

  async function expand(wrapper, id) {
    await wrapper.find(`button[aria-controls="seats-${id}"]`).trigger('click');
    return wrapper.find(`#seats-${id}`);
  }

  it('shows seats used / limit and tokens in their own columns', async () => {
    const { wrapper } = await mountAccounts([account()]);
    const row = rowByHeader(wrapper.find('table'));
    expect(row).toEqual({
      Account: 'Acme',
      Type: 'Organization',
      Plan: '200 prompts ($140/mo)',
      'Seats used / limit': '2 / 5',
      'Tokens this month': '4,500',
      'Tokens all time': '100,000',
    });
  });

  it('puts each seat\'s month and all-time tokens in their own columns', async () => {
    const { wrapper } = await mountAccounts([account()]);
    const seats = (await expand(wrapper, 'org-1')).find('table');
    expect(rowByHeader(seats, 0)).toMatchObject({
      Email: 'owner@acme.co', Name: 'Olive', Role: 'owner', 'Tokens this month': '4,000', 'Tokens all time': '90,000',
    });
    expect(rowByHeader(seats, 1)).toMatchObject({
      Email: 'm@acme.co', Name: '—', 'Tokens this month': '500', 'Tokens all time': '10,000',
    });
    // No "active" field means active.
    expect(seats.text()).not.toContain('(inactive)');
  });

  it('summarises the seats from the backend counts', async () => {
    const { wrapper } = await mountAccounts([account()]);
    const caption = (await expand(wrapper, 'org-1')).find('caption').text().replace(/\s+/g, ' ');
    expect(caption).toContain('Seats on Acme: 2 / 5 used, 1 invited, 2 open.');
    expect(caption).toContain('This month (UTC): November 2026');
  });

  it('shows unlimited seats without an open count', async () => {
    const { wrapper } = await mountAccounts([account({ plan: 'business', plan_name: null, seat_limit: -1, seats_used: 12, pending_invites: 0, seats_available: -1 })]);
    expect(rowByHeader(wrapper.find('table'))['Seats used / limit']).toBe('12 / Unlimited');
    const caption = (await expand(wrapper, 'org-1')).find('caption').text().replace(/\s+/g, ' ');
    expect(caption).toContain('12 / Unlimited used.');
    expect(caption).not.toContain('open');
    expect(caption).not.toContain('invited');
  });

  it('computes open seats from used and limit only when the backend does not send them', async () => {
    const { wrapper } = await mountAccounts([account({ seats_available: undefined, pending_invites: undefined, seat_limit: 5, seats_used: 1 })]);
    const caption = (await expand(wrapper, 'org-1')).find('caption').text().replace(/\s+/g, ' ');
    expect(caption).toContain('1 / 5 used, 4 open.');
  });

  it('never shows a negative open count for an account over its limit', async () => {
    const { wrapper } = await mountAccounts([account({ seats_available: undefined, pending_invites: 0, seat_limit: 5, seats_used: 6, over_limit: true })]);
    const caption = (await expand(wrapper, 'org-1')).find('caption').text().replace(/\s+/g, ' ');
    expect(caption).toContain('6 / 5 used, over the seat limit.');
    expect(caption).not.toMatch(/-\d+ open/);
    expect(caption).not.toContain('open');
  });

  it('does not compute open seats against an unlimited limit', async () => {
    const { wrapper } = await mountAccounts([account({ seats_available: undefined, pending_invites: 0, seat_limit: -1, seats_used: 3 })]);
    const caption = (await expand(wrapper, 'org-1')).find('caption').text().replace(/\s+/g, ' ');
    expect(caption).toContain('3 / Unlimited used.');
  });

  it.each([
    ['free', 'Free', 1, 1, '1 / 1'],
    ['prompts_100', '100 prompts', 1, 1, '1 / 1'],
    ['prompts_200', '200 prompts', 5, 3, '3 / 5'],
    ['business', 'Business', -1, 40, '40 / Unlimited'],
  ])('shows the %s plan\'s seat limit as the backend reports it', async (plan, label, limit, used, shown) => {
    const { wrapper } = await mountAccounts([account({ plan, plan_name: null, seat_limit: limit, seats_used: used })]);
    const row = rowByHeader(wrapper.find('table'));
    expect(row.Plan).toBe(label);
    expect(row['Seats used / limit']).toBe(shown);
  });

  it('marks invited and inactive seats', async () => {
    const { wrapper } = await mountAccounts([account({
      seats: [
        { email: 'new@acme.co', role: 'member', status: 'pending' },
        { user_id: 'u3', email: 'gone@acme.co', role: 'member', active: false },
      ],
    })]);
    const seats = (await expand(wrapper, 'org-1')).find('table');
    expect(rowByHeader(seats, 0).Role).toBe('Invited');
    expect(rowByHeader(seats, 0)['User ID']).toBe('—');
    expect(rowByHeader(seats, 1).Role).toBe('member (inactive)');
  });

  it('collapses an expanded account on a second click', async () => {
    const { wrapper } = await mountAccounts([account()]);
    await expand(wrapper, 'org-1');
    const seats = await expand(wrapper, 'org-1');
    expect(wrapper.find('button[aria-controls="seats-org-1"]').attributes('aria-expanded')).toBe('false');
    expect(seats.text()).not.toContain('owner@acme.co');
  });

  it('names a single-seat account and says when no seat is filled', async () => {
    const { wrapper } = await mountAccounts([
      account({ id: 'solo', type: 'individual', name: null, seats: [{ user_id: 's1', email: 'solo@x.co' }] }),
      account({ id: 'empty', name: 'Empty Org', seats: [] }),
    ]);
    const table = wrapper.find('table');
    expect(rowByHeader(table, 0)).toMatchObject({ Account: 'solo@x.co', Type: 'Single seat' });
    expect((await expand(wrapper, 'empty')).text()).toContain('No seats are filled on this account.');
  });

  it('collapses expanded rows and starts again at offset 0 on a new search', async () => {
    vi.useFakeTimers();
    const fetchMock = jsonFetch(() => ({ body: { total: 120, limit: 50, offset: 0, rows: [account()] } }));
    vi.stubGlobal('fetch', fetchMock);
    const wrapper = await mountAt(AccountsView, '/accounts');
    await wrapper.findAll('nav button').find((b) => b.text() === 'Next').trigger('click');
    await flushPromises();
    expect(fetchMock.mock.calls.at(-1)[0]).toBe('/api/accounts?limit=50&offset=50');
    await expand(wrapper, 'org-1');
    expect(wrapper.find('button[aria-controls="seats-org-1"]').attributes('aria-expanded')).toBe('true');

    await wrapper.find('input[type="search"]').setValue('acme');
    vi.advanceTimersByTime(300);
    await flushPromises();
    expect(fetchMock.mock.calls.at(-1)[0]).toBe('/api/accounts?search=acme&q=acme&limit=50&offset=0');
    expect(wrapper.find('button[aria-controls="seats-org-1"]').attributes('aria-expanded')).toBe('false');
  });

  it('says no accounts match a search', async () => {
    const fetchMock = jsonFetch(() => ({ body: { total: 0, rows: [] } }));
    vi.stubGlobal('fetch', fetchMock);
    const wrapper = await mountAt(AccountsView, '/accounts');
    expect(wrapper.text()).toContain('No accounts yet.');
    await wrapper.find('input[type="search"]').setValue('zzz');
    await wrapper.find('form[role="search"]').trigger('submit');
    await flushPromises();
    expect(wrapper.text()).toContain('No accounts match this search.');
  });
});

describe('PagerBar', () => {
  function pager(props) {
    return mount(PagerBar, { props: { label: 'Pages', ...props } });
  }
  const buttons = (w) => Object.fromEntries(w.findAll('button').map((b) => [b.text(), b]));

  it('disables Next on the last full page', () => {
    const w = pager({ total: 50, offset: 0, limit: 50, count: 50 });
    expect(w.text()).toContain('Showing 1–50 of 50');
    expect(buttons(w).Next.attributes('disabled')).toBeDefined();
    expect(buttons(w).Previous.attributes('disabled')).toBeDefined();
  });

  it('enables Next when one more row remains', async () => {
    const w = pager({ total: 51, offset: 0, limit: 50, count: 50 });
    expect(buttons(w).Next.attributes('disabled')).toBeUndefined();
    await buttons(w).Next.trigger('click');
    expect(w.emitted('change')).toEqual([[50]]);
  });

  it('goes back by one page and never below 0', async () => {
    const w = pager({ total: 120, offset: 30, limit: 50, count: 50 });
    expect(w.text()).toContain('Showing 31–80 of 120');
    await buttons(w).Previous.trigger('click');
    expect(w.emitted('change')).toEqual([[0]]);
  });

  it('shows 0–0 for an empty page', () => {
    const w = pager({ total: 0, offset: 0, limit: 50, count: 0 });
    expect(w.text()).toContain('Showing 0–0 of 0');
  });
});

describe('useRemote', () => {
  it('keeps the newest answer when an older request finishes last', async () => {
    const resolvers = [];
    const { data, loading, load } = useRemote((n) => new Promise((resolve) => resolvers.push(() => resolve(n))));
    const first = load('old');
    const second = load('new');
    resolvers[1]();
    await second;
    expect(data.value).toBe('new');
    expect(loading.value).toBe(false);
    resolvers[0]();
    await first;
    expect(data.value).toBe('new');
    expect(loading.value).toBe(false);
  });

  it('ignores the error of a superseded request', async () => {
    const steps = [];
    const { data, error, load } = useRemote(() => new Promise((resolve, reject) => steps.push({ resolve, reject })));
    const first = load();
    const second = load();
    steps[1].resolve('fresh');
    await second;
    steps[0].reject(new Error('stale failure'));
    await first;
    expect(error.value).toBe('');
    expect(data.value).toBe('fresh');
  });

  it('keeps the previous data while reloading and clears the old error', async () => {
    let fail = true;
    const { data, error, loading, load } = useRemote(async () => {
      if (fail) throw new Error('boom');
      return 'ok';
    });
    await load();
    expect(error.value).toBe('boom');
    fail = false;
    const p = load();
    expect(error.value).toBe('');
    expect(loading.value).toBe(true);
    await p;
    expect(data.value).toBe('ok');
  });

  it('uses a generic message for an error without one', async () => {
    const { error, load } = useRemote(async () => {
      throw {};
    });
    await load();
    expect(error.value).toBe('Something went wrong.');
  });
});

describe('LoginView', () => {
  afterEach(() => {
    session.email = null;
    session.checked = false;
  });

  async function mountLogin(path) {
    const router = createRouter({
      history: createMemoryHistory(),
      routes: [
        { path: '/', component: { template: '<div>home</div>' } },
        { path: '/login', component: LoginView },
        { path: '/users', component: { template: '<div>users</div>' } },
      ],
    });
    router.push(path);
    await router.isReady();
    const wrapper = mount(LoginView, { global: { plugins: [router] } });
    return { wrapper, router };
  }

  it('asks for both fields without calling the server', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const { wrapper } = await mountLogin('/login');
    await wrapper.find('#email').setValue('   ');
    await wrapper.find('#password').setValue('pw');
    await wrapper.find('form').trigger('submit');
    await flushPromises();
    expect(wrapper.find('[role="alert"]').text()).toBe('Enter your email and password.');
    expect(wrapper.find('#email').attributes('aria-invalid')).toBe('true');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('tells the operator the session ended until an error replaces it', async () => {
    vi.stubGlobal('fetch', jsonFetch(() => ({ status: 401, body: { error: 'Email or password is incorrect.' } })));
    const { wrapper } = await mountLogin('/login?expired=1');
    expect(wrapper.find('[role="status"]').text()).toBe('Your session ended. Sign in again.');
    await wrapper.find('#email').setValue('ops@example.com');
    await wrapper.find('#password').setValue('nope');
    await wrapper.find('form').trigger('submit');
    await flushPromises();
    expect(wrapper.find('[role="status"]').exists()).toBe(false);
  });

  it('sends the trimmed email and refuses an off-site next', async () => {
    const fetchMock = jsonFetch(() => ({ body: { email: 'ops@example.com' } }));
    vi.stubGlobal('fetch', fetchMock);
    const { wrapper, router } = await mountLogin('/login?next=//evil.example.com');
    await wrapper.find('#email').setValue('  ops@example.com ');
    await wrapper.find('#password').setValue(' pw with spaces ');
    await wrapper.find('form').trigger('submit');
    await flushPromises();
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ email: 'ops@example.com', password: ' pw with spaces ' });
    expect(router.currentRoute.value.fullPath).toBe('/');
    expect(wrapper.find('#password').element.value).toBe('');
  });

  it('shows a network failure and re-enables the button', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new TypeError('offline');
    }));
    const { wrapper } = await mountLogin('/login');
    await wrapper.find('#email').setValue('ops@example.com');
    await wrapper.find('#password').setValue('pw');
    await wrapper.find('form').trigger('submit');
    await flushPromises();
    expect(wrapper.find('[role="alert"]').text()).toBe('The console server could not be reached.');
    expect(wrapper.find('button[type="submit"]').attributes('disabled')).toBeUndefined();
    expect(wrapper.find('button[type="submit"]').text()).toBe('Sign in');
  });
});
