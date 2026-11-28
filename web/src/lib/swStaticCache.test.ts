import { describe, expect, it, vi } from 'vitest'
import {
    CLEANUP_OUTDATED_CACHES_MESSAGE,
    HUB_WEB_BUILD_STORAGE_KEY,
    STATIC_CACHE_VERSION_STORAGE_KEY,
    cleanupClientStaticCachesOnVersionChange,
    cleanupOutdatedStaticCaches,
    computeStaticCacheVersion,
    fetchPublicHubHealth,
    getHapiStaticCacheName,
    getSafeCacheStorage,
    getSafeLocalStorage,
    getSyntaxGrammarsCacheName,
    isOutdatedStaticCacheName,
    recordHubWebBuildId,
    shouldCheckSwUpdateForHubHealth,
} from './swStaticCache'

function createMemoryStorage(initial: Record<string, string> = {}): Pick<Storage, 'getItem' | 'setItem'> {
    const map = new Map(Object.entries(initial))
    return {
        getItem: (key) => map.get(key) ?? null,
        setItem: (key, value) => {
            map.set(key, value)
        },
    }
}

function createFakeCacheStorage(
    initialKeys: string[],
    legacyEntries: Record<string, string[]> = {},
) {
    const keys = new Set(initialKeys)
    const deleted: string[] = []
    const cacheEntries = new Map<string, Set<string>>(
        Object.entries(legacyEntries).map(([name, urls]) => [name, new Set(urls)]),
    )
    return {
        keys: vi.fn(async () => [...keys]),
        delete: vi.fn(async (key: string) => {
            const existed = keys.delete(key)
            if (existed) {
                deleted.push(key)
                cacheEntries.delete(key)
            }
            return existed
        }),
        open: vi.fn(async (name: string) => {
            const entries = cacheEntries.get(name) ?? new Set<string>()
            return {
                keys: vi.fn(async () => [...entries].map((url) => ({ url } as Request))),
                delete: vi.fn(async (req: RequestInfo | URL) => {
                    const url = typeof req === 'string' ? req : req instanceof URL ? req.href : req.url
                    return entries.delete(url)
                }),
                put: vi.fn(async (req: RequestInfo | URL) => {
                    const url = typeof req === 'string' ? req : req instanceof URL ? req.href : req.url
                    cacheEntries.set(name, entries)
                    keys.add(name)
                    entries.add(url)
                }),
            }
        }),
        remainingEntries: (name: string) => [...(cacheEntries.get(name) ?? [])],
        remaining: () => [...keys],
        deleted,
    }
}

describe('computeStaticCacheVersion', () => {
    it('returns appVersion when manifest is empty or omitted', () => {
        expect(computeStaticCacheVersion('0.36.5')).toBe('0.36.5')
        expect(computeStaticCacheVersion('0.36.5', [])).toBe('0.36.5')
    })

    it('produces a deterministic version-and-manifest token regardless of entry order', () => {
        const a = computeStaticCacheVersion('0.36.5', [
            { url: 'index.html', revision: 'abc' },
            { url: 'assets/index-123.js', revision: null },
        ])
        const b = computeStaticCacheVersion('0.36.5', [
            { url: 'assets/index-123.js', revision: null },
            { url: 'index.html', revision: 'abc' },
        ])
        const c = computeStaticCacheVersion('0.36.6', [
            { url: 'index.html', revision: 'abc' },
            { url: 'assets/index-123.js', revision: null },
        ])
        const d = computeStaticCacheVersion('0.36.5', [
            { url: 'index.html', revision: 'def' },
            { url: 'assets/index-123.js', revision: null },
        ])

        expect(a).toBe(b)
        expect(a).toMatch(/^0\.36\.5-[0-9a-f]{8}$/)
        expect(c).not.toBe(a)
        expect(d).not.toBe(a)
    })
})

