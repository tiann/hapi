import { afterEach, describe, expect, it, vi } from 'vitest'
import { ApiClient } from './client'

function jsonResponse(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' }
    })
}

function mockFetch(handler: (url: string, init?: RequestInit) => Promise<Response>) {
    const fn = vi.fn(handler)
    vi.stubGlobal('fetch', fn)
    return fn
}

afterEach(() => {
    vi.unstubAllGlobals()
})

describe('ApiClient — Cloudflare Access auth', () => {
    it('getAuthMethods GETs /api/auth/methods same-origin with no-store', async () => {
        const fetchMock = mockFetch(async (url, init) => {
            expect(url).toBe('http://hub.test/api/auth/methods')
            expect(init?.method ?? 'GET').toBe('GET')
            expect(new Headers(init?.headers).get('cache-control')).toBe('no-store')
            return jsonResponse({ cloudflareAccess: true })
        })

        const client = new ApiClient('', { baseUrl: 'http://hub.test' })
        await expect(client.getAuthMethods()).resolves.toEqual({ cloudflareAccess: true })
        expect(fetchMock).toHaveBeenCalledTimes(1)
    })

    it('getAuthMethods throws ApiError on failure', async () => {
        mockFetch(async () => jsonResponse({ error: 'Not Found' }, 404))
        const client = new ApiClient('', { baseUrl: 'http://hub.test' })
        await expect(client.getAuthMethods()).rejects.toMatchObject({ status: 404 })
    })

    it('authenticateWithCloudflare GETs /api/auth/cloudflare and returns the AuthResponse', async () => {
        const fetchMock = mockFetch(async (url, init) => {
            expect(url).toBe('http://hub.test/api/auth/cloudflare')
            expect(init?.method ?? 'GET').toBe('GET')
            expect(new Headers(init?.headers).get('cache-control')).toBe('no-store')
            return jsonResponse({ token: 'hapi-jwt', user: { id: 1, firstName: 'Web User' } })
        })

        const client = new ApiClient('', { baseUrl: 'http://hub.test' })
        const auth = await client.authenticateWithCloudflare()
        expect(auth.token).toBe('hapi-jwt')
        expect(auth.user.firstName).toBe('Web User')
        expect(fetchMock).toHaveBeenCalledTimes(1)
    })

    it('authenticateWithCloudflare surfaces 401/403/503 as ApiError statuses', async () => {
        const client = new ApiClient('', { baseUrl: 'http://hub.test' })

        for (const status of [401, 403, 503]) {
            mockFetch(async () => jsonResponse({ error: 'nope' }, status))
            await expect(client.authenticateWithCloudflare()).rejects.toMatchObject({ status })
        }
    })

    it('authenticate still POSTs the initData/accessToken body (wire compatible)', async () => {
        const fetchMock = mockFetch(async (url, init) => {
            expect(url).toBe('http://hub.test/api/auth')
            expect(init?.method).toBe('POST')
            expect(JSON.parse(String(init?.body))).toEqual({ accessToken: 'token-1' })
            return jsonResponse({ token: 'hapi-jwt', user: { id: 1 } })
        })

        const client = new ApiClient('', { baseUrl: 'http://hub.test' })
        await expect(client.authenticate({ accessToken: 'token-1' })).resolves.toMatchObject({ token: 'hapi-jwt' })
        expect(fetchMock).toHaveBeenCalledTimes(1)
    })

    it('does not attach a bearer token to the Cloudflare auth call', async () => {
        const fetchMock = mockFetch(async (_url, init) => {
            expect(new Headers(init?.headers).has('authorization')).toBe(false)
            return jsonResponse({ token: 'hapi-jwt', user: { id: 1 } })
        })

        const client = new ApiClient('existing-token', { baseUrl: 'http://hub.test' })
        await client.authenticateWithCloudflare()
        expect(fetchMock).toHaveBeenCalledTimes(1)
    })
})
