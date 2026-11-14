import { decodeJwtIdentityKey } from './authIdentity'

export const AUTHENTICATED_API_CACHE_NAMES = [
    'api-sessions',
    'api-session-detail',
    'api-machines',
] as const

export const CLEAR_API_CACHES_MESSAGE_TYPE = 'CLEAR_API_CACHES'

const CACHE_SCOPE_PARAM = '__hapi_sw_scope'
const UNAUTHENTICATED_SCOPE_PARAM = '__hapi_sw_unauth'

/**
 * Runtime-cache policy for the API routes, which receive `redirect: 'manual'` requests.
 * - NetworkFirst caches status 0 by default, so a gateway's opaqueredirect would overwrite
 *   the last good JSON. Only 200s are stored.
 * - Fetch makes a service-worker response with redirect history a network error for
 *   non-`follow` requests, so redirected 200s are re-wrapped when stored and when served.
 */
async function withoutRedirectHistory(response: Response): Promise<Response> {
    if (!response.redirected) {
        return response
    }
    return new Response(await response.arrayBuffer(), {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
    })
}

export function extractBearerToken(request: Request): string | null {
    const authHeader = request.headers.get('authorization')
    if (!authHeader) {
        return null
    }
    const match = authHeader.trim().match(/^Bearer\s+(\S+)$/i)
    return match?.[1] ?? null
}

export function extractAuthenticatedIdentityKey(request: Request): string | null {
    const token = extractBearerToken(request)
    if (!token) {
        return null
    }
    return decodeJwtIdentityKey(token)
}

function fallbackScopeHash(input: string): string {
    let h1 = 0x811c9dc5
    let h2 = 0x9e3779b1
    for (let i = 0; i < input.length; i += 1) {
        const code = input.charCodeAt(i)
        h1 ^= code
        h1 = Math.imul(h1, 0x01000193)
        h2 ^= code + i
        h2 = Math.imul(h2, 0x85ebca6b)
    }
    return `${(h1 >>> 0).toString(16).padStart(8, '0')}${(h2 >>> 0).toString(16).padStart(8, '0')}`
}

async function hashCacheScope(origin: string, identityKey: string): Promise<string> {
    const raw = JSON.stringify([origin, identityKey])
    const subtle = globalThis.crypto?.subtle
    if (subtle) {
        const bytes = new TextEncoder().encode(raw)
        const digest = await subtle.digest('SHA-256', bytes)
        return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')
    }
    return fallbackScopeHash(raw)
}

function unauthenticatedNonce(): string {
    if (typeof globalThis.crypto?.randomUUID === 'function') {
        return globalThis.crypto.randomUUID()
    }
    return `${Date.now()}-${Math.random().toString(36).slice(2)}`
}

export const cacheOkResponsesOnly = {
    cacheWillUpdate: async ({ response }: { response: Response }): Promise<Response | null> =>
        response.status === 200 ? await withoutRedirectHistory(response) : null,
    cachedResponseWillBeUsed: async (
        { cachedResponse }: { cachedResponse?: Response }
    ): Promise<Response | null> =>
        cachedResponse ? await withoutRedirectHistory(cachedResponse) : null,
}

/**
 * Partition authenticated API caches by hub origin and JWT identity, failing
 * closed when a request lacks a valid authenticated Bearer identity.
 */
export const authenticatedApiCachePolicy = {
    cacheKeyWillBeUsed: async ({ request }: { request: Request }): Promise<string> => {
        const url = new URL(request.url)
        url.hash = ''
        url.searchParams.delete(CACHE_SCOPE_PARAM)
        url.searchParams.delete(UNAUTHENTICATED_SCOPE_PARAM)
        const identityKey = extractAuthenticatedIdentityKey(request)
        if (!identityKey) {
            url.searchParams.set(UNAUTHENTICATED_SCOPE_PARAM, unauthenticatedNonce())
            return url.toString()
        }
        const scope = await hashCacheScope(url.origin, identityKey)
        url.searchParams.set(CACHE_SCOPE_PARAM, scope)
        return url.toString()
    },
    cacheWillUpdate: async (
        { request, response }: { request: Request; response: Response }
    ): Promise<Response | null> => {
        if (response.status !== 200) {
            return null
        }
        if (!extractAuthenticatedIdentityKey(request)) {
            return null
        }
        return await withoutRedirectHistory(response)
    },
    cachedResponseWillBeUsed: async (
        { request, cachedResponse }: { request: Request; cachedResponse?: Response }
    ): Promise<Response | null> => {
        if (!cachedResponse) {
            return null
        }
        try {
            const url = new URL(request.url)
            if (!url.searchParams.get(CACHE_SCOPE_PARAM) || url.searchParams.has(UNAUTHENTICATED_SCOPE_PARAM)) {
                return null
            }
        } catch {
            return null
        }
        return await withoutRedirectHistory(cachedResponse)
    },
}

/** Delete all authenticated API caches from CacheStorage and ask the active SW to purge metadata. */
export async function clearAuthenticatedApiCaches(): Promise<void> {
    if (typeof caches !== 'undefined') {
        await Promise.all(
            AUTHENTICATED_API_CACHE_NAMES.map((cacheName) => caches.delete(cacheName).catch(() => false))
        )
    }
    if (typeof navigator !== 'undefined' && navigator.serviceWorker?.controller) {
        try {
            navigator.serviceWorker.controller.postMessage({ type: CLEAR_API_CACHES_MESSAGE_TYPE })
        } catch {
            // Ignore postMessage errors when the controller is unavailable.
        }
    }
}

/** Never cache an SSO login page or redirect in place of a syntax module. */
export const cacheJavaScriptOnly = {
    cacheWillUpdate: async ({ response }: { response: Response }): Promise<Response | null> =>
        response.status === 200 && !response.redirected
        && /^(?:text|application)\/(?:javascript|ecmascript)(?:;|$)/i.test(response.headers.get('content-type') ?? '')
            ? response : null,
}
