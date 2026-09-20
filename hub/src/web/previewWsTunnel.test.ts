import { describe, expect, it } from 'bun:test'
import { PREVIEW_URL_PREFIX } from '@hapi/protocol/preview'

import type { PreviewRegistry } from '../preview/previewRegistry'
import { resolvePreviewUpgrade } from './previewWsTunnel'

const MOUNT_ID = '5f0c9a2e-1b3d-4e5f-8a9b-0c1d2e3f4a5b'

function makeRegistry(entry: Record<string, unknown> | null): PreviewRegistry {
    return {
        get: () => (entry === null ? null : { mountId: MOUNT_ID, kind: 'proxy', ws: true, token: undefined, ...entry }),
        checkToken: () => true
    } as unknown as PreviewRegistry
}

function makeRequest(reqHeaders: Record<string, string> = {}): Request {
    return new Request(`http://hub.test${PREVIEW_URL_PREFIX}/${MOUNT_ID}/ws`, { headers: reqHeaders })
}

describe('resolvePreviewUpgrade', () => {
    it('rejects WebSocket upgrades for static mounts (HTTP-only terminator)', () => {
        const registry = makeRegistry({ kind: 'static' })
        const url = new URL(`http://hub.test${PREVIEW_URL_PREFIX}/${MOUNT_ID}/ws`)
        const req = makeRequest({ upgrade: 'websocket' })
        expect(resolvePreviewUpgrade(url.pathname, url, req, registry)).toBeNull()
    })

    it('accepts proxy mounts with ws enabled and builds the upgrade meta', () => {
        const registry = makeRegistry({ kind: 'proxy', ws: true })
        const url = new URL(`http://hub.test${PREVIEW_URL_PREFIX}/${MOUNT_ID}/hmr?token=1`)
        const req = makeRequest({ upgrade: 'websocket', 'sec-websocket-protocol': 'vite-hmr' })

        const resolved = resolvePreviewUpgrade(url.pathname, url, req, registry)
        expect(resolved).not.toBeNull()
        expect(resolved?.meta.path).toBe('hmr')
        expect(resolved?.meta.protocols).toBe('vite-hmr')
    })

    it('rejects proxy mounts with ws disabled', () => {
        const registry = makeRegistry({ kind: 'proxy', ws: false })
        const url = new URL(`http://hub.test${PREVIEW_URL_PREFIX}/${MOUNT_ID}/ws`)
        const req = makeRequest({ upgrade: 'websocket' })
        expect(resolvePreviewUpgrade(url.pathname, url, req, registry)).toBeNull()
    })
})
