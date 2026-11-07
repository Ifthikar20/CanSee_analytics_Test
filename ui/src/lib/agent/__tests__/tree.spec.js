import { describe, expect, it } from 'vitest'
import {
    addChild,
    mergeChildren,
    newestLeaf,
    parentKeyOf,
    pathTo,
    removeChild,
    replaceChild,
    rootKey,
    siblingInfo,
    subtreeIds,
} from '../tree'

// u1 -> a1            (first answer)
// u1 -> a2 -> u2 -> a3 (regenerated answer, then a follow-up)
// u1' (edited first message) -> a4
function msg(id, parent, role, extra = {}) {
    return { id, chat_id: 'c1', parent_id: parent, role, status: 'complete', parts: [], ...extra }
}

function fixture() {
    const messages = {
        u1: msg('u1', null, 'user', { sibling_ids: ['u1', 'u1e'] }),
        u1e: msg('u1e', null, 'user', { sibling_ids: ['u1', 'u1e'] }),
        a1: msg('a1', 'u1', 'assistant', { sibling_ids: ['a1', 'a2'] }),
        a2: msg('a2', 'u1', 'assistant', { sibling_ids: ['a1', 'a2'] }),
        u2: msg('u2', 'a2', 'user', { sibling_ids: ['u2'] }),
        a3: msg('a3', 'u2', 'assistant', { sibling_ids: ['a3'] }),
        a4: msg('a4', 'u1e', 'assistant', { sibling_ids: ['a4'] }),
    }
    const childrenOf = {}
    for (const m of Object.values(messages)) mergeChildren(childrenOf, parentKeyOf(m), m.sibling_ids)
    return { messages, childrenOf }
}

describe('tree', () => {
    it('keys first messages by chat and the rest by parent', () => {
        expect(parentKeyOf(msg('x', null, 'user'))).toBe(rootKey('c1'))
        expect(parentKeyOf(msg('y', 'x', 'assistant'))).toBe('x')
        expect(parentKeyOf(null)).toBeNull()
    })

    it('builds children lists in server order', () => {
        const { childrenOf } = fixture()
        expect(childrenOf).toEqual({
            'root:c1': ['u1', 'u1e'],
            u1: ['a1', 'a2'],
            a2: ['u2'],
            u2: ['a3'],
            u1e: ['a4'],
        })
    })

    it('walks the visible path from the root to a leaf', () => {
        const { messages } = fixture()
        expect(pathTo(messages, 'a3').map((m) => m.id)).toEqual(['u1', 'a2', 'u2', 'a3'])
        expect(pathTo(messages, 'a4').map((m) => m.id)).toEqual(['u1e', 'a4'])
        expect(pathTo(messages, null)).toEqual([])
        expect(pathTo(messages, 'missing')).toEqual([])
    })

    it('stops at a missing parent and at a cycle', () => {
        const messages = { b: msg('b', 'gone', 'assistant'), x: msg('x', 'y', 'user'), y: msg('y', 'x', 'assistant') }
        expect(pathTo(messages, 'b').map((m) => m.id)).toEqual(['b'])
        expect(pathTo(messages, 'x').map((m) => m.id)).toEqual(['y', 'x'])
    })

    it('reports sibling positions for the branch control', () => {
        const { messages, childrenOf } = fixture()
        expect(siblingInfo(childrenOf, messages, 'a1')).toEqual({
            ids: ['a1', 'a2'],
            index: 0,
            position: 1,
            count: 2,
            prevId: null,
            nextId: 'a2',
            hasPrev: false,
            hasNext: true,
        })
        expect(siblingInfo(childrenOf, messages, 'a2')).toMatchObject({ index: 1, position: 2, count: 2, prevId: 'a1', nextId: null })
        expect(siblingInfo(childrenOf, messages, 'u1e')).toMatchObject({ position: 2, count: 2, prevId: 'u1' })
        expect(siblingInfo(childrenOf, messages, 'a3')).toMatchObject({ count: 1, hasPrev: false, hasNext: false })
    })

    it('falls back to sibling_ids, then to the message alone', () => {
        const messages = { z: msg('z', 'p', 'assistant', { sibling_ids: ['w', 'z'] }), solo: msg('solo', 'p', 'assistant') }
        expect(siblingInfo({}, messages, 'z')).toMatchObject({ ids: ['w', 'z'], position: 2, count: 2 })
        expect(siblingInfo({}, messages, 'solo')).toMatchObject({ ids: ['solo'], count: 1 })
        expect(siblingInfo({}, messages, 'unknown')).toMatchObject({ ids: ['unknown'], count: 1, position: 1 })
    })

    it('descends to the newest leaf like the server does', () => {
        const { messages, childrenOf } = fixture()
        expect(newestLeaf(childrenOf, messages, 'u1')).toBe('a3')
        expect(newestLeaf(childrenOf, messages, 'a1')).toBe('a1')
        expect(newestLeaf(childrenOf, messages, 'u1e')).toBe('a4')
    })

    it('skips children it has no message for when descending', () => {
        const { messages, childrenOf } = fixture()
        addChild(childrenOf, 'a3', 'not-loaded')
        expect(newestLeaf(childrenOf, messages, 'u2')).toBe('a3')
    })

    it('merges server sibling lists and keeps local-only ids after them', () => {
        const childrenOf = { p: ['a', 'tmp-1'] }
        mergeChildren(childrenOf, 'p', ['a', 'b'])
        expect(childrenOf.p).toEqual(['a', 'b', 'tmp-1'])
        const before = childrenOf.p
        mergeChildren(childrenOf, 'p', ['a', 'b'])
        expect(childrenOf.p).toBe(before)
    })

    it('adds, replaces and removes children', () => {
        const childrenOf = {}
        addChild(childrenOf, 'p', 'tmp-1')
        addChild(childrenOf, 'p', 'tmp-1')
        expect(childrenOf.p).toEqual(['tmp-1'])
        replaceChild(childrenOf, 'p', 'tmp-1', 'real-1')
        expect(childrenOf.p).toEqual(['real-1'])
        addChild(childrenOf, 'p', 'real-2')
        replaceChild(childrenOf, 'p', 'real-2', 'real-1')
        expect(childrenOf.p).toEqual(['real-1'])
        removeChild(childrenOf, 'p', 'real-1')
        expect(childrenOf).toEqual({})
    })

    it('lists a subtree', () => {
        const { childrenOf } = fixture()
        expect(subtreeIds(childrenOf, 'u1').sort()).toEqual(['a1', 'a2', 'a3', 'u1', 'u2'])
    })
})
