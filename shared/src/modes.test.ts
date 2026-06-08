import { describe, expect, test } from 'bun:test'
import {
    PI_PERMISSION_MODES,
    getPermissionModeLabel,
    getPermissionModeOptionsForFlavor,
    getPermissionModeTone,
    getPermissionModesForFlavor,
    isPermissionModeAllowedForFlavor,
} from './modes'

describe('PI_PERMISSION_MODES', () => {
    test('contains only default and yolo', () => {
        expect(PI_PERMISSION_MODES).toEqual(['default', 'yolo'])
    })

    test('has exactly two entries (no accidental additions)', () => {
        expect(PI_PERMISSION_MODES).toHaveLength(2)
    })
})

describe('getPermissionModesForFlavor', () => {
    test("returns Pi modes for flavor 'pi'", () => {
        expect(getPermissionModesForFlavor('pi')).toEqual(['default', 'yolo'])
    })

    test("returns Pi modes when flavor is null/undefined (default fallback is Claude, not Pi)", () => {
        // The default branch returns CLAUDE_PERMISSION_MODES; ensure Pi is opt-in only.
        expect(getPermissionModesForFlavor(null)).not.toEqual(PI_PERMISSION_MODES)
        expect(getPermissionModesForFlavor(undefined)).not.toEqual(PI_PERMISSION_MODES)
    })

    test("returns Pi modes independent of case (unknown flavors fall back to Claude)", () => {
        expect(getPermissionModesForFlavor('PI')).not.toEqual(PI_PERMISSION_MODES)
        expect(getPermissionModesForFlavor('Pi')).not.toEqual(PI_PERMISSION_MODES)
    })
})

describe('getPermissionModeOptionsForFlavor', () => {
    test("returns both default and yolo for pi with correct labels and tones", () => {
        const options = getPermissionModeOptionsForFlavor('pi')
        expect(options).toHaveLength(2)
        expect(options[0]).toEqual({ mode: 'default', label: 'Default', tone: 'neutral' })
        expect(options[1]).toEqual({ mode: 'yolo', label: 'Yolo', tone: 'danger' })
    })

    test("every option has a label and tone derived from the mode", () => {
        for (const opt of getPermissionModeOptionsForFlavor('pi')) {
            expect(opt.label).toBe(getPermissionModeLabel(opt.mode))
            expect(opt.tone).toBe(getPermissionModeTone(opt.mode))
        }
    })
})

describe('isPermissionModeAllowedForFlavor', () => {
    test("yolo is allowed for pi", () => {
        expect(isPermissionModeAllowedForFlavor('yolo', 'pi')).toBe(true)
    })

    test("default is allowed for pi", () => {
        expect(isPermissionModeAllowedForFlavor('default', 'pi')).toBe(true)
    })

    test("plan is NOT allowed for pi (plan not in PI_PERMISSION_MODES)", () => {
        expect(isPermissionModeAllowedForFlavor('plan', 'pi')).toBe(false)
    })

    test("acceptEdits is NOT allowed for pi (Claude-only)", () => {
        expect(isPermissionModeAllowedForFlavor('acceptEdits', 'pi')).toBe(false)
    })

    test("bypassPermissions is NOT allowed for pi (Claude-only)", () => {
        expect(isPermissionModeAllowedForFlavor('bypassPermissions', 'pi')).toBe(false)
    })

    test("read-only is NOT allowed for pi (Codex/Gemini/Kimi-only)", () => {
        expect(isPermissionModeAllowedForFlavor('read-only', 'pi')).toBe(false)
    })

    test("safe-yolo is NOT allowed for pi (Codex/Gemini/Kimi-only)", () => {
        expect(isPermissionModeAllowedForFlavor('safe-yolo', 'pi')).toBe(false)
    })

    test("ask is NOT allowed for pi (Cursor-only)", () => {
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
