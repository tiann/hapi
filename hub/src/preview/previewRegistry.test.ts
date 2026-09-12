import { describe, expect, it } from 'bun:test'
import { PreviewRegistry } from './previewRegistry'

const MOUNT_ID = '5f0c9a2e-1b3d-4e5f-8a9b-0c1d2e3f4a5b'
const MOUNT_ID_2 = '6f0c9a2e-1b3d-4e5f-8a9b-0c1d2e3f4a5b'

function descriptor(overrides: Record<string, unknown> = {}) {
    return {
        mountId: MOUNT_ID,
        kind: 'static',
        name: 'site',
        rootPath: '/tmp/site',
        ...overrides
    } as Parameters<PreviewRegistry['register']>[0]
}

function ctx(socketId = 'sock-1', sessionId = 'session-1') {
    return { socketId, namespace: 'default', sessionId }
}

describe('PreviewRegistry', () => {
    it('registers a mount and builds the public URL', () => {
        const registry = new PreviewRegistry('http://hub:3006')
        const ack = registry.register(descriptor(), ctx())
        expect(ack.ok).toBe(true)
        if (ack.ok) {
            expect(ack.url).toContain(`/preview/${MOUNT_ID}/`)
            expect(ack.expiresAt).toBeGreaterThan(Date.now())
        }
        expect(registry.get(MOUNT_ID)?.name).toBe('site')
    })

    it('rejects invalid descriptors (non-loopback proxy)', () => {
        const registry = new PreviewRegistry("http://hub:3006")
        const ack = registry.register(descriptor({
            mountId: MOUNT_ID_2,
            kind: 'proxy',
            name: 'p',
            url: 'http://192.168.1.5:3000'
        }), ctx())
        expect(ack).toEqual({ ok: false, error: 'proxy targets must be loopback', code: 'invalid' })
    })

    it('rejects a static descriptor without rootPath', () => {
        const registry = new PreviewRegistry("http://hub:3006")
        const ack = registry.register(descriptor({ rootPath: undefined }), ctx())
        expect(ack.ok).toBe(false)
    })

    it('tombstones expired mounts so lookups can answer 410 vs 404', () => {
        const registry = new PreviewRegistry("http://hub:3006")
        registry.register(descriptor({ ttlSeconds: 30 }), ctx())
        const now = Date.now()
        // Simulate expiry: sweep with a future clock.
        registry.sweep(now + 60_000)
        expect(registry.get(MOUNT_ID, now + 60_000)).toBeNull()
        expect(registry.isTombstoned(MOUNT_ID, now + 60_000)).toBe(true)
        expect(registry.isTombstoned(MOUNT_ID, now + 10 * 60_000)).toBe(false)
    })

    it('re-registering the same mountId rebinds the socket and keeps the URL', () => {
        const registry = new PreviewRegistry("http://hub:3006")
        const first = registry.register(descriptor(), ctx('sock-1'))
        const second = registry.register(descriptor(), ctx('sock-2'))
        expect(second).toEqual(first)
        registry.evictSocket('sock-1')
        // The mount moved to sock-2, so sock-1 eviction must not remove it.
        expect(registry.get(MOUNT_ID)).not.toBeNull()
    })

    it('refuses to rebind a mount from another session (public URL grants no admin)', () => {
        const registry = new PreviewRegistry("http://hub:3006")
        registry.register(descriptor({ token: 'tok-123456' }), ctx('sock-1', 'session-1'))

        const ack = registry.register(
            descriptor({ token: undefined, rootPath: '/tmp/evil' }),
            ctx('sock-9', 'session-2')
        )
        expect(ack).toEqual({ ok: false, error: 'mount belongs to another session', code: 'invalid' })
        // Original mount untouched.
        const entry = registry.get(MOUNT_ID)!
        expect(entry.token).toBe('tok-123456')
        expect(entry.rootPath).toBe('/tmp/site')
    })

    it('allows rebinding from the same session on a new socket', () => {
        const registry = new PreviewRegistry("http://hub:3006")
        registry.register(descriptor(), ctx('sock-1', 'session-1'))
        const ack = registry.register(descriptor({ rootPath: '/tmp/site2' }), ctx('sock-2', 'session-1'))
        expect(ack.ok).toBe(true)
        expect(registry.get(MOUNT_ID)?.rootPath).toBe('/tmp/site2')
    })

    it('unregister only removes mounts owned by the calling socket', () => {
        const registry = new PreviewRegistry("http://hub:3006")
        registry.register(descriptor(), ctx('sock-1'))
        const removed = registry.unregister({ mountId: MOUNT_ID }, ctx('sock-2'))
        expect(removed).toBe(0)
        expect(registry.get(MOUNT_ID)).not.toBeNull()
        expect(registry.unregister({ mountId: MOUNT_ID }, ctx('sock-1'))).toBe(1)
        expect(registry.get(MOUNT_ID)).toBeNull()
    })

    it('evictSocket removes every mount behind that socket', () => {
        const registry = new PreviewRegistry("http://hub:3006")
        registry.register(descriptor(), ctx('sock-1'))
        registry.register(descriptor({ mountId: MOUNT_ID_2, name: 'second' }), ctx('sock-1'))
        registry.register(descriptor({ mountId: MOUNT_ID_2, name: 'other-socket' }), ctx('sock-2'))
        expect(registry.evictSocket('sock-1')).toBe(1)
        expect(registry.get(MOUNT_ID)).toBeNull()
        expect(registry.get(MOUNT_ID_2)).not.toBeNull()
    })

    it('enforces the per-session mount cap', () => {
        const registry = new PreviewRegistry("http://hub:3006")
        let ack = registry.register(descriptor(), ctx())
        for (let i = 0; ack.ok && i < 8; i++) {
            ack = registry.register(descriptor({ mountId: `00000000-0000-4000-8000-00000000000${i}`, name: `m${i}` }), ctx())
        }
        expect(ack.ok).toBe(false)
        if (!ack.ok) expect(ack.code).toBe('cap')
    })

    it('checks the optional per-mount token', () => {
        const registry = new PreviewRegistry("http://hub:3006")
        registry.register(descriptor({ token: 'tok-123456' }), ctx())
        const entry = registry.get(MOUNT_ID)!
        expect(registry.checkToken(entry, null)).toBe(false)
        expect(registry.checkToken(entry, 'wrong')).toBe(false)
        expect(registry.checkToken(entry, 'tok-123456')).toBe(true)

        registry.register(descriptor(), ctx())
        expect(registry.checkToken(registry.get(MOUNT_ID)!, null)).toBe(true)
    })
})
