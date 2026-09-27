import { describe, expect, it } from 'bun:test'
import {
    PeerSpawnDefaultsSchema,
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

    it('remaps resolved Claude bypassPermissions to codex yolo', () => {
        expect(resolvePermissionModeForFlavor('bypassPermissions', 'codex')).toBe('yolo')
    })

    it('remaps resolved Claude bypassPermissions to cursor yolo', () => {
        expect(resolvePermissionModeForFlavor('bypassPermissions', 'cursor')).toBe('yolo')
    })

    it('remaps Kimi safe-yolo onto Codex yolo (launchable auto-approval)', () => {
        expect(resolvePermissionModeForFlavor('safe-yolo', 'codex')).toBe('yolo')
    })

    it('falls back to AGY request-review instead of Claude default', () => {
        expect(resolvePermissionModeForFlavor('default', 'agy')).toBe('request-review')
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

    it('preserves auto-approval when hub returns resolved Claude bypassPermissions and agent overrides to codex', () => {
        expect(resolvePeerSpawnConfig(
            { agent: 'codex' },
            mergePeerSpawnDefaults(null)
        )).toEqual({
            agent: 'codex',
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

    it('keeps explicit permissionMode default for machine/New Session callers', () => {
        // Peer spawn normalizes default→omit in CLI spawnPeer, not here.
        expect(resolvePeerSpawnConfig(
            { permissionMode: 'default' },
            { permissionMode: 'yolo' }
        )).toEqual({
            agent: 'claude',
            permissionMode: 'default',
            model: 'sonnet'
        })
    })

    it('still honors explicit non-default permissionMode', () => {
        expect(resolvePeerSpawnConfig(
            { permissionMode: 'plan' },
            { permissionMode: 'yolo' }
        )).toEqual({
            agent: 'claude',
            permissionMode: 'plan',
            model: 'sonnet'
        })
    })
})

describe('PeerSpawnDefaultsSchema', () => {
    it('rejects retired gemini as a spawn default agent', () => {
        expect(PeerSpawnDefaultsSchema.safeParse({ agent: 'gemini' }).success).toBe(false)
    })

    it('accepts creatable agents', () => {
        expect(PeerSpawnDefaultsSchema.safeParse({ agent: 'codex' }).success).toBe(true)
    })
})