describe('isOutdatedStaticCacheName and cleanupOutdatedStaticCaches', () => {
    it('deletes outdated caches only for the owning HAPI deployment scope and preserves sibling deployments', async () => {
        const scopeA = 'https://example.com/'
        const scopeB = 'https://example.com/hapi-preview/'
        const currentVersion = '0.36.5-1234abcd'
        const currentSyntaxA = getSyntaxGrammarsCacheName(currentVersion, scopeA)
        const currentStaticA = getHapiStaticCacheName(currentVersion, scopeA)
        const oldSyntaxA = getSyntaxGrammarsCacheName('0.36.4-deadbeef', scopeA)
        const oldStaticA = getHapiStaticCacheName('0.36.4-deadbeef', scopeA)
        const siblingSyntaxB = getSyntaxGrammarsCacheName('0.36.4-deadbeef', scopeB)

        const cacheStorage = createFakeCacheStorage(
            [
                'syntax-grammars',
                oldSyntaxA,
                currentSyntaxA,
                oldStaticA,
                currentStaticA,
                siblingSyntaxB,
                `workbox-precache-v2-${scopeA}`,
                'api-sessions',
                'cdn-socketio',
                'unrelated-cache',
            ],
            {
                'syntax-grammars': [
                    `${scopeA}assets/shiki-ts-old.js`,
                    `${scopeB}assets/shiki-ts-other.js`,
                ],
            },
        )

        const clearExpiration = vi.fn()
        const migrateGrammars = vi.fn()
        const deleted = await cleanupOutdatedStaticCaches(cacheStorage, currentVersion, {
            scope: scopeA, clearExpiration, migrateGrammars,
        })

        expect(clearExpiration.mock.calls).toEqual([[oldSyntaxA]])
        expect(migrateGrammars).toHaveBeenCalledWith('syntax-grammars', [{ url: `${scopeA}assets/shiki-ts-old.js` }])
        expect(deleted).toEqual([
            oldSyntaxA,
            oldStaticA,
        ])
        expect(cacheStorage.remainingEntries('syntax-grammars')).toEqual([
            `${scopeB}assets/shiki-ts-other.js`,
        ])
        expect(cacheStorage.remaining()).toEqual([
            'syntax-grammars',
            currentSyntaxA,
            currentStaticA,
            siblingSyntaxB,
            `workbox-precache-v2-${scopeA}`,
            'api-sessions',
            'cdn-socketio',
            'unrelated-cache',
        ])
    })

    it('preserves concurrent writes from a sibling legacy worker to syntax-grammars while migrating scoped entries', async () => {
        const rootScope = 'https://example.com/'
        const previewScope = 'https://example.com/preview/'
        const cacheStorage = createFakeCacheStorage(
            ['syntax-grammars'],
            {
                'syntax-grammars': [`${rootScope}assets/shiki-c-old.js`],
            },
        )

        const clearExpiration = vi.fn()
        const deleted = await cleanupOutdatedStaticCaches(cacheStorage, '0.36.5-1234abcd', {
            scope: rootScope,
            clearExpiration,
            async migrateGrammars() {
                // Simulate an older worker at /preview/ caching a grammar after the snapshot was taken.
                const legacyCache = await cacheStorage.open('syntax-grammars')
                await legacyCache.put(`${previewScope}assets/shiki-preview.js`)
            },
        })

        expect(deleted).toEqual([])
        expect(clearExpiration).not.toHaveBeenCalled()
        expect(cacheStorage.remaining()).toEqual(['syntax-grammars'])
        expect(cacheStorage.remainingEntries('syntax-grammars')).toEqual([
            `${previewScope}assets/shiki-preview.js`,
        ])
    })

    it('deletes exact-scope legacy Workbox precaches without touching sibling subpath apps', async () => {
        const currentVersion = '0.36.5-1234abcd'
        const cacheStorage = createFakeCacheStorage([
            'workbox-precache-https://example.com/',
            'workbox-precache-v1-https://example.com/',
            'workbox-precache-v2-https://example.com/',
            'workbox-precache-v2-https://example.com/tools/',
            'workbox-precache-v1-https://example.com/tools/',
        ])

        const deleted = await cleanupOutdatedStaticCaches(cacheStorage, currentVersion, {
            scope: 'https://example.com/',
        })

        expect(deleted).toEqual([
            'workbox-precache-https://example.com/',
            'workbox-precache-v1-https://example.com/',
        ])
        expect(cacheStorage.remaining()).toEqual([
            'workbox-precache-v2-https://example.com/',
            'workbox-precache-v2-https://example.com/tools/',
            'workbox-precache-v1-https://example.com/tools/',
        ])
    })

    it('preserves active manifest-hashed caches for the current appVersion in prefix-only mode', () => {
        expect(isOutdatedStaticCacheName('syntax-grammars', '0.36.5', { matchPrefixOnly: true })).toBe(true)
        expect(isOutdatedStaticCacheName('syntax-grammars-0.36.4-abcd1234', '0.36.5', { matchPrefixOnly: true })).toBe(true)
        expect(isOutdatedStaticCacheName('syntax-grammars-0.36.5-abcd1234', '0.36.5', { matchPrefixOnly: true })).toBe(false)
        expect(isOutdatedStaticCacheName('syntax-grammars-12345678-0.36.5-abcd1234', '0.36.5', { matchPrefixOnly: true })).toBe(false)
        expect(isOutdatedStaticCacheName('syntax-grammars-12345678-0.36.4-abcd1234', '0.36.5', { matchPrefixOnly: true })).toBe(true)
        expect(isOutdatedStaticCacheName('syntax-grammars-0.36.50-abcd1234', '0.36.5', { matchPrefixOnly: true })).toBe(true)
    })
})

