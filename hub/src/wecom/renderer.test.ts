import { describe, expect, it } from 'bun:test'
import { createCallbackData, parseCallbackData, findSessionByPrefix } from './renderer'
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
        ...overrides
    }
}

describe('createCallbackData / parseCallbackData', () => {
    it('encodes action + session prefix + extra using 8-char session prefix', () => {
        const data = createCallbackData('ap', 'abcdef0123456789', 'req98765432')
        expect(data).toBe('ap:abcdef01:req98765432')
    })

    it('round-trips via parseCallbackData', () => {
        const data = createCallbackData('dn', 'sessionidabc', 'requestidxyz')
        expect(parseCallbackData(data)).toEqual({
            action: 'dn',
            sessionPrefix: 'sessioni',
            extra: 'requestidxyz'
        })
    })

    it('omits extra segment when not provided', () => {
        const data = createCallbackData('ap', 'sessid12xyz')
        expect(data).toBe('ap:sessid12')
        expect(parseCallbackData(data)).toEqual({
            action: 'ap',
            sessionPrefix: 'sessid12',
            extra: undefined
        })
    })
})

describe('findSessionByPrefix', () => {
    it('returns the first session whose id starts with the prefix', () => {
        const a = session('abcd1234-aaaa')
        const b = session('abcd5678-bbbb')
        expect(findSessionByPrefix([a, b], 'abcd5678')).toBe(b)
    })

    it('returns undefined when no session matches', () => {
        expect(findSessionByPrefix([session('zzzz')], 'aaaa')).toBeUndefined()
    })
})

describe('parseCallbackData — extra with colons', () => {
    it('preserves colons inside the extra segment', () => {
        const data = createCallbackData('ap', 'sid12345', 'a:b:c')
        expect(data).toBe('ap:sid12345:a:b:c')
        expect(parseCallbackData(data)).toEqual({
            action: 'ap',
            sessionPrefix: 'sid12345',
            extra: 'a:b:c'
        })
    })
})

describe('findSessionByPrefix — empty prefix guard', () => {
    it('returns undefined when the prefix is empty', () => {
        expect(findSessionByPrefix([session('abc')], '')).toBeUndefined()
    })
})
