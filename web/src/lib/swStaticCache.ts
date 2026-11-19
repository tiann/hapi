export const SYNTAX_GRAMMARS_LEGACY_CACHE_NAME = 'syntax-grammars'
export const SYNTAX_GRAMMARS_CACHE_PREFIX = 'syntax-grammars-'
export const HAPI_STATIC_CACHE_PREFIX = 'hapi-static-'
export const STATIC_CACHE_VERSION_STORAGE_KEY = 'hapi:static-cache-version'
export const HUB_WEB_BUILD_STORAGE_KEY = 'hapi:hub-web-build'
export const CLEANUP_OUTDATED_CACHES_MESSAGE = 'CLEANUP_OUTDATED_CACHES'

export type PrecacheManifestEntry = string | {
    url: string
    revision?: string | null
}

function fnv1aHex(input: string): string {
    let hash = 0x811c9dc5
    for (let i = 0; i < input.length; i += 1) {
        hash ^= input.charCodeAt(i)
        hash = Math.imul(hash, 0x01000193)
    }
    return (hash >>> 0).toString(16).padStart(8, '0')
}

export function getSafeLocalStorage(): Pick<Storage, 'getItem' | 'setItem'> | null {
    try {
        return typeof window !== 'undefined' ? window.localStorage : null
    } catch {
        return null
    }
}

export function getSafeCacheStorage(): Pick<CacheStorage, 'keys' | 'delete'> | undefined {
    try {
        return typeof window !== 'undefined' ? window.caches : undefined
    } catch {
        return undefined
    }
}

export function computeStaticCacheVersion(
    appVersion: string,
    manifest?: ReadonlyArray<PrecacheManifestEntry>,
): string {
    const normalizedVersion = appVersion.trim() || '0.0.0'
    if (!manifest || manifest.length === 0) {
        return normalizedVersion
    }

    const entries = manifest
        .map((entry) => (typeof entry === 'string'
            ? entry
            : `${entry.url}::${entry.revision ?? ''}`))
        .sort()

    return `${normalizedVersion}-${fnv1aHex(entries.join('\n'))}`
}

export function getSyntaxGrammarsCacheName(cacheVersion: string): string {
    return `${SYNTAX_GRAMMARS_CACHE_PREFIX}${cacheVersion}`
}

export function getHapiStaticCacheName(cacheVersion: string): string {
    return `${HAPI_STATIC_CACHE_PREFIX}${cacheVersion}`
}

function isOutdatedScopedWorkboxPrecache(cacheName: string, scope: string): boolean {
    const match = /^workbox-precache(?:-v(\d+))?-(.+)$/.exec(cacheName)
    if (!match) {
        return false
    }
    const version = match[1]
    const cacheScope = match[2]
    // Exact scope match prevents deleting sibling apps hosted on subpaths under the same origin.
    return cacheScope === scope && version !== '2'
}

export function isOutdatedStaticCacheName(
    cacheName: string,
    currentVersion: string,
    options?: { matchPrefixOnly?: boolean; scope?: string },
): boolean {
    if (cacheName === SYNTAX_GRAMMARS_LEGACY_CACHE_NAME) {
        return true
    }

    if (options?.scope && isOutdatedScopedWorkboxPrecache(cacheName, options.scope)) {
        return true
    }

    const prefixes = [SYNTAX_GRAMMARS_CACHE_PREFIX, HAPI_STATIC_CACHE_PREFIX]
    for (const prefix of prefixes) {
        if (!cacheName.startsWith(prefix)) {
            continue
        }
        const suffix = cacheName.slice(prefix.length)
        if (options?.matchPrefixOnly) {
            return suffix !== currentVersion && !suffix.startsWith(`${currentVersion}-`)
        }
        return suffix !== currentVersion
    }

    return false
}