describe('cleanupClientStaticCachesOnVersionChange', () => {
    it('skips cleanup when stored version matches appVersion', async () => {
        const storage = createMemoryStorage({ [STATIC_CACHE_VERSION_STORAGE_KEY]: '0.36.5' })
        const cacheStorage = createFakeCacheStorage(['syntax-grammars'])

        const result = await cleanupClientStaticCachesOnVersionChange({
            appVersion: '0.36.5',
            storage,
            cacheStorage,
        })

        expect(result).toEqual({ versionChanged: false, deletedCaches: [], delegatedToWorker: false })
        expect(cacheStorage.delete).not.toHaveBeenCalled()
    })

    it('delegates to the controlling service worker without deleting caches directly when an older worker is active', async () => {
        const storage = createMemoryStorage({ [STATIC_CACHE_VERSION_STORAGE_KEY]: '0.36.4' })
        const cacheStorage = createFakeCacheStorage([
            'syntax-grammars',
            'syntax-grammars-0.36.4-11112222',
        ])
        const postMessage = vi.fn()
        const serviceWorker = {
            controller: { postMessage } as unknown as ServiceWorker,
            getRegistration: vi.fn(),
        }

        const result = await cleanupClientStaticCachesOnVersionChange({
            appVersion: '0.36.5',
            storage,
            cacheStorage,
            serviceWorker,
        })

        expect(result).toEqual({
            versionChanged: true,
            deletedCaches: [],
            delegatedToWorker: true,
        })
        expect(postMessage).toHaveBeenCalledWith({ type: CLEANUP_OUTDATED_CACHES_MESSAGE })
        expect(cacheStorage.delete).not.toHaveBeenCalled()
        expect(storage.getItem(STATIC_CACHE_VERSION_STORAGE_KEY)).toBe('0.36.4')
    })

    it('cleans outdated static caches directly while preserving grammar caches for replacement worker migration', async () => {
        const scopeA = 'https://example.com/'
        const scopeB = 'https://example.com/hapi-preview/'
        const oldStaticCacheA = getHapiStaticCacheName('0.36.4-11112222', scopeA)
        const currentStaticCacheA = getHapiStaticCacheName('0.36.5-33334444', scopeA)
        const siblingStaticCacheB = getHapiStaticCacheName('0.36.4-11112222', scopeB)
        const oldSyntaxCacheA = getSyntaxGrammarsCacheName('0.36.4-11112222', scopeA)
        const currentSyntaxCacheA = getSyntaxGrammarsCacheName('0.36.5-33334444', scopeA)
        const storage = createMemoryStorage({ [STATIC_CACHE_VERSION_STORAGE_KEY]: '0.36.4' })
        const cacheStorage = createFakeCacheStorage(
            [
                'syntax-grammars',
                oldStaticCacheA,
                currentStaticCacheA,
                siblingStaticCacheB,
                oldSyntaxCacheA,
                `workbox-precache-v1-${scopeA}`,
                `workbox-precache-v1-${scopeB}`,
                'api-sessions',
            ],
            {
                'syntax-grammars': [
                    `${scopeA}assets/shiki-ts.js`,
                    `${scopeB}assets/shiki-other.js`,
                ],
                [oldSyntaxCacheA]: [
                    `${scopeA}assets/shiki-ts.js`,
                    `${scopeA}assets/shiki-removed.js`,
                ],
            },
        )
        const serviceWorker = {
            controller: null,
            getRegistration: vi.fn(async () => undefined),
        }

        const result = await cleanupClientStaticCachesOnVersionChange({
            appVersion: '0.36.5',
            scope: scopeA,
            storage,
            cacheStorage,
            serviceWorker,
        })

        expect(result).toEqual({
            versionChanged: true,
            deletedCaches: [oldStaticCacheA, `workbox-precache-v1-${scopeA}`],
            delegatedToWorker: false,
        })
        expect(storage.getItem(STATIC_CACHE_VERSION_STORAGE_KEY)).toBe('0.36.5')
        // Grammar caches remain intact until a replacement SW activates and migrates reusable entries.
        expect(cacheStorage.remainingEntries('syntax-grammars')).toEqual([
            `${scopeA}assets/shiki-ts.js`,
            `${scopeB}assets/shiki-other.js`,
        ])
        expect(cacheStorage.remainingEntries(oldSyntaxCacheA)).toEqual([
            `${scopeA}assets/shiki-ts.js`,
            `${scopeA}assets/shiki-removed.js`,
        ])

        // Simulate the replacement SW activating with the new build manifest and migrating reusable grammars.
        const reusableUrls = new Set([`${scopeA}assets/shiki-ts.js`])
        await cleanupOutdatedStaticCaches(cacheStorage, '0.36.5-33334444', {
            scope: scopeA,
            async migrateGrammars(name, requests) {
                const source = await cacheStorage.open(name)
                const destination = await cacheStorage.open(currentSyntaxCacheA)
                for (const request of requests) {
                    if (!reusableUrls.has(request.url)) continue
                    await destination.put(request)
                }
                void source
            },
        })

        expect(cacheStorage.remainingEntries(currentSyntaxCacheA)).toEqual([`${scopeA}assets/shiki-ts.js`])
        expect(cacheStorage.remainingEntries('syntax-grammars')).toEqual([`${scopeB}assets/shiki-other.js`])
        expect(cacheStorage.remaining()).not.toContain(oldSyntaxCacheA)
        expect(cacheStorage.remaining()).toContain(siblingStaticCacheB)
        expect(cacheStorage.remaining()).toContain(`workbox-precache-v1-${scopeB}`)
        expect(cacheStorage.remaining()).toContain('api-sessions')
    })
})

