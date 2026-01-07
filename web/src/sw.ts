/// <reference lib="webworker" />
import { precacheAndRoute } from 'workbox-precaching'
import { registerRoute } from 'workbox-routing'
import { CacheFirst, NetworkFirst } from 'workbox-strategies'
import { ExpirationPlugin } from 'workbox-expiration'

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

type NotificationPreferences = {
    permissions: boolean
    questions: boolean
    ready: boolean
    errors: boolean
}

const PREFERENCES_CACHE_NAME = 'notification-preferences'
const PREFERENCES_KEY = 'preferences.json'

async function getNotificationPreferences(): Promise<NotificationPreferences> {
    const defaultPrefs: NotificationPreferences = {
        permissions: true,
        questions: true,
        ready: true,
        errors: true
    }

    try {
        const cache = await caches.open(PREFERENCES_CACHE_NAME)
        const response = await cache.match(PREFERENCES_KEY)
        if (!response) {
            return defaultPrefs
        }
        const prefs = await response.json()
        return { ...defaultPrefs, ...prefs }
    } catch {
        return defaultPrefs
    }
}

function getPreferenceKeyForType(type: string | undefined): keyof NotificationPreferences | null {
    switch (type) {
        case 'permission-request':
            return 'permissions'
        case 'question':
            return 'questions'
        case 'ready':
            return 'ready'
        case 'error':
            return 'errors'
        default:
            return null
    }
}

precacheAndRoute(self.__WB_MANIFEST)

registerRoute(
    ({ url }) => url.pathname === '/api/sessions',
    new NetworkFirst({
        cacheName: 'api-sessions',
        networkTimeoutSeconds: 10,
        plugins: [
            new ExpirationPlugin({
                maxEntries: 10,
                maxAgeSeconds: 60 * 5
            })
        ]
    })
)

registerRoute(
    ({ url }) => /^\/api\/sessions\/[^/]+$/.test(url.pathname),
    new NetworkFirst({
        cacheName: 'api-session-detail',
        networkTimeoutSeconds: 10,
        plugins: [
            new ExpirationPlugin({
                maxEntries: 20,
                maxAgeSeconds: 60 * 5
            })
        ]
    })
)

registerRoute(
    ({ url }) => url.pathname === '/api/machines',
    new NetworkFirst({
        cacheName: 'api-machines',
        networkTimeoutSeconds: 10,
        plugins: [
            new ExpirationPlugin({
                maxEntries: 5,
                maxAgeSeconds: 60 * 10
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

    event.waitUntil(
        (async () => {
            // Check if this notification type is enabled
            const notificationType = payload.data?.type
            const preferenceKey = getPreferenceKeyForType(notificationType)

            if (preferenceKey) {
                const prefs = await getNotificationPreferences()
                if (!prefs[preferenceKey]) {
                    // User has disabled this notification type
                    return
                }
            }

            const title = payload.title || 'HAPImatic'
            const body = payload.body ?? ''
            const icon = payload.icon ?? '/pwa-192x192.png'
            const badge = payload.badge ?? '/pwa-64x64.png'
            const data = payload.data
            const tag = payload.tag

            await self.registration.showNotification(title, {
                body,
                icon,
                badge,
                data,
                tag
            })
        })()
    )
})

self.addEventListener('notificationclick', (event) => {
    event.notification.close()
    const data = event.notification.data as { url?: string } | undefined
    const url = data?.url ?? '/'
    event.waitUntil(self.clients.openWindow(url))
})
