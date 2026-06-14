import { describe, expect, it } from 'bun:test'
import {
    getPermissionModeLabel,
    getPermissionModeTone,
    isPermissionModeAllowedForFlavor,
    getSteeringModeLabel,
    getSteeringModeOptionsForFlavor,
    isSteeringSupportedForFlavor,
    STEERING_MODES
} from './modes'

describe('claude auto permission mode', () => {
    it('is allowed for claude only', () => {
        expect(isPermissionModeAllowedForFlavor('auto', 'claude')).toBe(true)
        expect(isPermissionModeAllowedForFlavor('auto', 'codex')).toBe(false)
        expect(isPermissionModeAllowedForFlavor('auto', 'gemini')).toBe(false)
        expect(isPermissionModeAllowedForFlavor('auto', 'cursor')).toBe(false)
        expect(isPermissionModeAllowedForFlavor('auto', 'opencode')).toBe(false)
        expect(isPermissionModeAllowedForFlavor('auto', 'kimi')).toBe(false)
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
