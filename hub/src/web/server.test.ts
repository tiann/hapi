import { describe, expect, it } from 'bun:test'
import { gunzipSync } from 'node:zlib'
import { Hono } from 'hono'
import {
    addVaryAcceptEncoding,
    createApiNoStoreMiddleware,
    createCompressionMiddleware,
    isCompressibleContentType,
    isStaticAssetRequestPath,
    pickCompressionEncoding,
    sanitizeRequestLogPath,
    shouldSkipCompressionForPath
} from './server'

describe('static asset fallback', () => {
    it('distinguishes missing asset requests from client-side routes', () => {
        expect(isStaticAssetRequestPath('/assets/missing.js')).toBe(true)
        expect(isStaticAssetRequestPath('/assets/fonts/KaTeX_Main-Regular.woff2')).toBe(true)
        expect(isStaticAssetRequestPath('/manifest.webmanifest')).toBe(true)
        expect(isStaticAssetRequestPath('/sessions/session.with.dots')).toBe(false)
        expect(isStaticAssetRequestPath('/sessions/abc')).toBe(false)
    })
})

describe('authenticated API cache policy', () => {
    it('marks API responses as non-cacheable without changing static responses', async () => {
        const app = new Hono()
        app.use('/api/*', createApiNoStoreMiddleware())
        app.get('/api/sessions', (c) => c.json({ sessions: [] }))
        app.get('/asset.js', (c) => c.text('asset'))

        const api = await app.request('/api/sessions')
        expect(api.headers.get('Cache-Control')).toBe('no-store')
        expect(api.headers.get('Pragma')).toBe('no-cache')

        const asset = await app.request('/asset.js')
        expect(asset.headers.get('Cache-Control')).toBeNull()
    })
})

describe('sanitizeRequestLogPath', () => {
    it('redacts sensitive query parameters in logged paths while preserving safe params', () => {
        expect(sanitizeRequestLogPath('/api/events?token=jwt123&visibility=visible&all=true'))
            .toBe('/api/events?token=[REDACTED]&visibility=visible&all=true')
        expect(sanitizeRequestLogPath('/api/auth?accessToken=secret&next=/sessions'))
            .toBe('/api/auth?accessToken=[REDACTED]&next=/sessions')
        expect(sanitizeRequestLogPath('/api/events?Token=jwt123&AUTHORIZATION=bearer'))
            .toBe('/api/events?Token=[REDACTED]&AUTHORIZATION=[REDACTED]')
        expect(sanitizeRequestLogPath('/api/events?auth=secret&x=a+b'))
            .toBe('/api/events?auth=[REDACTED]&x=a+b')
    })

    it('redacts repeated and encoded sensitive parameter names without collapsing query shape', () => {
        expect(sanitizeRequestLogPath('/api/events?token=a&token=b&x=1'))
            .toBe('/api/events?token=[REDACTED]&token=[REDACTED]&x=1')
        expect(sanitizeRequestLogPath('/api/events?%74%6f%6b%65%6e=jwt&x=1'))
            .toBe('/api/events?%74%6f%6b%65%6e=[REDACTED]&x=1')
        expect(sanitizeRequestLogPath('/api/events?token&x=1&&auth=secret'))
            .toBe('/api/events?token=[REDACTED]&x=1&&auth=[REDACTED]')
    })

    it('preserves paths without query strings and empty query strings', () => {
        expect(sanitizeRequestLogPath('/api/sessions/abc')).toBe('/api/sessions/abc')
        expect(sanitizeRequestLogPath('/assets/index-abc123.js')).toBe('/assets/index-abc123.js')
        expect(sanitizeRequestLogPath('/api/events?')).toBe('/api/events?')
    })
})

describe('compression helpers', () => {
    it('prefers brotli over gzip when both are accepted', () => {
        expect(pickCompressionEncoding('gzip, br')).toBe('br')
        expect(pickCompressionEncoding('gzip;q=1, br;q=0.5')).toBe('gzip')
        expect(pickCompressionEncoding('br;q=0, gzip;q=1')).toBe('gzip')
        expect(pickCompressionEncoding('identity')).toBeNull()
    })

    it('compresses textual/javascript/json/svg content types only', () => {
        expect(isCompressibleContentType('application/json; charset=utf-8')).toBe(true)
        expect(isCompressibleContentType('text/javascript; charset=utf-8')).toBe(true)
        expect(isCompressibleContentType('image/svg+xml')).toBe(true)
        expect(isCompressibleContentType('text/event-stream')).toBe(false)
        expect(isCompressibleContentType('image/png')).toBe(false)
        expect(isCompressibleContentType(null)).toBe(false)
    })

    it('skips event streams and socket traffic to avoid breaking streaming transports', () => {
        expect(shouldSkipCompressionForPath('/api/events?token=abc')).toBe(true)
        expect(shouldSkipCompressionForPath('/socket.io/?EIO=4')).toBe(true)
        expect(shouldSkipCompressionForPath('/api/sessions')).toBe(false)
        expect(shouldSkipCompressionForPath('/assets/index-abc.js')).toBe(false)
    })

    it('adds Vary: Accept-Encoding without dropping existing vary values', () => {
        expect(addVaryAcceptEncoding(null)).toBe('Accept-Encoding')
        expect(addVaryAcceptEncoding('Origin')).toBe('Origin, Accept-Encoding')
        expect(addVaryAcceptEncoding('Origin, Accept-Encoding')).toBe('Origin, Accept-Encoding')
    })

    it('compresses eligible responses end-to-end and preserves cache variance', async () => {
        const app = new Hono()
        app.use('*', createCompressionMiddleware())
        app.get('/data', (c) => c.json({ text: 'hello '.repeat(500) }))

        const response = await app.request('/data', {
            headers: { 'Accept-Encoding': 'gzip' }
        })

        expect(response.headers.get('Content-Encoding')).toBe('gzip')
        expect(response.headers.get('Vary')).toBe('Accept-Encoding')
        const body = gunzipSync(Buffer.from(await response.arrayBuffer())).toString('utf8')
        expect(body).toContain('hello hello')
    })

    it('does not compress SSE, ranged, or partial-content responses', async () => {
        const app = new Hono()
        app.use('*', createCompressionMiddleware())
        app.get('/api/events', () => new Response('data: hello\n\n'.repeat(200), {
            headers: { 'Content-Type': 'text/event-stream' }
        }))
        app.get('/asset', () => new Response('asset '.repeat(500), {
            status: 206,
            headers: { 'Content-Type': 'text/plain' }
        }))

        const eventStream = await app.request('/api/events', {
            headers: { 'Accept-Encoding': 'gzip' }
        })
        expect(eventStream.headers.get('Content-Encoding')).toBeNull()

        const ranged = await app.request('/asset', {
            headers: {
                'Accept-Encoding': 'gzip',
                Range: 'bytes=0-99',
            }
        })
        expect(ranged.status).toBe(206)
        expect(ranged.headers.get('Content-Encoding')).toBeNull()
    })
})
