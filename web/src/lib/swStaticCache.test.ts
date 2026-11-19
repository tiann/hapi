import { describe, expect, it, vi } from 'vitest'
import {
    HUB_WEB_BUILD_STORAGE_KEY,
    STATIC_CACHE_VERSION_STORAGE_KEY,
    cleanupClientStaticCachesOnVersionChange,
    cleanupOutdatedStaticCaches,
    computeStaticCacheVersion,
    getHapiStaticCacheName,
    getSyntaxGrammarsCacheName,
    isOutdatedStaticCacheName,
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

function createFakeCacheStorage(initialKeys: string[]) {
    const keys = new Set(initialKeys)
    const deleted: string[] = []
    return {
        keys: vi.fn(async () => [...keys]),
        delete: vi.fn(async (key: string) => {
            const existed = keys.delete(key)
            if (existed) {
                deleted.push(key)
            }
            return existed
        }),
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
    it('deletes legacy and mismatched versioned static caches while keeping current and non-static caches', async () => {
        const currentVersion = '0.36.5-1234abcd'
        const currentSyntaxCache = getSyntaxGrammarsCacheName(currentVersion)
        const currentStaticCache = getHapiStaticCacheName(currentVersion)
        const cacheStorage = createFakeCacheStorage([
            'syntax-grammars',
            'syntax-grammars-0.36.4-deadbeef',
            'syntax-grammars-0.36.5-oldbuild',
            currentSyntaxCache,
            'hapi-static-0.36.4-deadbeef',
            currentStaticCache,
            'workbox-precache-v2-https://hapi.example/',
            'api-sessions',
            'cdn-socketio',
            'unrelated-cache',
        ])

        const deleted = await cleanupOutdatedStaticCaches(cacheStorage, currentVersion)

        expect(deleted).toEqual([
            'syntax-grammars',
            'syntax-grammars-0.36.4-deadbeef',
            'syntax-grammars-0.36.5-oldbuild',
            'hapi-static-0.36.4-deadbeef',
        ])
        expect(cacheStorage.remaining()).toEqual([
            currentSyntaxCache,
            currentStaticCache,
            'workbox-precache-v2-https://hapi.example/',
            'api-sessions',
            'cdn-socketio',
            'unrelated-cache',
        ])
    })

    it('preserves active manifest-hashed caches for the current appVersion in prefix-only mode', () => {
        expect(isOutdatedStaticCacheName('syntax-grammars', '0.36.5', { matchPrefixOnly: true })).toBe(true)
        expect(isOutdatedStaticCacheName('syntax-grammars-0.36.4-abcd1234', '0.36.5', { matchPrefixOnly: true })).toBe(true)
        expect(isOutdatedStaticCacheName('syntax-grammars-0.36.5-abcd1234', '0.36.5', { matchPrefixOnly: true })).toBe(false)
        expect(isOutdatedStaticCacheName('syntax-grammars-0.36.5', '0.36.5', { matchPrefixOnly: true })).toBe(false)
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

        expect(result).toEqual({ versionChanged: false, deletedCaches: [] })
        expect(cacheStorage.delete).not.toHaveBeenCalled()
    })

    it('cleans outdated static caches and records new version when version changes', async () => {
        const storage = createMemoryStorage({ [STATIC_CACHE_VERSION_STORAGE_KEY]: '0.36.4' })
        const cacheStorage = createFakeCacheStorage([
            'syntax-grammars',
            'syntax-grammars-0.36.4-11112222',
            'syntax-grammars-0.36.5-33334444',
            'api-sessions',
        ])

        const result = await cleanupClientStaticCachesOnVersionChange({
            appVersion: '0.36.5',
            storage,
            cacheStorage,
        })

        expect(result).toEqual({
            versionChanged: true,
            deletedCaches: ['syntax-grammars', 'syntax-grammars-0.36.4-11112222'],
        })
        expect(storage.getItem(STATIC_CACHE_VERSION_STORAGE_KEY)).toBe('0.36.5')
        expect(cacheStorage.remaining()).toEqual([
            'syntax-grammars-0.36.5-33334444',
            'api-sessions',
        ])
    })
})

describe('shouldCheckSwUpdateForHubHealth', () => {
    it('returns true when same-origin hub version differs from appVersion', () => {
        const storage = createMemoryStorage()
        expect(shouldCheckSwUpdateForHubHealth({
            baseUrl: 'https://hapi.example',
            windowOrigin: 'https://hapi.example',
            appVersion: '0.36.5',
            health: { version: '0.36.6', webBuildId: 'build-2' },
            storage,
        })).toBe(true)
        expect(storage.getItem(HUB_WEB_BUILD_STORAGE_KEY)).toBe('build-2')
    })

    it('returns true when same-origin hub webBuildId changes even within the same appVersion', () => {
        const storage = createMemoryStorage({ [HUB_WEB_BUILD_STORAGE_KEY]: 'build-1' })
        expect(shouldCheckSwUpdateForHubHealth({
            baseUrl: '',
            windowOrigin: 'https://hapi.example',
            appVersion: '0.36.5',
            health: { version: '0.36.5', webBuildId: 'build-2' },
            storage,
        })).toBe(true)
        expect(storage.getItem(HUB_WEB_BUILD_STORAGE_KEY)).toBe('build-2')
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
