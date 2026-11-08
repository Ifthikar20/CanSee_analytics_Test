import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { enableAutoUnmount, flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import ChatEmptyState from '../ChatEmptyState.vue'
import { useAuthStore } from '@/stores/auth'

enableAutoUnmount(afterEach)

const AGENTS = [
  { key: 'gap_analyst', name: 'Gap Analyst', unavailable: '' },
  { key: 'landing_page', name: 'Landing Page Agent', unavailable: 'Needs more AI allowance.' },
]

function signIn() {
  const auth = useAuthStore()
  auth.user = { id: 9 }
  auth.session = { user: { id: 9 }, org: null, onboarding: { needs_onboarding: false } }
}

const hint = () => document.body.querySelector('.cs-hint[data-hint="agent.chips"]')

beforeEach(() => {
  localStorage.clear()
  setActivePinia(createPinia())
})

describe('ChatEmptyState', () => {
  it('points the agents out on the first new chat', async () => {
    signIn()
    const w = mount(ChatEmptyState, { props: { projectName: 'Acme', agents: AGENTS }, attachTo: document.body })
    await flushPromises()
    expect(w.findAll('button.ag-chip')).toHaveLength(2)
    expect(hint().querySelector('.cs-hint-body').textContent).toContain('saves its draft for you to review and export')
  })

  it('does not point at agents none of which can start', async () => {
    signIn()
    mount(ChatEmptyState, {
      props: { agents: AGENTS.map((a) => ({ ...a, unavailable: 'Needs more AI allowance.' })) },
      attachTo: document.body,
    })
    await flushPromises()
    expect(hint()).toBeNull()
  })
})
