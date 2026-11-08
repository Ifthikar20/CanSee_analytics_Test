import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

const orgsApi = vi.hoisted(() => ({
  listMembers: vi.fn(),
  listInvitations: vi.fn(),
  listDomains: vi.fn(),
  getUsage: vi.fn(),
}))
vi.mock('@/api/orgs', () => ({ default: orgsApi }))

const { useAuthStore } = await import('@/stores/auth')
const { useAppStore } = await import('@/stores/app')
const { useOrgStore } = await import('@/stores/org')

const ok = (data) => Promise.resolve({ success: true, data })

beforeEach(() => {
  setActivePinia(createPinia())
  localStorage.clear()
  Object.values(orgsApi).forEach((fn) => fn.mockReset())
})

describe('signing out', () => {
  it("forgets the previous user's projects and project allowance", () => {
    const app = useAppStore()
    const auth = useAuthStore()
    auth.user = { id: 1 }
    app.setWebsites([{ id: 'a1', name: 'Alpha' }, { id: 'a2', name: 'Beta' }])
    app.setProjectLimit(3)
    expect(app.activeWebsite?.id).toBe('a1')

    auth.clearAuth()

    expect(app.websites).toEqual([])
    expect(app.activeWebsite).toBeNull()
    expect(app.projectLimit).toBe(-1)
  })

  it("lets the next user's project list become active instead of the old one", () => {
    const app = useAppStore()
    const auth = useAuthStore()
    app.setWebsites([{ id: 'a1' }])
    auth.clearAuth()
    app.setWebsites([{ id: 'b1' }, { id: 'b2' }])
    expect(app.activeWebsite?.id).toBe('b1')
  })

  it("drops the organization's members, invitations, domains and usage", async () => {
    const auth = useAuthStore()
    auth.session = { org: { id: 9, role: 'owner' } }
    orgsApi.listMembers.mockReturnValue(ok([{ id: 1, email: 'a@x.test' }]))
    orgsApi.listInvitations.mockReturnValue(ok([{ id: 2, email: 'b@x.test' }]))
    orgsApi.listDomains.mockReturnValue(ok([{ id: 3, domain: 'x.test' }]))
    orgsApi.getUsage.mockReturnValue(ok({ seats: 2 }))
    const org = useOrgStore()
    await Promise.all([org.loadMembers(), org.loadInvitations(), org.loadDomains(), org.loadUsage()])
    expect(org.members).toHaveLength(1)
    expect(org.invitations).toHaveLength(1)

    auth.clearAuth()

    expect(org.members).toEqual([])
    expect(org.invitations).toEqual([])
    expect(org.domains).toEqual([])
    expect(org.usage).toBeNull()
  })
})

describe('pending invitations', () => {
  it('are not requested for a member who is not an admin', async () => {
    useAuthStore().session = { org: { id: 9, role: 'member' } }
    const org = useOrgStore()
    await org.loadInvitations()
    expect(orgsApi.listInvitations).not.toHaveBeenCalled()
    expect(org.invitations).toEqual([])
  })

  it('are loaded for an admin', async () => {
    useAuthStore().session = { org: { id: 9, role: 'admin' } }
    orgsApi.listInvitations.mockReturnValue(ok([{ id: 2 }]))
    const org = useOrgStore()
    await org.loadInvitations()
    expect(orgsApi.listInvitations).toHaveBeenCalledTimes(1)
    expect(org.invitations).toEqual([{ id: 2 }])
  })
})
