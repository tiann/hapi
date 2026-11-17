import { decodeJwtIdentityKey } from './authIdentity'

export const AUTHENTICATED_API_CACHE_NAMES = [
    'api-sessions',
    'api-session-detail',
    'api-machines',
] as const

export const CLEAR_API_CACHES_MESSAGE_TYPE = 'CLEAR_API_CACHES'

export const API_CACHE_SCOPE_PARAM = '__hapi_sw_scope'
const UNAUTHENTICATED_SCOPE_PARAM = '__hapi_sw_unauth'

/**
 * Fetch makes a service-worker response with redirect history a network error for
 * non-`follow` requests, so redirected 200s are re-wrapped when stored and when served.
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

export async function hashApiCacheScope(origin: string, identityKey: string): Promise<string | null> {
    const subtle = globalThis.crypto?.subtle
    if (!subtle) {
        return null
    }
    const raw = JSON.stringify([origin, identityKey])
    const bytes = new TextEncoder().encode(raw)
    const digest = await subtle.digest('SHA-256', bytes)
    return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')
}

function unauthenticatedNonce(): string {
    if (typeof globalThis.crypto?.randomUUID === 'function') {
        return globalThis.crypto.randomUUID()
    }
    return `${Date.now()}-${Math.random().toString(36).slice(2)}`
}

/**
 * Partition authenticated API caches by hub origin and JWT identity, failing
 * closed when a request lacks a valid authenticated Bearer identity.
 */
export const authenticatedApiCachePolicy = {
    cacheKeyWillBeUsed: async ({ request }: { request: Request }): Promise<string> => {
        const url = new URL(request.url)
        url.hash = ''
        url.searchParams.delete(API_CACHE_SCOPE_PARAM)
        url.searchParams.delete(UNAUTHENTICATED_SCOPE_PARAM)
        const identityKey = extractAuthenticatedIdentityKey(request)
        const scope = identityKey ? await hashApiCacheScope(url.origin, identityKey) : null
        if (!scope) {
            url.searchParams.set(UNAUTHENTICATED_SCOPE_PARAM, unauthenticatedNonce())
            return url.toString()
        }
        url.searchParams.set(API_CACHE_SCOPE_PARAM, scope)
        return url.toString()
    },
    cacheWillUpdate: async (
        { request, response }: { request: Request; response: Response }
    ): Promise<Response | null> => {
        if (response.status !== 200) {
            return null
        }
        if (!globalThis.crypto?.subtle || !extractAuthenticatedIdentityKey(request)) {
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
            if (!url.searchParams.get(API_CACHE_SCOPE_PARAM) || url.searchParams.has(UNAUTHENTICATED_SCOPE_PARAM)) {
                return null
            }
        } catch {
            return null
        }
        return await withoutRedirectHistory(cachedResponse)
    },
}

/** Clear authenticated API caches once via the active SW controller, falling back to CacheStorage. */
export async function clearAuthenticatedApiCaches(preserveIdentity?: string | null): Promise<void> {
    if (typeof navigator !== 'undefined' && navigator.serviceWorker?.controller) {
        try {
            navigator.serviceWorker.controller.postMessage({
                type: CLEAR_API_CACHES_MESSAGE_TYPE,
                ...(preserveIdentity ? { preserveIdentity } : {}),
            })
            return
        } catch {
            // Fall back to direct CacheStorage deletion when postMessage fails.
        }
    }
    if (typeof caches !== 'undefined') {
        await Promise.all(
            AUTHENTICATED_API_CACHE_NAMES.map((cacheName) => caches.delete(cacheName).catch(() => false))
        )
    }
}

/** Never cache an SSO login page or redirect in place of a syntax module. */
export const cacheJavaScriptOnly = {
    cacheWillUpdate: async ({ response }: { response: Response }): Promise<Response | null> =>
        response.status === 200 && !response.redirected
        && /^(?:text|application)\/(?:javascript|ecmascript)(?:;|$)/i.test(response.headers.get('content-type') ?? '')
            ? response : null,
}
