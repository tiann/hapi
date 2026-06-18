import { describe, expect, it, test } from 'bun:test'
import {
    getPermissionModeLabel,
    getPermissionModeOptionsForFlavor,
    getPermissionModeTone,
    getPermissionModesForFlavor,
    isPermissionModeAllowedForFlavor,
    getSteeringModeLabel,
    getSteeringModeOptionsForFlavor,
    isSteeringSupportedForFlavor,
    STEERING_MODES
} from './modes'

describe('getPermissionModesForFlavor', () => {
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

describe('steering mode', () => {
    it('is supported for codex only (Claude steering is TUI-only, not in the SDK)', () => {
        expect(isSteeringSupportedForFlavor('codex')).toBe(true)
        expect(isSteeringSupportedForFlavor('claude')).toBe(false)
        expect(isSteeringSupportedForFlavor('cursor')).toBe(false)
        expect(isSteeringSupportedForFlavor('gemini')).toBe(false)
        expect(isSteeringSupportedForFlavor('opencode')).toBe(false)
        expect(isSteeringSupportedForFlavor('kimi')).toBe(false)
        expect(isSteeringSupportedForFlavor(undefined)).toBe(false)
        expect(isSteeringSupportedForFlavor(null)).toBe(false)
    })

    it('returns queue+steer options for codex and none otherwise', () => {
        expect(getSteeringModeOptionsForFlavor('codex').map((o) => o.mode)).toEqual(['queue', 'steer'])
        expect(getSteeringModeOptionsForFlavor('claude')).toEqual([])
        expect(getSteeringModeOptionsForFlavor('cursor')).toEqual([])
        expect(getSteeringModeOptionsForFlavor(undefined)).toEqual([])
    })

    it('defaults the first option to queue (non-interrupting current behavior) and labels both modes', () => {
        expect(STEERING_MODES[0]).toBe('queue')
        expect(getSteeringModeLabel('queue')).toBeTruthy()
        expect(getSteeringModeLabel('steer')).toBeTruthy()
    })
})
