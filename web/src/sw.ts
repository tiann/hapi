/// <reference lib="webworker" />
import { precacheAndRoute } from 'workbox-precaching'
import { registerRoute } from 'workbox-routing'
import { CacheFirst } from 'workbox-strategies'
import { ExpirationPlugin } from 'workbox-expiration'
import { focusOrOpenNotificationUrl, type NotificationClientsLike } from './lib/notificationClick'
import { getBadgeCountFromPushPayload, updateAppBadge, type AppBadgeTarget } from './lib/appBadge'
import { buildNotificationOptions, shouldShowPushNotification, type PushPayload } from './lib/pushNotification'
import {
    hasLegacyAuthenticatedApiCaches,
    removeLegacyAuthenticatedApiCaches,
} from './lib/serviceWorkerCachePolicy'

declare const self: ServiceWorkerGlobalScope & {
    __WB_MANIFEST: Array<string | { url: string; revision?: string }>
}

self.addEventListener('install', (event) => {
    // This release removes caches that were keyed only by URL even though they
    // held authenticated responses. If one exists, do not let a declined
    // ordinary update prompt leave the legacy worker serving it indefinitely.
    event.waitUntil(hasLegacyAuthenticatedApiCaches(self.caches).then(async (mustMigrate) => {
        if (mustMigrate) await self.skipWaiting()
    }))
})

self.addEventListener('message', (event) => {
    if (event.data && typeof event.data === 'object' && event.data.type === 'SKIP_WAITING') {
        self.skipWaiting()
    }
})

self.addEventListener('activate', (event) => {
    event.waitUntil(Promise.all([
        removeLegacyAuthenticatedApiCaches(self.caches),
        self.clients.claim(),
    ]).then(() => undefined))
})

precacheAndRoute(self.__WB_MANIFEST)

registerRoute(
    ({ url, request }) => url.origin === self.location.origin
        && url.pathname.startsWith('/assets/')
        && request.method === 'GET',
    new CacheFirst({
        cacheName: 'local-assets',
        plugins: [
            new ExpirationPlugin({
                maxEntries: 80,
                maxAgeSeconds: 60 * 60 * 24 * 30
            })
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

self.addEventListener('push', (event) => {
    const payload = event.data?.json() as PushPayload | undefined
    if (!payload) {
        return
    }

    const title = payload.title || 'HAPI'
    const badgeCount = getBadgeCountFromPushPayload(payload)

    event.waitUntil(
        Promise.all([
            updateAppBadge(navigator as unknown as AppBadgeTarget, badgeCount),
            shouldShowPushNotification(self.clients).then((shouldShow) => (
                shouldShow
                    ? self.registration.showNotification(title, buildNotificationOptions(payload))
                    : undefined
            ))
        ]).then(() => undefined)
    )
})

self.addEventListener('notificationclick', (event) => {
    event.notification.close()
    const data = event.notification.data as { url?: string } | undefined
    const url = data?.url ?? '/'
    event.waitUntil(focusOrOpenNotificationUrl(self.clients as unknown as NotificationClientsLike, url))
})
