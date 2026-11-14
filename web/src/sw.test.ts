// @vitest-environment-options { "url": "http://hub.test/" }
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('workbox-precaching', () => ({
    precacheAndRoute: vi.fn()
}))

vi.mock('workbox-expiration', () => ({
    ExpirationPlugin: class MockExpirationPlugin {
        async deleteCacheAndMetadata(): Promise<void> {}
    }
}))

function fakeJwt(payload: Record<string, unknown>): string {
    const encode = (value: unknown) => btoa(JSON.stringify(value))
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=+$/, '')
    return `${encode({ alg: 'HS256', typ: 'JWT' })}.${encode(payload)}.signature`
}

function jsonResponse(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' }
    })
}

class MemoryCache implements Cache {
    private readonly entries = new Map<string, Response>()

    private normalizeKey(request: RequestInfo | URL): string {
        const url = typeof request === 'string'
            ? request
            : request instanceof URL
                ? request.href
                : request.url
        const parsed = new URL(url, 'http://hub.test/')
        parsed.hash = ''
        return parsed.href
    }

    async match(request: RequestInfo | URL): Promise<Response | undefined> {
        const hit = this.entries.get(this.normalizeKey(request))
        return hit ? hit.clone() : undefined
    }

    async matchAll(request?: RequestInfo | URL): Promise<readonly Response[]> {
        if (!request) {
            return Array.from(this.entries.values(), (response) => response.clone())
        }
        const hit = await this.match(request)
        return hit ? [hit] : []
    }

    async add(): Promise<void> {
        throw new Error('Not implemented')
    }

    async addAll(): Promise<void> {
        throw new Error('Not implemented')
    }

    async put(request: RequestInfo | URL, response: Response): Promise<void> {
        this.entries.set(this.normalizeKey(request), response.clone())
    }

    async delete(request: RequestInfo | URL): Promise<boolean> {
        return this.entries.delete(this.normalizeKey(request))
    }

    async keys(): Promise<readonly Request[]> {
        return Array.from(this.entries.keys(), (url) => new Request(url))
    }
}

class MemoryCacheStorage implements CacheStorage {
    private readonly store = new Map<string, MemoryCache>()

    async open(cacheName: string): Promise<Cache> {
        let cache = this.store.get(cacheName)
        if (!cache) {
            cache = new MemoryCache()
            this.store.set(cacheName, cache)
        }
        return cache
    }

    async match(request: RequestInfo | URL, options?: MultiCacheQueryOptions): Promise<Response | undefined> {
        if (options?.cacheName) {
            const cache = this.store.get(options.cacheName)
            return cache ? await cache.match(request) : undefined
        }
        for (const cache of this.store.values()) {
            const hit = await cache.match(request)
            if (hit) return hit
        }
        return undefined
    }

    async has(cacheName: string): Promise<boolean> {
        return this.store.has(cacheName)
    }

    async delete(cacheName: string): Promise<boolean> {
        return this.store.delete(cacheName)
    }

    async keys(): Promise<string[]> {
        return Array.from(this.store.keys())
    }
}

class MockExtendableEvent extends Event {
    readonly waitUntilPromises: Array<Promise<unknown>> = []

    waitUntil(promise: Promise<unknown>): void {
        this.waitUntilPromises.push(Promise.resolve(promise))
    }

    async drain(): Promise<void> {
        while (this.waitUntilPromises.length > 0) {
            const batch = this.waitUntilPromises.splice(0)
            await Promise.allSettled(batch)
        }
    }
}

class MockFetchEvent extends MockExtendableEvent {
    readonly request: Request
    responsePromise: Promise<Response> | null = null

    constructor(request: Request) {
        super('fetch')
        this.request = request
    }

    respondWith(response: Response | Promise<Response>): void {
        this.responsePromise = Promise.resolve(response)
    }
}

type SwHarness = {
    caches: MemoryCacheStorage
    dispatchFetch: (request: Request) => Promise<Response>
    dispatchMessage: (data: unknown) => Promise<void>
}

async function createSwHarness(): Promise<SwHarness> {
    vi.resetModules()
    const caches = new MemoryCacheStorage()
    const listeners = new Map<string, Array<(event: Event) => void>>()

    const addEventListener = vi.fn((type: string, listener: EventListenerOrEventListenerObject) => {
        const fn = typeof listener === 'function' ? listener : listener.handleEvent.bind(listener)
        const existing = listeners.get(type) ?? []
        existing.push(fn)
        listeners.set(type, existing)
    })

    vi.stubGlobal('ExtendableEvent', MockExtendableEvent)
    vi.stubGlobal('FetchEvent', MockFetchEvent)
    vi.stubGlobal('caches', caches)
    vi.stubGlobal('__WB_MANIFEST', [])
    vi.stubGlobal('addEventListener', addEventListener)
    vi.stubGlobal('skipWaiting', vi.fn())
    vi.stubGlobal('clients', { claim: vi.fn(async () => {}) })
    vi.stubGlobal('registration', { scope: 'http://hub.test/', showNotification: vi.fn(async () => {}) })

    await import('./sw')

    const dispatchFetch = async (request: Request): Promise<Response> => {
        const event = new MockFetchEvent(request)
        for (const listener of listeners.get('fetch') ?? []) {
            listener(event)
            if (event.responsePromise) break
        }
        if (!event.responsePromise) {
            throw new Error(`Service worker did not handle fetch for ${request.url}`)
        }
        try {
            return await event.responsePromise
        } finally {
            await event.drain()
        }
    }

    const dispatchMessage = async (data: unknown): Promise<void> => {
        const event = new MockExtendableEvent('message') as MockExtendableEvent & { data: unknown }
        event.data = data
        for (const listener of listeners.get('message') ?? []) {
            listener(event)
        }
        await event.drain()
    }

    return { caches, dispatchFetch, dispatchMessage }
}