export async function cleanupOutdatedStaticCaches(
    cacheStorage: Pick<CacheStorage, 'keys' | 'delete'> | undefined,
    currentVersion: string,
    options?: { matchPrefixOnly?: boolean; scope?: string },
): Promise<string[]> {
    if (!cacheStorage) {
        return []
    }

    const keys = await cacheStorage.keys()
    const outdated = keys.filter((key) => isOutdatedStaticCacheName(key, currentVersion, options))
    if (outdated.length === 0) {
        return []
    }

    await Promise.all(outdated.map((key) => cacheStorage.delete(key)))
    return outdated
}

export async function cleanupClientStaticCachesOnVersionChange(options: {
    appVersion: string
    storage?: Pick<Storage, 'getItem' | 'setItem'> | null
    cacheStorage?: Pick<CacheStorage, 'keys' | 'delete'>
    serviceWorker?: Pick<ServiceWorkerContainer, 'controller' | 'getRegistration'> | null
}): Promise<{ versionChanged: boolean; deletedCaches: string[]; delegatedToWorker: boolean }> {
    const normalizedVersion = options.appVersion.trim() || '0.0.0'
    let previousVersion: string | null = null
    try {
        previousVersion = options.storage?.getItem(STATIC_CACHE_VERSION_STORAGE_KEY) ?? null
    } catch {
        previousVersion = null
    }

    if (previousVersion === normalizedVersion) {
        return { versionChanged: false, deletedCaches: [], delegatedToWorker: false }
    }

    // When a service worker is active, delegate cleanup to the active worker so it runs
    // with its own build identity and never deletes caches still backing older tabs.
    const sw = options.serviceWorker
    if (sw) {
        try {
            const activeWorker = sw.controller
                ?? (typeof sw.getRegistration === 'function' ? (await sw.getRegistration())?.active : null)
                ?? null
            if (activeWorker) {
                activeWorker.postMessage({ type: CLEANUP_OUTDATED_CACHES_MESSAGE })
                return { versionChanged: true, deletedCaches: [], delegatedToWorker: true }
            }
        } catch {
            // Fall through to local cache cleanup when worker lookup fails.
        }
    }

    let deletedCaches: string[] = []
    try {
        deletedCaches = await cleanupOutdatedStaticCaches(
            options.cacheStorage,
            normalizedVersion,
            { matchPrefixOnly: true },
        )
    } catch {
        deletedCaches = []
    }

    try {
        options.storage?.setItem(STATIC_CACHE_VERSION_STORAGE_KEY, normalizedVersion)
    } catch {
        // Ignore storage write errors (e.g. private mode / quota).
    }

    return { versionChanged: true, deletedCaches, delegatedToWorker: false }
}

export function isSameOriginUrl(targetUrl: string, windowOrigin: string): boolean {
    if (!targetUrl) {
        return true
    }
    try {
        return new URL(targetUrl, windowOrigin).origin === windowOrigin
    } catch {
        return false
    }
}

export function shouldCheckSwUpdateForHubHealth(options: {
    baseUrl: string
    windowOrigin: string
    appVersion: string
    health: { version?: string; webBuildId?: string | null }
    storage?: Pick<Storage, 'getItem' | 'setItem'> | null
}): boolean {
    if (!isSameOriginUrl(options.baseUrl, options.windowOrigin)) {
        return false
    }

    const hubVersion = typeof options.health.version === 'string' ? options.health.version.trim() : ''
    const currentAppVersion = options.appVersion.trim() || '0.0.0'
    const hubBuildId = typeof options.health.webBuildId === 'string' ? options.health.webBuildId.trim() : ''

    let previousBuildId: string | null = null
    if (hubBuildId) {
        try {
            previousBuildId = options.storage?.getItem(HUB_WEB_BUILD_STORAGE_KEY) ?? null
            options.storage?.setItem(HUB_WEB_BUILD_STORAGE_KEY, hubBuildId)
        } catch {
            previousBuildId = null
        }
    }

    if (hubVersion && hubVersion !== currentAppVersion) {
        return true
    }

    if (hubBuildId && previousBuildId && previousBuildId !== hubBuildId) {
        return true
    }

    return false
}
