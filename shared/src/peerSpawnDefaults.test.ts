import { describe, expect, it } from 'bun:test'
import {
    STOCK_PEER_SPAWN_DEFAULTS,
    mergePeerSpawnDefaults,
    resolvePeerSpawnConfig,
    resolvePermissionModeForFlavor
} from './peerSpawnDefaults'

describe('resolvePermissionModeForFlavor', () => {
    it('maps stock yolo to bypassPermissions for claude', () => {
        expect(resolvePermissionModeForFlavor('yolo', 'claude')).toBe('bypassPermissions')
    })

    it('keeps yolo for codex', () => {
        expect(resolvePermissionModeForFlavor('yolo', 'codex')).toBe('yolo')
    })

    it('keeps explicit bypassPermissions for claude', () => {
        expect(resolvePermissionModeForFlavor('bypassPermissions', 'claude')).toBe('bypassPermissions')
    })
})

describe('mergePeerSpawnDefaults', () => {
    it('returns stock when hub settings are unset', () => {
        expect(mergePeerSpawnDefaults(null)).toEqual({
            ...STOCK_PEER_SPAWN_DEFAULTS,
            permissionMode: 'bypassPermissions'
        })
        expect(mergePeerSpawnDefaults(undefined)).toEqual({
            ...STOCK_PEER_SPAWN_DEFAULTS,
            permissionMode: 'bypassPermissions'
        })
    })

    it('merges partial hub overrides', () => {
        expect(mergePeerSpawnDefaults({
            agent: 'cursor',
            models: { cursor: 'auto' }
        })).toEqual({
            agent: 'cursor',
            permissionMode: 'yolo',
            models: {
                claude: 'sonnet',
                cursor: 'auto'
            }
        })
    })
})

describe('resolvePeerSpawnConfig', () => {
    it('prefers explicit args over hub settings over stock', () => {
        expect(resolvePeerSpawnConfig(
            { agent: 'codex', permissionMode: 'read-only', model: 'gpt-5' },
            { agent: 'cursor', permissionMode: 'auto', models: { cursor: 'composer-2.5' } }
        )).toEqual({
            agent: 'codex',
            permissionMode: 'read-only',
            model: 'gpt-5'
        })
    })

    it('falls back to hub model for resolved agent', () => {
        expect(resolvePeerSpawnConfig(
            { agent: 'claude' },
            { models: { claude: 'opus' } }
        )).toEqual({
            agent: 'claude',
            permissionMode: 'bypassPermissions',
            model: 'opus'
        })
    })

    it('uses stock defaults when hub settings are unavailable', () => {
        expect(resolvePeerSpawnConfig({})).toEqual({
            agent: 'claude',
            permissionMode: 'bypassPermissions',
            model: 'sonnet'
        })
    })

    it('re-maps stock yolo permission when agent override differs from hub default agent', () => {
        expect(resolvePeerSpawnConfig(
            { agent: 'cursor' },
            { agent: 'claude', permissionMode: 'yolo' }
        )).toEqual({
            agent: 'cursor',
            permissionMode: 'yolo'
        })
    })

    it('forwards explicit effort', () => {
        expect(resolvePeerSpawnConfig({ effort: 'high' })).toEqual({
            agent: 'claude',
            permissionMode: 'bypassPermissions',
            model: 'sonnet',
            effort: 'high'
        })
    })
})
