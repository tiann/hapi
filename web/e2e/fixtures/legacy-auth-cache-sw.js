self.addEventListener('install', () => {
    void self.skipWaiting()
})

self.addEventListener('activate', (event) => {
    event.waitUntil(self.clients.claim())
})

self.addEventListener('fetch', (event) => {
    const url = new URL(event.request.url)
    if (event.request.method !== 'GET' || url.pathname !== '/e2e/fixtures/api/sessions') {
        return
    }

    event.respondWith((async () => {
        const cache = await caches.open('api-sessions')
        try {
            const response = await fetch(event.request)
            await cache.put(event.request, response.clone())
            return response
        } catch (error) {
            const cached = await cache.match(event.request)
            if (cached) return cached
            throw error
        }
    })())
})
