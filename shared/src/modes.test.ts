import { describe, expect, it, test } from 'bun:test'
import {
    AGENT_FLAVORS,
    AgentFlavorSchema,
    CREATABLE_AGENT_FLAVORS,
    getPermissionModeLabel,
    getPermissionModeOptionsForFlavor,
    getPermissionModeTone,
    getPermissionModesForFlavor,
    isPermissionModeAllowedForFlavor,
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

describe('getPermissionModesForFlavor', () => {
    test("returns the conservative Grok modes", () => {
        expect(getPermissionModesForFlavor('grok')).toEqual([
            'default',
            'auto',
            'plan',
            'bypassPermissions'
        ])
    })

    test("returns [] for flavor 'pi' (RPC mode has no runtime permission switching)", () => {
        expect(getPermissionModesForFlavor('pi')).toEqual([])
    })

    test("returns [] for pi and does not fall back to Claude modes", () => {
        // Ensure Pi is opt-in empty, not silently inheriting Claude defaults.
        expect(getPermissionModesForFlavor('pi')).not.toEqual(getPermissionModesForFlavor('claude'))
        expect(getPermissionModesForFlavor('pi')).not.toEqual(getPermissionModesForFlavor(null))
    })

    test("unknown flavors fall back to Claude modes, not Pi's empty list", () => {
        expect(getPermissionModesForFlavor(null)).not.toEqual([])
        expect(getPermissionModesForFlavor(undefined)).not.toEqual([])
        expect(getPermissionModesForFlavor('PI')).not.toEqual([])
        expect(getPermissionModesForFlavor('Pi')).not.toEqual([])
    })
})

describe('getPermissionModeOptionsForFlavor', () => {
    test("returns [] for pi (no permission options offered)", () => {
        expect(getPermissionModeOptionsForFlavor('pi')).toEqual([])
    })
})

describe('isPermissionModeAllowedForFlavor', () => {
    test("allows only the supported Grok modes", () => {
        expect(isPermissionModeAllowedForFlavor('default', 'grok')).toBe(true)
        expect(isPermissionModeAllowedForFlavor('plan', 'grok')).toBe(true)
        expect(isPermissionModeAllowedForFlavor('bypassPermissions', 'grok')).toBe(true)
        expect(isPermissionModeAllowedForFlavor('acceptEdits', 'grok')).toBe(false)
        expect(isPermissionModeAllowedForFlavor('auto', 'grok')).toBe(true)
        expect(isPermissionModeAllowedForFlavor('yolo', 'grok')).toBe(false)
    })

    test("no mode is allowed for pi", () => {
        expect(isPermissionModeAllowedForFlavor('yolo', 'pi')).toBe(false)
        expect(isPermissionModeAllowedForFlavor('default', 'pi')).toBe(false)
        expect(isPermissionModeAllowedForFlavor('plan', 'pi')).toBe(false)
        expect(isPermissionModeAllowedForFlavor('acceptEdits', 'pi')).toBe(false)
        expect(isPermissionModeAllowedForFlavor('bypassPermissions', 'pi')).toBe(false)
        expect(isPermissionModeAllowedForFlavor('auto', 'pi')).toBe(false)
        expect(isPermissionModeAllowedForFlavor('read-only', 'pi')).toBe(false)
        expect(isPermissionModeAllowedForFlavor('safe-yolo', 'pi')).toBe(false)
        expect(isPermissionModeAllowedForFlavor('ask', 'pi')).toBe(false)
    })

    test("cursor includes autoReview", () => {
        expect(getPermissionModesForFlavor('cursor')).toContain('autoReview')
        expect(getPermissionModeLabel('autoReview')).toBe('Auto-review')
        expect(getPermissionModeTone('autoReview')).toBe('warning')
        expect(isPermissionModeAllowedForFlavor('autoReview', 'cursor')).toBe(true)
        expect(isPermissionModeAllowedForFlavor('autoReview', 'claude')).toBe(false)
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

describe('claude auto permission mode', () => {
    it('is allowed for claude only', () => {
        expect(isPermissionModeAllowedForFlavor('auto', 'claude')).toBe(true)
        expect(isPermissionModeAllowedForFlavor('auto', 'codex')).toBe(false)
        expect(isPermissionModeAllowedForFlavor('auto', 'gemini')).toBe(false)
        expect(isPermissionModeAllowedForFlavor('auto', 'cursor')).toBe(false)
        expect(isPermissionModeAllowedForFlavor('auto', 'opencode')).toBe(false)
        expect(isPermissionModeAllowedForFlavor('auto', 'kimi')).toBe(false)
        expect(isPermissionModeAllowedForFlavor('auto', 'pi')).toBe(false)
    })

    it('has a label and tone', () => {
        expect(getPermissionModeLabel('auto')).toBe('Auto')
        expect(getPermissionModeTone('auto')).toBe('warning')
    })
})