describe('safe storage/cache getters', () => {
    it('returns null/undefined when window.localStorage or window.caches getters throw SecurityError', () => {
        const origLocalStorage = Object.getOwnPropertyDescriptor(window, 'localStorage')
        const origCaches = Object.getOwnPropertyDescriptor(window, 'caches')
        try {
            Object.defineProperty(window, 'localStorage', {
                configurable: true,
                get() {
                    throw new DOMException('Access denied', 'SecurityError')
                },
            })
            Object.defineProperty(window, 'caches', {
                configurable: true,
                get() {
                    throw new DOMException('Access denied', 'SecurityError')
                },
            })

            expect(getSafeLocalStorage()).toBeNull()
            expect(getSafeCacheStorage()).toBeUndefined()
        } finally {
            if (origLocalStorage) Object.defineProperty(window, 'localStorage', origLocalStorage)
            if (origCaches) Object.defineProperty(window, 'caches', origCaches)
        }
    })
})

describe('shouldCheckSwUpdateForHubHealth and recordHubWebBuildId', () => {
    it('returns true when same-origin hub version differs from appVersion without mutating stored buildId before confirmation', () => {
        const storage = createMemoryStorage({ [HUB_WEB_BUILD_STORAGE_KEY]: 'build-1' })
        expect(shouldCheckSwUpdateForHubHealth({
            baseUrl: 'https://hapi.example',
            windowOrigin: 'https://hapi.example',
            appVersion: '0.36.5',
            health: { version: '0.36.6', webBuildId: 'build-2' },
            storage,
        })).toBe(true)
        expect(storage.getItem(HUB_WEB_BUILD_STORAGE_KEY)).toBe('build-1')
    })

    it('keeps previous webBuildId pending until recordHubWebBuildId runs so failed checks can retry', () => {
        const storage = createMemoryStorage({ [HUB_WEB_BUILD_STORAGE_KEY]: 'build-1' })
        const params = {
            baseUrl: '',
            windowOrigin: 'https://hapi.example',
            appVersion: '0.36.5',
            health: { version: '0.36.5', webBuildId: 'build-2' },
            storage,
        }

        // First check signals update without overwriting build-1
        expect(shouldCheckSwUpdateForHubHealth(params)).toBe(true)
        expect(storage.getItem(HUB_WEB_BUILD_STORAGE_KEY)).toBe('build-1')

        // If update check failed, subsequent health check still retries
        expect(shouldCheckSwUpdateForHubHealth(params)).toBe(true)

        // Once update check succeeds, build-2 is persisted and further checks are skipped
        recordHubWebBuildId(storage, 'build-2')
        expect(storage.getItem(HUB_WEB_BUILD_STORAGE_KEY)).toBe('build-2')
        expect(shouldCheckSwUpdateForHubHealth(params)).toBe(false)
    })

    it('triggers an update check when no previous webBuildId baseline is stored before recording the observed build', () => {
        const storage = createMemoryStorage()
        const params = {
            baseUrl: '',
            windowOrigin: 'https://hapi.example',
            appVersion: '0.36.5',
            health: { version: '0.36.5', webBuildId: 'build-initial' },
            storage,
        }

        expect(shouldCheckSwUpdateForHubHealth(params)).toBe(true)
        expect(storage.getItem(HUB_WEB_BUILD_STORAGE_KEY)).toBeNull()

        recordHubWebBuildId(storage, 'build-initial')
        expect(storage.getItem(HUB_WEB_BUILD_STORAGE_KEY)).toBe('build-initial')
        expect(shouldCheckSwUpdateForHubHealth(params)).toBe(false)
    })

    it('ignores version differences on cross-origin hubs (e.g. GitHub Pages)', () => {
        const storage = createMemoryStorage({ [HUB_WEB_BUILD_STORAGE_KEY]: 'build-1' })
        expect(shouldCheckSwUpdateForHubHealth({
            baseUrl: 'https://hub.other.example',
            windowOrigin: 'https://tiann.github.io',
            appVersion: '0.36.5',
            health: { version: '0.36.6', webBuildId: 'build-2' },
            storage,
        })).toBe(false)
    })
})

