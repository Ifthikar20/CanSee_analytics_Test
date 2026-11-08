// @vitest-environment jsdom
import { flushPromises, mount } from '@vue/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createMemoryHistory, createRouter } from 'vue-router';

import AccountsView from '../../client/src/views/AccountsView.vue';
import CopyButton from '../../client/src/components/CopyButton.vue';
import LoginView from '../../client/src/views/LoginView.vue';
import UsersView from '../../client/src/views/UsersView.vue';
import { session } from '../../client/src/lib/session.js';

function jsonFetch(handler) {
  return vi.fn(async (url, init) => {
    const { status = 200, body } = handler(String(url), init);
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  });
}

async function mountWithRouter(component, path = '/') {
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/', component: { template: '<div>home</div>' } },
      { path: '/login', name: 'login', component },
      { path: '/users', component },
      { path: '/accounts', component },
    ],
  });
  router.push(path);
  await router.isReady();
  const wrapper = mount(component, { global: { plugins: [router] } });
  await flushPromises();
  return { wrapper, router };
}

afterEach(() => {
  vi.unstubAllGlobals();
  session.email = null;
  session.checked = false;
});

describe('CopyButton', () => {
  it('copies the value and confirms', async () => {
    const writeText = vi.fn(async () => {});
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    const wrapper = mount(CopyButton, { props: { value: 'user-123', label: 'Copy user ID' } });
    expect(wrapper.attributes('aria-label')).toBe('Copy user ID');
    await wrapper.trigger('click');
    await flushPromises();
    expect(writeText).toHaveBeenCalledWith('user-123');
    expect(wrapper.text()).toContain('Copied');
  });
});

describe('LoginView', () => {
  it('has labelled fields and shows the server error', async () => {
    vi.stubGlobal('fetch', jsonFetch(() => ({ status: 401, body: { error: 'Email or password is incorrect.' } })));
    const { wrapper } = await mountWithRouter(LoginView, '/login');
    expect(wrapper.find('label[for="email"]').exists()).toBe(true);
    expect(wrapper.find('label[for="password"]').exists()).toBe(true);
    expect(wrapper.find('#password').attributes('type')).toBe('password');
    await wrapper.find('#email').setValue('ops@example.com');
    await wrapper.find('#password').setValue('nope');
    await wrapper.find('form').trigger('submit');
    await flushPromises();
    expect(wrapper.find('[role="alert"]').text()).toBe('Email or password is incorrect.');
    expect(wrapper.find('#password').element.value).toBe('');
  });

  it('signs in and goes to the requested page', async () => {
    vi.stubGlobal('fetch', jsonFetch(() => ({ body: { email: 'ops@example.com' } })));
    const { wrapper, router } = await mountWithRouter(LoginView, '/login?next=/users');
    await wrapper.find('#email').setValue('ops@example.com');
    await wrapper.find('#password').setValue('right password');
    await wrapper.find('form').trigger('submit');
    await flushPromises();
    expect(session.email).toBe('ops@example.com');
    expect(router.currentRoute.value.fullPath).toBe('/users');
  });
});

describe('UsersView', () => {
  it('renders users with ids, formatted tokens and the period', async () => {
    vi.stubGlobal('fetch', jsonFetch(() => ({
      body: {
        total: 1, limit: 50, offset: 0,
        rows: [{
          id: 'u-1', email: 'ana@acme.co', full_name: 'Ana', plan: 'prompts_200',
          organization: { id: 'o1', name: 'Acme' }, last_login: null, tokens_month: 12345, tokens_all_time: 9876543,
        }],
      },
    })));
    const { wrapper } = await mountWithRouter(UsersView, '/users');
    const text = wrapper.text();
    expect(text).toContain('This month (UTC)');
    expect(wrapper.find('caption').exists()).toBe(true);
    expect(wrapper.findAll('th[scope="col"]').length).toBe(8);
    const cells = wrapper.findAll('tbody td').map((td) => td.text());
    expect(cells[0]).toContain('u-1');
    expect(cells).toContain('ana@acme.co');
    expect(cells).toContain('200 prompts');
    expect(cells).toContain('Acme');
    expect(cells).toContain('Never');
    expect(cells).toContain('12,345');
    expect(cells).toContain('9,876,543');
  });

  it('shows an empty state and an error state with retry', async () => {
    let fail = true;
    vi.stubGlobal('fetch', jsonFetch(() => (fail
      ? { status: 502, body: { error: 'The backend could not be reached.' } }
      : { body: { total: 0, rows: [] } })));
    const { wrapper } = await mountWithRouter(UsersView, '/users');
    expect(wrapper.find('[role="alert"]').text()).toContain('The backend could not be reached.');
    fail = false;
    await wrapper.find('[role="alert"] button').trigger('click');
    await flushPromises();
    expect(wrapper.text()).toContain('No users yet.');
  });
});

describe('AccountsView', () => {
  it('shows seats used / limit and expands to each seat', async () => {
    vi.stubGlobal('fetch', jsonFetch(() => ({
      body: {
        total: 2, limit: 50, offset: 0,
        rows: [
          {
            id: 'org-1', kind: 'organization', name: 'Acme', plan: 'prompts_200', seat_limit: 5, seats_used: 2,
            tokens_month: 1500, tokens_all_time: 20000,
            members: [
              { user_id: 'u1', email: 'owner@acme.co', role: 'owner', tokens_month: 1000, tokens_all_time: 15000 },
              { user_id: 'u2', email: 'm@acme.co', role: 'member', tokens_month: 500, tokens_all_time: 5000 },
            ],
          },
          { id: 'acc-2', kind: 'individual', name: 'solo@x.co', plan: 'prompts_100', seat_limit: 1, seats_used: 1, members: [] },
        ],
      },
    })));
    const { wrapper } = await mountWithRouter(AccountsView, '/accounts');
    const text = wrapper.text();
    expect(text).toContain('2 / 5');
    expect(text).toContain('1 / 1');
    expect(text).toContain('Single seat');

    const toggle = wrapper.find('button[aria-controls="seats-org-1"]');
    expect(toggle.attributes('aria-expanded')).toBe('false');
    expect(wrapper.find('#seats-org-1').text()).not.toContain('owner@acme.co');
    await toggle.trigger('click');
    expect(toggle.attributes('aria-expanded')).toBe('true');
    const seats = wrapper.find('#seats-org-1');
    expect(seats.text()).toContain('owner@acme.co');
    expect(seats.text()).toContain('u2');
    expect(seats.text()).toContain('1,000');
    expect(seats.text()).toContain('15,000');
    expect(seats.text()).toContain('3 open');
  });
});
