import { describe, expect, it, test } from 'bun:test'
import {
    AGENT_FLAVORS,
    AgentFlavorSchema,
    CREATABLE_AGENT_FLAVORS,
    getPermissionModeLabel,
    getPermissionModeTone,
    hasActiveSteeringTurn,
    isSteeringSupportedForFlavor,
    isSteeringSupportedForSession,
    STEERING_SUPPORTED_FLAVORS,
} from './modes'

describe('Gemini CLI sunset (read-only, not creatable)', () => {
    test('gemini stays a valid flavor so existing stored sessions still validate/load', () => {
        expect(AGENT_FLAVORS).toContain('gemini')
        expect(AgentFlavorSchema.safeParse('gemini').success).toBe(true)
    })

    test('gemini is excluded from creatable flavors (not offered for new sessions)', () => {
        expect(CREATABLE_AGENT_FLAVORS).not.toContain('gemini')
    })

    test('all other flavors remain creatable', () => {
        for (const flavor of AGENT_FLAVORS) {
            if (flavor === 'gemini') continue
            expect(CREATABLE_AGENT_FLAVORS).toContain(flavor)
        }
    })
})

describe('getPermissionModeLabel', () => {
    test("yolo label is 'Yolo'", () => {
        expect(getPermissionModeLabel('yolo')).toBe('Yolo')
    })

    test("default label is 'Default'", () => {
        expect(getPermissionModeLabel('default')).toBe('Default')
    })
})

describe('getPermissionModeTone', () => {
    test("yolo tone is danger", () => {
        expect(getPermissionModeTone('yolo')).toBe('danger')
    })

    test("default tone is neutral", () => {
        expect(getPermissionModeTone('default')).toBe('neutral')
    })
})

describe('isSteeringSupportedForFlavor', () => {
    it('supports agy, claude, codex, cursor, opencode and pi', () => {
        expect(isSteeringSupportedForFlavor('agy')).toBe(true)
        expect(isSteeringSupportedForFlavor('codex')).toBe(true)
        expect(isSteeringSupportedForFlavor('cursor')).toBe(true)
        expect(isSteeringSupportedForFlavor('opencode')).toBe(true)
        expect(isSteeringSupportedForFlavor('pi')).toBe(true)
        expect(isSteeringSupportedForFlavor('claude')).toBe(true)
        expect(isSteeringSupportedForFlavor('gemini')).toBe(false)
        expect(isSteeringSupportedForFlavor(undefined)).toBe(false)
        expect(isSteeringSupportedForFlavor(null)).toBe(false)
    })
})

describe('isSteeringSupportedForSession', () => {
    it('supports agy, claude, codex, opencode and pi sessions', () => {
        expect(isSteeringSupportedForSession({ flavor: 'agy', agyProtocol: 'acp' })).toBe(true)
        expect(isSteeringSupportedForSession({ flavor: 'codex' })).toBe(true)
        expect(isSteeringSupportedForSession({ flavor: 'opencode' })).toBe(true)
        expect(isSteeringSupportedForSession({ flavor: 'pi' })).toBe(true)
        expect(isSteeringSupportedForSession({ flavor: 'claude' })).toBe(true)
    })

    it('supports Cursor ACP sessions', () => {
        expect(isSteeringSupportedForSession({
            flavor: 'cursor',
            cursorSessionProtocol: 'acp',
            cursorSessionId: 'sess-1',
        })).toBe(true)
        expect(isSteeringSupportedForSession({ flavor: 'cursor' })).toBe(true)
    })

    it('steers agy sessions only while they run on agy acp', () => {
        expect(isSteeringSupportedForSession({ flavor: 'agy', agyProtocol: 'acp' })).toBe(true)
        expect(isSteeringSupportedForSession({ flavor: 'agy' })).toBe(false)
        expect(isSteeringSupportedForSession({ flavor: 'agy', agyProtocol: null })).toBe(false)
    })

    it('rejects legacy Cursor stream-json sessions', () => {
        expect(isSteeringSupportedForSession({
            flavor: 'cursor',
            cursorSessionProtocol: 'stream-json',
            cursorSessionId: 'legacy-1',
        })).toBe(false)
        expect(isSteeringSupportedForSession({
            flavor: 'cursor',
            cursorSessionId: 'legacy-without-protocol',
        })).toBe(false)
    })

    it('rejects non-steerable flavors', () => {
        expect(isSteeringSupportedForSession({ flavor: 'gemini' })).toBe(false)
        expect(isSteeringSupportedForSession(null)).toBe(false)
    })
})

