import { beforeEach, describe, expect, it } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { nextTick } from 'vue'
import { useAuthStore } from '@/stores/auth'
import { resetHints, useHintsStore } from '@/stores/hints'
import { hintsKey, loadHintState } from '@/lib/help/hints'

function signIn({ id = 7, role = '', onboarding = false } = {}) {
  const auth = useAuthStore()
  auth.user = { id }
  auth.session = {
    user: { id },
    org: role ? { name: 'Acme', role } : null,
    onboarding: { needs_onboarding: onboarding },
  }
  return auth
}

beforeEach(() => {
  localStorage.clear()
  setActivePinia(createPinia())
})

describe('hints store', () => {
  it('shows one registered hint at a time, in order, and remembers the ones seen', async () => {
    signIn()
    const hints = useHintsStore()
    hints.register('board.add-widget')
    hints.register('board.ask-ai')
    hints.register('shell.project')
    expect(hints.active).toBe('board.ask-ai')

    hints.dismiss('board.ask-ai')
    expect(hints.active).toBe('shell.project')
    hints.dismiss('shell.project')
    expect(hints.active).toBe('board.add-widget')
    expect(loadHintState('7').seen).toEqual(['board.ask-ai', 'shell.project'])

    hints.unregister('board.add-widget')
    expect(hints.active).toBeNull()
    hints.register('board.ask-ai')
    expect(hints.active).toBeNull()
  })

  it('keeps the hint on screen when an earlier one registers later', async () => {
    signIn()
    const hints = useHintsStore()
    hints.register('agent.chips')
    await nextTick()
    expect(hints.active).toBe('agent.chips')
    hints.register('board.ask-ai')
    await nextTick()
    expect(hints.active).toBe('agent.chips')
  })

  it('shows nothing signed out, during onboarding or to an organization viewer', () => {
    const hints = useHintsStore()
    hints.register('board.ask-ai')
    expect(hints.active).toBeNull()
    expect(hints.blockedBy).toBe('signed-out')

    const auth = signIn({ onboarding: true })
    expect(hints.blockedBy).toBe('onboarding')
    expect(hints.active).toBeNull()

    auth.session = { ...auth.session, onboarding: { needs_onboarding: false }, org: { name: 'Acme', role: 'viewer' } }
    expect(hints.blockedBy).toBe('viewer')
    expect(hints.active).toBeNull()

    auth.session = { ...auth.session, org: { name: 'Acme', role: 'member' } }
    expect(hints.active).toBe('board.ask-ai')
  })

  it('holds every hint while a page suspends them', () => {
    signIn()
    const hints = useHintsStore()
    hints.register('board.ask-ai')
    hints.suspend('board', true)
    expect(hints.active).toBeNull()
    hints.suspend('board', false)
    expect(hints.active).toBe('board.ask-ai')
  })

  it('Skip tips turns every hint off for this user, and resetHints brings them back', () => {
    signIn()
    const hints = useHintsStore()
    hints.register('board.ask-ai')
    hints.dismiss('board.ask-ai')
    hints.register('agent.chips')
    hints.skipAll()
    expect(hints.active).toBeNull()
    expect(loadHintState('7').skipped).toBe(true)

    expect(resetHints()).toBe(true)
    expect(hints.skipped).toBe(false)
    expect(hints.seen).toEqual([])
    expect(localStorage.getItem(hintsKey('7'))).toBeNull()
    hints.register('board.ask-ai')
    expect(hints.active).toBe('board.ask-ai')
  })

  it('loads each user’s own state when the user changes', async () => {
    localStorage.setItem(hintsKey('7'), JSON.stringify({ seen: ['board.ask-ai'], skipped: false }))
    localStorage.setItem(hintsKey('8'), JSON.stringify({ seen: [], skipped: true }))
    const auth = signIn({ id: 7 })
    const hints = useHintsStore()
    expect(hints.seen).toEqual(['board.ask-ai'])
    auth.user = { id: 8 }
    await nextTick()
    expect(hints.skipped).toBe(true)
    expect(hints.seen).toEqual([])
  })

  it('ignores unknown keys', () => {
    signIn()
    const hints = useHintsStore()
    hints.register('nope')
    hints.dismiss('nope')
    expect(hints.waiting).toEqual([])
    expect(hints.seen).toEqual([])
  })
})

describe('resetHints', () => {
  it('does nothing before Pinia is installed', () => {
    setActivePinia(undefined)
    expect(resetHints()).toBe(false)
  })
})
