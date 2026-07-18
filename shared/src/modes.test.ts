import { describe, expect, test } from 'bun:test'
import {
    AGY_PERMISSION_MODES,
    CODEX_SERVICE_TIERS,
    GROK_PERMISSION_MODES,
    HERMES_MOA_PERMISSION_MODES,
    getPermissionModeOptionsForFlavor,
    getPermissionModesForFlavor,
    getCodexServiceTierLabel,
    getCodexServiceTierOptions,
    isPermissionModeAllowedForFlavor,
} from './modes'
import { CodexServiceTierSchema, SessionSchema } from './schemas'

describe('Codex service tiers', () => {
    test('exposes the selectable speed tiers and labels', () => {
        expect(CODEX_SERVICE_TIERS).toEqual(['standard', 'fast'])
        expect(getCodexServiceTierLabel('standard')).toBe('Standard')
        expect(getCodexServiceTierLabel('fast')).toBe('Fast')
        expect(getCodexServiceTierOptions()).toEqual([
            { tier: 'standard', label: 'Standard' },
            { tier: 'fast', label: 'Fast' },
        ])
    })

    test('validates service tier payload values without treating default as a wire value', () => {
        expect(CodexServiceTierSchema.safeParse('standard').success).toBe(true)
        expect(CodexServiceTierSchema.safeParse('fast').success).toBe(true)
        expect(CodexServiceTierSchema.safeParse('default').success).toBe(false)
    })

    test('keeps service tier optional and nullable on session snapshots', () => {
        const baseSession = {
            id: 'session-1',
            namespace: 'default',
            seq: 1,
            createdAt: 1,
            updatedAt: 1,
            active: true,
            activeAt: 1,
            metadata: null,
            metadataVersion: 1,
            agentState: null,
            agentStateVersion: 1,
            thinking: false,
            thinkingAt: 0,
        }

        expect(SessionSchema.parse(baseSession).serviceTier).toBeUndefined()
        expect(SessionSchema.parse({ ...baseSession, serviceTier: null }).serviceTier).toBeNull()
        expect(SessionSchema.parse({ ...baseSession, serviceTier: 'fast' }).serviceTier).toBe('fast')
    })
})

describe('Agy permission modes', () => {
    test('exposes the native Antigravity permission choices used by HAPI', () => {
        expect(AGY_PERMISSION_MODES).toEqual(['default', 'read-only', 'safe-yolo', 'yolo'])
        expect(getPermissionModesForFlavor('agy')).toEqual(['default', 'read-only', 'safe-yolo', 'yolo'])
        expect(getPermissionModeOptionsForFlavor('agy')).toEqual([
            { mode: 'default', label: 'Default', tone: 'neutral' },
            { mode: 'read-only', label: 'Read Only', tone: 'warning' },
            { mode: 'safe-yolo', label: 'Safe Yolo', tone: 'warning' },
            { mode: 'yolo', label: 'Yolo', tone: 'danger' },
        ])
    })

    test('does not expose Claude/Cursor-only permission modes to agy', () => {
        expect(isPermissionModeAllowedForFlavor('plan', 'agy')).toBe(false)
        expect(isPermissionModeAllowedForFlavor('ask', 'agy')).toBe(false)
        expect(isPermissionModeAllowedForFlavor('bypassPermissions', 'agy')).toBe(false)
        expect(isPermissionModeAllowedForFlavor('acceptEdits', 'agy')).toBe(false)
    })
})

describe('Grok permission modes', () => {
    test('exposes only the HAPI modes verified through Grok ACP', () => {
        expect(GROK_PERMISSION_MODES).toEqual(['default', 'read-only', 'safe-yolo', 'yolo'])
        expect(getPermissionModesForFlavor('grok')).toEqual(GROK_PERMISSION_MODES)
    })

    test('does not expose parsed native-only modes as remote HAPI controls', () => {
        expect(isPermissionModeAllowedForFlavor('plan', 'grok')).toBe(false)
        expect(isPermissionModeAllowedForFlavor('bypassPermissions', 'grok')).toBe(false)
    })
})

describe('Hermes MoA permission modes', () => {
    test('exposes only the default/yolo choices supported by the Hermes bridge', () => {
        expect(HERMES_MOA_PERMISSION_MODES).toEqual(['default', 'yolo'])
        expect(getPermissionModesForFlavor('hermes-moa')).toEqual(['default', 'yolo'])
        expect(getPermissionModeOptionsForFlavor('hermes-moa')).toEqual([
            { mode: 'default', label: 'Default', tone: 'neutral' },
            { mode: 'yolo', label: 'Yolo', tone: 'danger' },
        ])
    })

    test('does not fall back to Claude/Codex permission modes', () => {
        expect(isPermissionModeAllowedForFlavor('acceptEdits', 'hermes-moa')).toBe(false)
        expect(isPermissionModeAllowedForFlavor('bypassPermissions', 'hermes-moa')).toBe(false)
        expect(isPermissionModeAllowedForFlavor('plan', 'hermes-moa')).toBe(false)
        expect(isPermissionModeAllowedForFlavor('read-only', 'hermes-moa')).toBe(false)
        expect(isPermissionModeAllowedForFlavor('safe-yolo', 'hermes-moa')).toBe(false)
    })
})