describe('hasActiveSteeringTurn', () => {
    it.each(['claude', 'codex', 'cursor', 'opencode'])('uses steeringActive rather than thinking for %s', (flavor) => {
        expect(hasActiveSteeringTurn({ metadata: { flavor }, thinking: false,
            agentState: { steeringActive: true } })).toBe(true)
        expect(hasActiveSteeringTurn({ metadata: { flavor }, thinking: true,
            agentState: { steeringActive: false } })).toBe(false)
        expect(hasActiveSteeringTurn({ metadata: { flavor }, thinking: true })).toBe(false)
    })

    it('uses steeringActive for agy acp sessions and ignores stream-json ones', () => {
        const acp = { flavor: 'agy', agyProtocol: 'acp' as const }
        expect(hasActiveSteeringTurn({ metadata: acp, thinking: false, agentState: { steeringActive: true } })).toBe(true)
        expect(hasActiveSteeringTurn({ metadata: acp, thinking: true, agentState: { steeringActive: false } })).toBe(false)
        expect(hasActiveSteeringTurn({ metadata: { flavor: 'agy' }, thinking: true, agentState: { steeringActive: true } })).toBe(false)
    })

    it('uses the Pi runtime thinking signal', () => {
        expect(hasActiveSteeringTurn({ metadata: { flavor: 'pi' }, thinking: true,
            agentState: { steeringActive: false } })).toBe(true)
        expect(hasActiveSteeringTurn({ metadata: { flavor: 'pi' }, thinking: false,
            agentState: { steeringActive: true } })).toBe(false)
    })

    it.each([
        null, undefined, { flavor: 'gemini' }, { flavor: 'unknown' },
        { flavor: '__proto__' }, { flavor: 'constructor' },
        { flavor: 'cursor', cursorSessionProtocol: 'stream-json' as const },
        { flavor: 'cursor', cursorSessionId: 'legacy' },
    ])('rejects unsupported metadata even when every turn signal is true: %j', (metadata) => {
        expect(hasActiveSteeringTurn({ metadata, thinking: true,
            agentState: { steeringActive: true } })).toBe(false)
        expect(isSteeringSupportedForSession(metadata)).toBe(false)
        if (metadata?.flavor !== 'cursor') {
            expect(isSteeringSupportedForFlavor(metadata?.flavor)).toBe(false)
        }
    })
})

describe('steering support table', () => {
    // The pre-table branching, kept as the reference the table must match.
    type Metadata = { flavor?: string | null; cursorSessionId?: string | null; cursorSessionProtocol?: 'acp' | 'stream-json' | null; agyProtocol?: 'acp' | null }
    function referenceSupportsSession(metadata?: Metadata | null): boolean {
        if (metadata?.flavor === 'claude' || metadata?.flavor === 'codex'
            || metadata?.flavor === 'opencode' || metadata?.flavor === 'pi') return true
        if (metadata?.flavor === 'agy') return metadata.agyProtocol === 'acp'
        if (metadata?.flavor !== 'cursor') return false
        if (metadata.cursorSessionProtocol === 'stream-json') return false
        if (!metadata.cursorSessionProtocol && metadata.cursorSessionId) return false
        return true
    }

    const flavors = [
        'claude', 'codex', 'cursor', 'opencode', 'pi', 'gemini', 'agy', 'unknown', '',
        '__proto__', 'constructor', 'toString', null, undefined,
    ]
    const cursorShapes: Array<Pick<Metadata, 'cursorSessionId' | 'cursorSessionProtocol' | 'agyProtocol'>> = [
        { agyProtocol: 'acp' }, { agyProtocol: null }, { cursorSessionProtocol: 'acp', agyProtocol: 'acp' },
        {}, { cursorSessionId: 'id' }, { cursorSessionId: null }, { cursorSessionProtocol: 'acp' },
        { cursorSessionProtocol: 'stream-json' }, { cursorSessionProtocol: null },
        { cursorSessionId: 'id', cursorSessionProtocol: 'acp' },
        { cursorSessionId: 'id', cursorSessionProtocol: 'stream-json' },
        { cursorSessionId: 'id', cursorSessionProtocol: null },
    ]

    it('gives the same session answer as the previous branching for every flavor and Cursor shape', () => {
        for (const flavor of flavors) {
            for (const shape of cursorShapes) {
                const metadata = { flavor, ...shape }
                expect(isSteeringSupportedForSession(metadata), JSON.stringify(metadata))
                    .toBe(referenceSupportsSession(metadata))
            }
        }
        expect(isSteeringSupportedForSession(null)).toBe(referenceSupportsSession(null))
        expect(isSteeringSupportedForSession(undefined)).toBe(referenceSupportsSession(undefined))
    })

    it('answers the flavor-only gate from the same flavor list', () => {
        for (const flavor of flavors) {
            expect(isSteeringSupportedForFlavor(flavor), String(flavor))
                .toBe((STEERING_SUPPORTED_FLAVORS as readonly string[]).includes(flavor ?? ''))
        }
    })
})
