import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useHelpStore } from '@/stores/help'

beforeEach(() => {
  setActivePinia(createPinia())
})

describe('help store', () => {
  it('opens at a question that exists, starting from an empty search', () => {
    const help = useHelpStore()
    help.setQuery('runs')
    help.open({ faqId: 'plan-free' })
    expect(help.isOpen).toBe(true)
    expect(help.focusId).toBe('plan-free')
    expect(help.query).toBe('')
  })

  it('opens at the top for a question that does not exist, keeping the search', () => {
    const help = useHelpStore()
    help.setQuery('runs')
    help.open({ faqId: 'no-such-question' })
    expect(help.isOpen).toBe(true)
    expect(help.focusId).toBeNull()
    expect(help.query).toBe('runs')
    help.open()
    expect(help.focusId).toBeNull()
  })

  it('toggles, and setOpen follows the value', () => {
    const help = useHelpStore()
    help.toggle()
    expect(help.isOpen).toBe(true)
    help.toggle()
    expect(help.isOpen).toBe(false)
    help.setOpen(true)
    expect(help.isOpen).toBe(true)
    help.setOpen(false)
    expect(help.isOpen).toBe(false)
  })

  it('clears the question once shown, and reads any query as text', () => {
    const help = useHelpStore()
    help.open({ faqId: 'plan-free' })
    help.clearFocus()
    expect(help.focusId).toBeNull()
    help.setQuery(null)
    expect(help.query).toBe('')
    help.setQuery(42)
    expect(help.query).toBe('42')
  })

  it('keeps the feedback opener until its own unregister runs', () => {
    const help = useHelpStore()
    const first = vi.fn()
    const second = vi.fn()
    const dropFirst = help.setFeedbackOpener(first)
    const dropSecond = help.setFeedbackOpener(second)
    // A stale unregister never removes the newer opener.
    dropFirst()
    expect(help.feedbackOpener).toBe(second)
    dropSecond()
    expect(help.feedbackOpener).toBeNull()
    help.setFeedbackOpener('not a function')
    expect(help.feedbackOpener).toBeNull()
  })
})