describe('fetchPublicHubHealth', () => {
    it('fetches unauthenticated /health with no-store for same-origin hubs', async () => {
        const fetchMock = vi.fn(async () => new Response(JSON.stringify({
            status: 'ok',
            version: '0.36.6',
            webBuildId: 'build-2',
        }), { status: 200 }))

        const health = await fetchPublicHubHealth({
            baseUrl: '',
            windowOrigin: 'https://hapi.example',
            fetchImpl: fetchMock,
        })

        expect(fetchMock).toHaveBeenCalledWith('/health', { cache: 'no-store' })
        expect(health).toEqual({
            status: 'ok',
            version: '0.36.6',
            webBuildId: 'build-2',
        })
    })

    it('skips fetching /health for cross-origin hubs and ignores non-ok responses', async () => {
        const fetchMock = vi.fn(async () => new Response('unavailable', { status: 503 }))

        await expect(fetchPublicHubHealth({
            baseUrl: 'https://hub.other.example',
            windowOrigin: 'https://tiann.github.io',
            fetchImpl: fetchMock,
        })).resolves.toBeNull()
        expect(fetchMock).not.toHaveBeenCalled()

        await expect(fetchPublicHubHealth({
            baseUrl: 'https://hapi.example',
            windowOrigin: 'https://hapi.example',
            fetchImpl: fetchMock,
        })).resolves.toBeNull()
        expect(fetchMock).toHaveBeenCalledWith('https://hapi.example/health', { cache: 'no-store' })
    })
})
