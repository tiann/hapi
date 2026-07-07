import { describe, expect, it } from 'bun:test'
import { createCallbackData, parseCallbackData, findSessionById } from './renderer'
import type { Session } from '../sync/syncEngine'

function session(id: string, overrides: Partial<Session> = {}): Session {
    return {
        id,
        namespace: 'default',
        seq: 0,
        createdAt: 0,
        updatedAt: 0,
        active: true,
        activeAt: 0,
        metadata: null,
        metadataVersion: 0,
        agentState: null,
        agentStateVersion: 0,
        thinking: false,
        thinkingAt: 0,
        model: null,
        modelReasoningEffort: null,
        effort: null,
        serviceTier: null,
        ...overrides
    }
}

describe('createCallbackData / parseCallbackData', () => {
    it('encodes action + full session id + full request id', () => {
        const data = createCallbackData('ap', 'abcdef0123456789', 'req98765432')
        expect(data).toBe('ap:abcdef0123456789:req98765432')
    })

    it('round-trips via parseCallbackData (full IDs, no truncation)', () => {
        const data = createCallbackData('dn', 'sessionidabc', 'requestidxyz')
        expect(parseCallbackData(data)).toEqual({
            action: 'dn',
            sessionId: 'sessionidabc',
            requestId: 'requestidxyz'
        })
    })

    it('omits the request id segment when not provided', () => {
        const data = createCallbackData('ap', 'sessid12xyz')
        expect(data).toBe('ap:sessid12xyz')
        expect(parseCallbackData(data)).toEqual({
            action: 'ap',
            sessionId: 'sessid12xyz',
            requestId: undefined
        })
    })

    it('round-trips realistic UUID-shaped session IDs', () => {
        const sessionId = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890'
        const requestId = 'fedcba98-7654-3210-1111-222233334444'
        const data = createCallbackData('ap', sessionId, requestId)
        expect(parseCallbackData(data)).toEqual({
            action: 'ap',
            sessionId,
            requestId
        })
    })
})

describe('findSessionById', () => {
    it('returns the session whose id matches exactly', () => {
        const a = session('abcd1234-aaaa')
        const b = session('abcd5678-bbbb')
        expect(findSessionById([a, b], 'abcd5678-bbbb')).toBe(b)
    })

    it('returns undefined for a prefix-only match (would have been a bug before)', () => {
        // Two sessions sharing the same 8-char prefix used to collide under
        // the old findSessionByPrefix; with exact-match, only the full id wins.
        const a = session('abcd1234-aaaa')
        const b = session('abcd1234-bbbb')
        expect(findSessionById([a, b], 'abcd1234')).toBeUndefined()
    })

    it('returns undefined when no session matches', () => {
        expect(findSessionById([session('zzzz')], 'aaaa')).toBeUndefined()
    })

    it('returns undefined when the id is empty', () => {
        expect(findSessionById([session('abc')], '')).toBeUndefined()
    })
})

describe('parseCallbackData — request id with colons', () => {
    it('preserves colons inside the request id segment', () => {
        const data = createCallbackData('ap', 'sid12345', 'a:b:c')
        expect(data).toBe('ap:sid12345:a:b:c')
        expect(parseCallbackData(data)).toEqual({
            action: 'ap',
            sessionId: 'sid12345',
            requestId: 'a:b:c'
        })
    })
})
