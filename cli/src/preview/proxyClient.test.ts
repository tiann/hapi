import { describe, expect, it } from 'vitest'

import {
    buildUpstreamRequestPath,
    buildUpstreamWsUrl,
    canRewriteBody,
    parseWsProtocols,
    sanitizeRequestHeaders
} from './proxyClient'
import type { PreviewOpenFrame } from '@hapi/protocol/preview'

function frame(overrides: Partial<PreviewOpenFrame> = {}): PreviewOpenFrame {
    return {
        type: 'open',
        connId: 'c1',
        mountId: '5f0c9a2e-1b3d-4e5f-8a9b-0c1d2e3f4a5b',
        kind: 'http',
        method: 'GET',
        path: '',
        headers: {},
        ...overrides
    }
}

describe('buildUpstreamRequestPath / buildUpstreamWsUrl', () => {
    it('never lets a leading // replace the approved loopback authority', () => {
        const target = new URL('http://127.0.0.1:5173')

        const wsUrl = buildUpstreamWsUrl(target, '/192.168.1.10:8080/ws')
        expect(wsUrl.hostname).toBe('127.0.0.1')
        expect(wsUrl.port).toBe('5173')
        expect(wsUrl.pathname).toBe('/192.168.1.10:8080/ws')
        expect(wsUrl.protocol).toBe('ws:')

        expect(buildUpstreamRequestPath('//192.168.1.10:8080/ws')).toBe('/192.168.1.10:8080/ws')
        expect(buildUpstreamRequestPath('assets/app.js', 'v=2')).toBe('/assets/app.js?v=2')
    })

    it('keeps the query and forces ws/wss from the target scheme', () => {
        const wsUrl = buildUpstreamWsUrl(new URL('https://localhost:5173'), 'hmr', 'token=1')
        expect(wsUrl.toString()).toBe('wss://localhost:5173/hmr?token=1')
    })
})

describe('parseWsProtocols', () => {
    it('splits the raw Sec-WebSocket-Protocol header', () => {
        expect(parseWsProtocols('vite-hmr, v2.chat')).toEqual(['vite-hmr', 'v2.chat'])
        expect(parseWsProtocols(undefined)).toEqual([])
        expect(parseWsProtocols('')).toEqual([])
    })
})

describe('canRewriteBody', () => {
    it('rewrites only uncompressed HTML', () => {
        expect(canRewriteBody('text/html; charset=utf-8', undefined)).toBe(true)
        expect(canRewriteBody('text/html', 'identity')).toBe(true)
        expect(canRewriteBody('text/html', 'br')).toBe(false)
        expect(canRewriteBody('text/html', 'gzip')).toBe(false)
        expect(canRewriteBody('application/json', undefined)).toBe(false)
    })
})

describe('sanitizeRequestHeaders', () => {
    it('requests identity encoding so HTML rewriting sees plain bytes', () => {
        const target = new URL('http://127.0.0.1:5173')
        const headers = sanitizeRequestHeaders(frame({ headers: { 'accept-encoding': 'gzip, br' } }), target)
        expect(headers['accept-encoding']).toBe('identity')
        expect(headers.host).toBe('127.0.0.1:5173')
    })
})
