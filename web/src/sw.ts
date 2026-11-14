/// <reference lib="webworker" />
import { precacheAndRoute } from 'workbox-precaching'
import { registerRoute } from 'workbox-routing'
import { CacheFirst, NetworkFirst } from 'workbox-strategies'
import { ExpirationPlugin } from 'workbox-expiration'
import {
    cleanupExpiredShareTransfers,
    ingestShareRequest,
    putShareTransfer,
} from './lib/shareTransfer'
import { shareTargetPathname } from './lib/sharePath'
import {
    API_CACHE_SCOPE_PARAM,
    AUTHENTICATED_API_CACHE_NAMES,
    CLEAR_API_CACHES_MESSAGE_TYPE,
    authenticatedApiCachePolicy,
    cacheJavaScriptOnly,
    hashApiCacheScope,
} from './lib/swCachePolicy'
import { focusOrOpenNotificationClient, resolveNotificationTarget } from './lib/notificationClick'

const sharePath = shareTargetPathname()

declare const self: ServiceWorkerGlobalScope & {
    __WB_MANIFEST: Array<string | { url: string; revision?: string }>
}

type PushPayload = {
    title: string
    body?: string
    icon?: string
    badge?: string
    tag?: string
    data?: {
        type?: string
        sessionId?: string
        url?: string
    }
}

// Bypass Workbox precache when explicitly re-authenticating through Cloudflare Access
// so the top-level navigation hits the Access edge instead of a cached shell.
self.addEventListener('fetch', (event) => {
    const request = event.request
    if (request.mode !== 'navigate') return
    const url = new URL(request.url)
    if (!url.searchParams.has('cf_reauth')) return
    event.respondWith(fetch(request))
})

precacheAndRoute(self.__WB_MANIFEST)

registerRoute(
    ({ url }) => url.origin === self.location.origin && /\/assets\/shiki-[^/]+\.js$/.test(url.pathname),
    new CacheFirst({
        cacheName: 'syntax-grammars',
        plugins: [
            cacheJavaScriptOnly,
            new ExpirationPlugin({ maxEntries: 64, maxAgeSeconds: 60 * 60 * 24 * 30 }),
        ],
    }),
)

const sessionsExpirationPlugin = new ExpirationPlugin({
    maxEntries: 10,
    maxAgeSeconds: 60 * 5
})

const sessionDetailExpirationPlugin = new ExpirationPlugin({
    maxEntries: 20,
    maxAgeSeconds: 60 * 5
})

const machinesExpirationPlugin = new ExpirationPlugin({
    maxEntries: 5,
    maxAgeSeconds: 60 * 10
})

const authenticatedApiCaches = [
    { name: 'api-sessions', plugin: sessionsExpirationPlugin },
    { name: 'api-session-detail', plugin: sessionDetailExpirationPlugin },
    { name: 'api-machines', plugin: machinesExpirationPlugin },
] as const

async function clearApiCachesFromServiceWorker(preserveIdentity?: string | null): Promise<void> {
    if (!preserveIdentity || typeof self.caches === 'undefined') {
        await Promise.all(authenticatedApiCaches.map(({ plugin }) => plugin.deleteCacheAndMetadata().catch(() => {})))
        if (typeof self.caches !== 'undefined') {
            await Promise.all(AUTHENTICATED_API_CACHE_NAMES.map((cacheName) => self.caches.delete(cacheName).catch(() => false)))
        }
        return
    }

    const scopeByOrigin = new Map<string, string | null>()
    await Promise.all(authenticatedApiCaches.map(async ({ name, plugin }) => {
        if (!(await self.caches.has(name).catch(() => false))) {
            await plugin.deleteCacheAndMetadata().catch(() => {})
            return
        }
        const cache = await self.caches.open(name)
        const keys = await cache.keys()
        let kept = 0
        const toDelete: Request[] = []
        for (const request of keys) {
            try {
                const url = new URL(request.url)
                let preserveScope = scopeByOrigin.get(url.origin)
                if (preserveScope === undefined) {
                    preserveScope = await hashApiCacheScope(url.origin, preserveIdentity)
                    scopeByOrigin.set(url.origin, preserveScope)
                }
                if (preserveScope && url.searchParams.get(API_CACHE_SCOPE_PARAM) === preserveScope) {
                    kept += 1
                    continue
                }
            } catch {
                // Delete malformed cache entries.
            }
            toDelete.push(request)
        }
        if (kept === 0) {
            await plugin.deleteCacheAndMetadata().catch(() => {})
            await self.caches.delete(name).catch(() => false)
        } else if (toDelete.length > 0) {
            await Promise.all(toDelete.map((request) => cache.delete(request).catch(() => false)))
        }
    }))
}

