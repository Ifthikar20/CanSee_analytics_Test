import { beforeEach, describe, expect, it } from 'vitest'
import { loadSeen, loadTokens, rememberToken, saveSeen } from '../feedbackClient'
import { clearUserData } from '@/lib/agent/storage'

beforeEach(() => {
  localStorage.clear()
})

describe('feedback ticket tokens', () => {
  it('keeps each user\'s tokens apart', () => {
    rememberToken(7, 'tok-a')
    rememberToken(7, 'tok-b')
    rememberToken(8, 'tok-c')
    expect(loadTokens(7)).toEqual(['tok-b', 'tok-a'])
    expect(loadTokens(8)).toEqual(['tok-c'])
    expect(loadTokens(9)).toEqual([])
  })

  it('keeps nothing and reads nothing without a user', () => {
    expect(rememberToken(null, 'tok')).toBe(false)
    expect(rememberToken(undefined, 'tok')).toBe(false)
    expect(loadTokens(null)).toEqual([])
    expect(localStorage.length).toBe(0)
  })

  it('never reads the old shared key, which belonged to whoever used the browser before', () => {
    localStorage.setItem('cs-feedback-tokens', JSON.stringify(['someone-elses']))
    localStorage.setItem('cs-feedback-seen', JSON.stringify({ 1: 3 }))
    expect(loadTokens(7)).toEqual([])
    expect(loadSeen(7)).toEqual({})
  })

  it('moves a known token to the front, keeps 50, and ignores junk', () => {
    for (let i = 0; i < 55; i += 1) rememberToken(7, `t${i}`)
    rememberToken(7, 't10')
    const tokens = loadTokens(7)
    expect(tokens).toHaveLength(50)
    expect(tokens[0]).toBe('t10')
    expect(tokens.filter((t) => t === 't10')).toHaveLength(1)
    localStorage.setItem('cs-feedback-tokens-v1:8', JSON.stringify(['ok', 3, null, '']))
    expect(loadTokens(8)).toEqual(['ok'])
    localStorage.setItem('cs-feedback-tokens-v1:9', '{not json')
    expect(loadTokens(9)).toEqual([])
  })

  it('keeps the messages seen per user', () => {
    saveSeen(7, { 12: 4 })
    expect(loadSeen(7)).toEqual({ 12: 4 })
    expect(loadSeen(8)).toEqual({})
    expect(saveSeen(null, { 1: 1 })).toBe(false)
  })

  it('is removed on logout with the other per-user keys, old shared keys included', () => {
    rememberToken(7, 'tok-a')
    saveSeen(7, { 12: 4 })
    rememberToken(8, 'tok-c')
    localStorage.setItem('cs-feedback-tokens', JSON.stringify(['old']))
    localStorage.setItem('cs-feedback-seen', '{}')
    expect(clearUserData()).toBe(3)
    expect(loadTokens(7)).toEqual([])
    expect(loadTokens(8)).toEqual([])
    expect(loadSeen(7)).toEqual({})
    expect(localStorage.getItem('cs-feedback-tokens')).toBeNull()
    expect(localStorage.getItem('cs-feedback-seen')).toBeNull()
  })
})
