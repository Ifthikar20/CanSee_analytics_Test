import { afterEach, describe, expect, it, vi } from 'vitest'
import { enableAutoUnmount, flushPromises, mount } from '@vue/test-utils'
import { reactive } from 'vue'

const fakeOrg = reactive({
  members: [],
  invitations: [],
  membersLoading: false,
  usage: { seats: { used: 3, max: 5 }, members: [] },
  loadMembers: vi.fn(async () => {}),
  loadInvitations: vi.fn(async () => {}),
  loadUsage: vi.fn(async () => {}),
})
const fakeAuth = reactive({ isOrgAdmin: true, isOrgOwner: false, org: { name: 'Acme' }, session: null })
vi.mock('@/stores/org', () => ({ useOrgStore: () => fakeOrg }))
vi.mock('@/stores/auth', () => ({ useAuthStore: () => fakeAuth }))
vi.mock('@/composables/useToast', () => ({ useToast: () => ({ success: vi.fn(), error: vi.fn() }) }))

const { default: OrgMembersSection } = await import('../OrgMembersSection.vue')

enableAutoUnmount(afterEach)

const tips = (wrapper) =>
  Object.fromEntries(
    wrapper.findAll('button.cs-helptip').map((b) => [
      b.attributes('aria-label'),
      document.getElementById(b.attributes('aria-describedby'))?.textContent || '',
    ]),
  )

describe('OrgMembersSection help', () => {
  it('explains seats, and the roles beside a labelled role picker', async () => {
    const wrapper = mount(OrgMembersSection, { attachTo: document.body })
    await flushPromises()
    expect(wrapper.find('.om-seats').text()).toBe('3 of 5 seats used')
    expect(tips(wrapper)['About seats']).toBe('Members and pending invites both use a seat. Your plan sets how many you have.')

    await wrapper.findAll('button').find((b) => b.text() === 'Invite people').trigger('click')
    const select = wrapper.find('.om-composer select')
    expect(select.attributes('aria-label')).toBe('Role')
    expect(tips(wrapper)['About roles']).toContain('Viewers can see the work but not change it.')
  })
})
