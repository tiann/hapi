import { afterEach, describe, expect, it, vi } from 'vitest'
import {
    AUTHENTICATED_API_CACHE_NAMES,
    CLEAR_API_CACHES_MESSAGE_TYPE,
    authenticatedApiCachePolicy,
    cacheOkResponsesOnly,
    cacheJavaScriptOnly,
    clearAuthenticatedApiCaches,
} from './swCachePolicy'

function fakeJwt(payload: Record<string, unknown>): string {
    const encode = (value: unknown) => btoa(JSON.stringify(value))
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=+$/, '')
    return `${encode({ alg: 'HS256', typ: 'JWT' })}.${encode(payload)}.signature`
}

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

describe('authenticatedApiCachePolicy', () => {
    afterEach(() => {
        vi.unstubAllGlobals()
    })

    it('derives distinct cache keys per hub origin and identity while stripping fragments and caller scope overrides', async () => {
        const aliceDefault = fakeJwt({ uid: 1, ns: 'default', authMethod: 'cloudflareAccess', cfAccessSub: 'alice', cfAccessEmail: 'Alice@Example.com' })
        const aliceDefaultNormalized = fakeJwt({ uid: 1, ns: 'default', authMethod: 'cloudflareAccess', cfAccessSub: 'alice', cfAccessEmail: 'alice@example.com' })
        const bobWork = fakeJwt({ uid: 1, ns: 'work', authMethod: 'cloudflareAccess', cfAccessSub: 'bob', cfAccessEmail: 'bob@example.com' })

        const aliceKey1 = await authenticatedApiCachePolicy.cacheKeyWillBeUsed({
            request: new Request('https://hub-a.test/api/sessions?__hapi_sw_scope=spoofed#frag', {
                headers: { authorization: `Bearer ${aliceDefault}` }
            })
        })
        const aliceKey2 = await authenticatedApiCachePolicy.cacheKeyWillBeUsed({
            request: new Request('https://hub-a.test/api/sessions', {
                headers: { authorization: `Bearer ${aliceDefaultNormalized}` }
            })
        })
        const bobKey = await authenticatedApiCachePolicy.cacheKeyWillBeUsed({
            request: new Request('https://hub-a.test/api/sessions', {
                headers: { authorization: `Bearer ${bobWork}` }
            })
        })
        const otherHubKey = await authenticatedApiCachePolicy.cacheKeyWillBeUsed({
            request: new Request('https://hub-b.test/api/sessions', {
                headers: { authorization: `Bearer ${aliceDefault}` }
            })
        })

        expect(aliceKey1).toBe(aliceKey2)
        expect(aliceKey1).not.toContain('spoofed')
        expect(aliceKey1).not.toContain('#frag')
        expect(aliceKey1).not.toBe(bobKey)
        expect(aliceKey1).not.toBe(otherHubKey)
    })

    it('fails closed on unauthenticated, empty-claim, or non-200 responses', async () => {
        const validJwt = fakeJwt({ uid: 1, ns: 'default' })
        const emptyClaimsJwt = fakeJwt({})

        expect(await authenticatedApiCachePolicy.cacheWillUpdate({
            request: new Request('https://hub-a.test/api/sessions'),
            response: new Response('{}', { status: 200 })
        })).toBeNull()

        expect(await authenticatedApiCachePolicy.cacheWillUpdate({
            request: new Request('https://hub-a.test/api/sessions', {
                headers: { authorization: `Bearer ${emptyClaimsJwt}` }
            }),
            response: new Response('{}', { status: 200 })
        })).toBeNull()

        expect(await authenticatedApiCachePolicy.cacheWillUpdate({
            request: new Request('https://hub-a.test/api/sessions', {
                headers: { authorization: `Bearer ${validJwt}` }
            }),
            response: new Response('{}', { status: 500 })
        })).toBeNull()

        const unauthKey = await authenticatedApiCachePolicy.cacheKeyWillBeUsed({
            request: new Request('https://hub-a.test/api/sessions')
        })
        expect(await authenticatedApiCachePolicy.cachedResponseWillBeUsed({
            request: new Request(unauthKey),
            cachedResponse: new Response('{}', { status: 200 })
        })).toBeNull()

        expect(await authenticatedApiCachePolicy.cachedResponseWillBeUsed({
            request: new Request('https://hub-a.test/api/sessions'),
            cachedResponse: new Response('{}', { status: 200 })
        })).toBeNull()
    })

    it('clearAuthenticatedApiCaches deletes all API caches and posts CLEAR_API_CACHES to the SW controller', async () => {
        const deleteCache = vi.fn(async () => true)
        const postMessage = vi.fn()
        vi.stubGlobal('caches', { delete: deleteCache })
        const originalDescriptor = Object.getOwnPropertyDescriptor(navigator, 'serviceWorker')
        Object.defineProperty(navigator, 'serviceWorker', {
            configurable: true,
            value: { controller: { postMessage } }
        })

        try {
            await clearAuthenticatedApiCaches()
            for (const name of AUTHENTICATED_API_CACHE_NAMES) {
                expect(deleteCache).toHaveBeenCalledWith(name)
            }
            expect(postMessage).toHaveBeenCalledWith({ type: CLEAR_API_CACHES_MESSAGE_TYPE })
        } finally {
            if (originalDescriptor) {
                Object.defineProperty(navigator, 'serviceWorker', originalDescriptor)
            } else {
                delete (navigator as unknown as { serviceWorker?: unknown }).serviceWorker
            }
        }
    })
})