registerRoute(
    ({ url }) => url.pathname === '/api/sessions',
    new NetworkFirst({
        cacheName: 'api-sessions',
        networkTimeoutSeconds: 10,
        plugins: [
            authenticatedApiCachePolicy,
            sessionsExpirationPlugin,
        ]
    })
)

registerRoute(
    ({ url }) => /^\/api\/sessions\/[^/]+$/.test(url.pathname),
    new NetworkFirst({
        cacheName: 'api-session-detail',
        networkTimeoutSeconds: 10,
        plugins: [
            authenticatedApiCachePolicy,
            sessionDetailExpirationPlugin,
        ]
    })
)

registerRoute(
    ({ url }) => url.pathname === '/api/machines',
    new NetworkFirst({
        cacheName: 'api-machines',
        networkTimeoutSeconds: 10,
        plugins: [
            authenticatedApiCachePolicy,
            machinesExpirationPlugin,
        ]
    })
)

registerRoute(
    /^https:\/\/cdn\.socket\.io\/.*/,
    new CacheFirst({
        cacheName: 'cdn-socketio',
        plugins: [
            new ExpirationPlugin({
                maxEntries: 5,
                maxAgeSeconds: 60 * 60 * 24 * 30
            })
        ]
    })
)

registerRoute(
    /^https:\/\/telegram\.org\/.*/,
    new CacheFirst({
        cacheName: 'cdn-telegram',
        plugins: [
            new ExpirationPlugin({
                maxEntries: 5,
                maxAgeSeconds: 60 * 60 * 24 * 7
            })
        ]
    })
)

self.addEventListener('message', (event) => {
    if (event.data?.type === 'SKIP_WAITING') {
        self.skipWaiting()
    } else if (event.data?.type === CLEAR_API_CACHES_MESSAGE_TYPE) {
        const preserveIdentity = typeof event.data.preserveIdentity === 'string'
            ? event.data.preserveIdentity
            : null
        event.waitUntil?.(clearApiCachesFromServiceWorker(preserveIdentity))
    }
})

self.addEventListener('activate', (event) => {
    event.waitUntil(self.clients.claim())
})

self.addEventListener('push', (event) => {
    const payload = event.data?.json() as PushPayload | undefined
    if (!payload) {
        return
    }

    const title = payload.title || 'HAPI'
    const body = payload.body ?? ''
    const icon = payload.icon ?? '/pwa-192x192.png'
    const badge = payload.badge ?? '/pwa-64x64.png'
    const data = payload.data
    const tag = payload.tag

    event.waitUntil(
        self.registration.showNotification(title, {
            body,
            icon,
            badge,
            data,
            tag
        })
    )
})

self.addEventListener('notificationclick', (event) => {
    event.notification.close()
    const data = event.notification.data as { url?: string } | undefined
    const url = resolveNotificationTarget(data?.url, self.registration.scope)
    event.waitUntil(focusOrOpenNotificationClient(self.clients, url, self.registration.scope))
})

// Web Share Target — manifest declares POST /share, Android Chrome posts a
// multipart form with title/text/url/files. Stash in IDB so the SPA route
// can read it after the 303 redirect (which converts POST -> GET).
self.addEventListener('fetch', (event) => {
    const request = event.request
    if (request.method !== 'POST') return
    const url = new URL(request.url)
    if (url.pathname !== sharePath) return

    event.respondWith(handleShareTarget(request))
})

async function handleShareTarget(request: Request): Promise<Response> {
    // Resolve to absolute URLs because Response.redirect throws on relative
    // input per the Fetch spec; Chrome currently tolerates relative paths
    // but the SW spec is explicit and the cost of resolving is one line.
    const origin = self.location.origin
    try {
        const { redirectTo } = await ingestShareRequest(request, { put: putShareTransfer })
        return Response.redirect(new URL(redirectTo, origin).toString(), 303)
    } catch (error) {
        // Surface a minimal page if IDB write fails — don't 5xx silently or
        // the user gets a Chrome error sheet instead of useful UI.
        console.error('share-target ingest failed', error)
        return Response.redirect(new URL(`${sharePath}?error=ingest`, origin).toString(), 303)
    }
}

// Best-effort GC for stale share transfers (TTL-only — never blocks
// anything else). 1h TTL is set in shareTransfer.ts.
self.addEventListener('activate', (event) => {
    event.waitUntil(
        cleanupExpiredShareTransfers().catch((error) => {
            console.warn('share-transfer cleanup failed', error)
        })
    )
})
