import { describe, expect, it } from 'vitest'
import { cacheOkResponsesOnly, cacheJavaScriptOnly } from './swCachePolicy'

function redirectedResponse(body: string): Response {
    // Response objects built in tests cannot set `redirected`; model one that came through a redirect.
    const inner = new Response(body, { status: 200, statusText: 'OK', headers: { 'content-type': 'application/json' } })
    return {
        redirected: true,
        status: 200,
        statusText: 'OK',
        headers: inner.headers,
        arrayBuffer: () => inner.arrayBuffer(),
    } as unknown as Response
}

describe('optional syntax module cache', () => {
    it('stores JavaScript but rejects login HTML, redirects and failures', async () => {
        for (const type of ['text/javascript', 'application/javascript; charset=utf-8']) {
            const response = new Response('export default []', { headers: { 'content-type': type } })
            expect(await cacheJavaScriptOnly.cacheWillUpdate({ response })).toBe(response)
        }
        for (const response of [
            new Response('<html>Login</html>', { headers: { 'content-type': 'text/html' } }),
            new Response('unavailable', { status: 503, headers: { 'content-type': 'text/javascript' } }),
            new Response('unknown content type'),
            redirectedResponse('redirected'),
        ]) {
            expect(await cacheJavaScriptOnly.cacheWillUpdate({ response })).toBeNull()
        }
    })
})

describe('cacheOkResponsesOnly', () => {
    it('stores plain 200 responses as they are', async () => {
        const response = new Response('{}', { status: 200 })
        expect(await cacheOkResponsesOnly.cacheWillUpdate({ response })).toBe(response)
    })

    it('rejects opaque redirects and other non-200 responses', async () => {
        for (const response of [
            { status: 0, type: 'opaqueredirect' },
            { status: 0, type: 'opaque' },
            { status: 204, type: 'basic' },
            { status: 304, type: 'basic' },
            { status: 404, type: 'basic' },
            { status: 500, type: 'basic' },
        ] as Response[]) {
            expect(await cacheOkResponsesOnly.cacheWillUpdate({ response })).toBeNull()
        }
    })

    it('stores a followed redirect without its redirect history', async () => {
        const stored = await cacheOkResponsesOnly.cacheWillUpdate({ response: redirectedResponse('{"ok":1}') })
        expect(stored).not.toBeNull()
        expect(stored!.redirected).toBe(false)
        expect(stored!.status).toBe(200)
        expect(stored!.statusText).toBe('OK')
        expect(stored!.headers.get('content-type')).toBe('application/json')
        expect(await stored!.text()).toBe('{"ok":1}')
    })

    it('serves entries cached with redirect history without it', async () => {
        const served = await cacheOkResponsesOnly.cachedResponseWillBeUsed({ cachedResponse: redirectedResponse('[1]') })
        expect(served!.redirected).toBe(false)
        expect(await served!.text()).toBe('[1]')

        const plain = new Response('[2]', { status: 200 })
        expect(await cacheOkResponsesOnly.cachedResponseWillBeUsed({ cachedResponse: plain })).toBe(plain)
        expect(await cacheOkResponsesOnly.cachedResponseWillBeUsed({})).toBeNull()
    })
})
