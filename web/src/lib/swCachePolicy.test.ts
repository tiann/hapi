import { describe, expect, it } from 'vitest'
import { cacheOkResponsesOnly } from './swCachePolicy'

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