describe('Service Worker API cache isolation across Access identity switches', () => {
    const exp = Math.floor(Date.now() / 1000) + 3600
    const aliceJwt1 = fakeJwt({
        uid: 1,
        ns: 'default',
        authMethod: 'cloudflareAccess',
        cfAccessSub: 'alice-sub',
        cfAccessEmail: 'alice@example.com',
        exp
    })
    const aliceJwt2 = fakeJwt({
        uid: 1,
        ns: 'default',
        authMethod: 'cloudflareAccess',
        cfAccessSub: 'alice-sub',
        cfAccessEmail: 'alice@example.com',
        exp: exp + 600
    })
    const aliceWorkJwt = fakeJwt({
        uid: 1,
        ns: 'work',
        authMethod: 'cloudflareAccess',
        cfAccessSub: 'alice-sub',
        cfAccessEmail: 'alice@example.com',
        exp
    })
    const bobJwt = fakeJwt({
        uid: 1,
        ns: 'work',
        authMethod: 'cloudflareAccess',
        cfAccessSub: 'bob-sub',
        cfAccessEmail: 'bob@example.com',
        exp
    })
    const carolJwt = fakeJwt({
        uid: 1,
        ns: 'work',
        authMethod: 'cloudflareAccess',
        cfAccessSub: 'carol-sub',
        cfAccessEmail: 'carol@example.com',
        exp
    })

    beforeEach(() => {
        vi.useRealTimers()
    })

    afterEach(() => {
        vi.useRealTimers()
        vi.unstubAllGlobals()
    })

    it('never serves Alice cached /api/sessions, /api/sessions/:id, or /api/machines to Bob when Bob request fails', async () => {
        const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
            const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
            if (url.endsWith('/api/sessions')) {
                return jsonResponse({ sessions: [{ id: 'alice-session', namespace: 'default' }] })
            }
            if (url.endsWith('/api/sessions/shared-id')) {
                return jsonResponse({ session: { id: 'shared-id', owner: 'alice' } })
            }
            if (url.endsWith('/api/machines')) {
                return jsonResponse({ machines: [{ id: 'alice-machine' }] })
            }
            return jsonResponse({ error: 'Not Found' }, 404)
        })
        vi.stubGlobal('fetch', fetchMock)

        const sw = await createSwHarness()

        // Alice caches all three authenticated API endpoints.
        for (const path of ['/api/sessions', '/api/sessions/shared-id', '/api/machines']) {
            const res = await sw.dispatchFetch(new Request(`http://hub.test${path}`, {
                headers: { authorization: `Bearer ${aliceJwt1}` }
            }))
            expect(res.status).toBe(200)
        }

        // Identity switches to Bob in the 'work' namespace; Bob's network requests fail.
        fetchMock.mockRejectedValue(new TypeError('Failed to fetch'))

        for (const path of ['/api/sessions', '/api/sessions/shared-id', '/api/machines']) {
            await expect(sw.dispatchFetch(new Request(`http://hub.test${path}`, {
                headers: { authorization: `Bearer ${bobJwt}` }
            }))).rejects.toThrow()
        }
    })

    it('never falls back to Alice cached response when Bob request exceeds the 10s NetworkFirst timeout', async () => {
        let mode: 'alice' | 'bob-slow' = 'alice'
        const fetchMock = vi.fn((input: RequestInfo | URL) => {
            const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
            expect(url).toBe('http://hub.test/api/sessions')
            if (mode === 'alice') {
                return Promise.resolve(jsonResponse({ sessions: [{ id: 'alice-secret-session' }] }))
            }
            return new Promise<Response>((resolve) => {
                setTimeout(() => {
                    resolve(jsonResponse({ sessions: [{ id: 'bob-session' }] }))
                }, 12_000)
            })
        })
        vi.stubGlobal('fetch', fetchMock)

        const sw = await createSwHarness()

        // Alice populates api-sessions.
        const aliceRes = await sw.dispatchFetch(new Request('http://hub.test/api/sessions', {
            headers: { authorization: `Bearer ${aliceJwt1}` }
        }))
        expect(await aliceRes.json()).toEqual({ sessions: [{ id: 'alice-secret-session' }] })

        // Bob sends a slow request that exceeds the 10s timeout.
        vi.useFakeTimers()
        mode = 'bob-slow'
        const bobPromise = sw.dispatchFetch(new Request('http://hub.test/api/sessions', {
            headers: { authorization: `Bearer ${bobJwt}` }
        }))

        // Advance past the 10s NetworkFirst timeout; must NOT resolve early with Alice's cached 200.
        await vi.advanceTimersByTimeAsync(10_500)
        let settledEarly = false
        void bobPromise.then(() => {
            settledEarly = true
        })
        await Promise.resolve()
        expect(settledEarly).toBe(false)

        // When Bob's slow network response finally arrives at 12s, Bob gets Bob's own data.
        await vi.advanceTimersByTimeAsync(2_000)
        const bobRes = await bobPromise
        expect(await bobRes.json()).toEqual({ sessions: [{ id: 'bob-session' }] })
    })

    it('keeps offline cache fallback across same-identity JWT refresh, but isolates different subjects, namespaces, hubs, and unauthenticated requests', async () => {
        const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
            const req = input instanceof Request ? input : new Request(input)
            const auth = req.headers.get('authorization')
            if (auth === `Bearer ${aliceJwt1}`) {
                return jsonResponse({ sessions: [{ id: 'alice-default' }] })
            }
            if (auth === `Bearer ${bobJwt}`) {
                return jsonResponse({ sessions: [{ id: 'bob-work' }] })
            }
            return jsonResponse({ sessions: [{ id: 'unexpected' }] })
        })
        vi.stubGlobal('fetch', fetchMock)

        const sw = await createSwHarness()

        // Alice populates cache on hub.test.
        await sw.dispatchFetch(new Request('http://hub.test/api/sessions', {
            headers: { authorization: `Bearer ${aliceJwt1}` }
        }))
        // Bob populates cache on hub.test.
        await sw.dispatchFetch(new Request('http://hub.test/api/sessions', {
            headers: { authorization: `Bearer ${bobJwt}` }
        }))

        // Network goes offline.
        fetchMock.mockRejectedValue(new TypeError('offline'))

        // Same-identity refresh (aliceJwt2) still receives Alice's cached response.
        const aliceOffline = await sw.dispatchFetch(new Request('http://hub.test/api/sessions', {
            headers: { authorization: `Bearer ${aliceJwt2}` }
        }))
        expect(await aliceOffline.json()).toEqual({ sessions: [{ id: 'alice-default' }] })

        // Same subject in a different namespace ('work') must fail closed.
        await expect(sw.dispatchFetch(new Request('http://hub.test/api/sessions', {
            headers: { authorization: `Bearer ${aliceWorkJwt}` }
        }))).rejects.toThrow()

        // Different subject in the same namespace ('work') must fail closed.
        await expect(sw.dispatchFetch(new Request('http://hub.test/api/sessions', {
            headers: { authorization: `Bearer ${carolJwt}` }
        }))).rejects.toThrow()

        // Same identity on a different hub origin must fail closed.
        await expect(sw.dispatchFetch(new Request('http://other-hub.test/api/sessions', {
            headers: { authorization: `Bearer ${aliceJwt1}` }
        }))).rejects.toThrow()

        // Unauthenticated or malformed-token requests must fail closed and never cache.
        await expect(sw.dispatchFetch(new Request('http://hub.test/api/sessions'))).rejects.toThrow()
        await expect(sw.dispatchFetch(new Request('http://hub.test/api/sessions', {
            headers: { authorization: 'Bearer not-a-jwt' }
        }))).rejects.toThrow()

        // Even if an unauthenticated request somehow got a 200, it must not be cached.
        fetchMock.mockResolvedValueOnce(jsonResponse({ sessions: [{ id: 'unauth' }] }))
        await sw.dispatchFetch(new Request('http://hub.test/api/sessions'))
        fetchMock.mockRejectedValue(new TypeError('offline'))
        await expect(sw.dispatchFetch(new Request('http://hub.test/api/sessions'))).rejects.toThrow()
    })

    it('deletes all authenticated API caches when receiving CLEAR_API_CACHES message', async () => {
        vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ ok: true })))
        const sw = await createSwHarness()

        for (const path of ['/api/sessions', '/api/sessions/s-1', '/api/machines']) {
            await sw.dispatchFetch(new Request(`http://hub.test${path}`, {
                headers: { authorization: `Bearer ${aliceJwt1}` }
            }))
        }

        expect(await sw.caches.has('api-sessions')).toBe(true)
        expect(await sw.caches.has('api-session-detail')).toBe(true)
        expect(await sw.caches.has('api-machines')).toBe(true)

        await sw.dispatchMessage({ type: 'CLEAR_API_CACHES' })

        expect(await sw.caches.has('api-sessions')).toBe(false)
        expect(await sw.caches.has('api-session-detail')).toBe(false)
        expect(await sw.caches.has('api-machines')).toBe(false)
    })
})
