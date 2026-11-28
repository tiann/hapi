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

type CacheLike = Pick<Cache, 'keys' | 'delete'>
type CacheStorageLike = Pick<CacheStorage, 'keys' | 'delete'> & {
    open?: (cacheName: string) => Promise<CacheLike>
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

export function getSafeCacheStorage(): CacheStorageLike | undefined {
    try {
        return typeof window !== 'undefined' ? window.caches : undefined
    } catch {
        return undefined
    }
}

export function computeScopeTag(scope: string): string {
    return fnv1aHex(scope)
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

export function getSyntaxGrammarsCacheName(cacheVersion: string, scope?: string): string {
    const scopeSegment = scope ? `${computeScopeTag(scope)}-` : ''
    return `${SYNTAX_GRAMMARS_CACHE_PREFIX}${scopeSegment}${cacheVersion}`
}

export function getHapiStaticCacheName(cacheVersion: string, scope?: string): string {
    const scopeSegment = scope ? `${computeScopeTag(scope)}-` : ''
    return `${HAPI_STATIC_CACHE_PREFIX}${scopeSegment}${cacheVersion}`
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

function matchesVersionSuffix(
    suffix: string,
    currentVersion: string,
    matchPrefixOnly?: boolean,
): boolean {
    if (matchPrefixOnly) {
        return suffix !== currentVersion && !suffix.startsWith(`${currentVersion}-`)
    }
    return suffix !== currentVersion
}

export function isOutdatedStaticCacheName(
    cacheName: string,
    currentVersion: string,
    options?: { matchPrefixOnly?: boolean; scope?: string; preserveGrammarCaches?: boolean },
): boolean {
    if (cacheName === SYNTAX_GRAMMARS_LEGACY_CACHE_NAME) {
        return !options?.scope && !options?.preserveGrammarCaches
    }

    if (options?.scope && isOutdatedScopedWorkboxPrecache(cacheName, options.scope)) {
        return true
    }

    const scopePrefix = options?.scope ? `${computeScopeTag(options.scope)}-` : ''
    const prefixes = options?.preserveGrammarCaches
        ? [`${HAPI_STATIC_CACHE_PREFIX}${scopePrefix}`]
        : [
            `${SYNTAX_GRAMMARS_CACHE_PREFIX}${scopePrefix}`,
            `${HAPI_STATIC_CACHE_PREFIX}${scopePrefix}`,
        ]

    for (const prefix of prefixes) {
        if (!cacheName.startsWith(prefix)) {
            continue
        }
        const suffix = cacheName.slice(prefix.length)
        if (options?.scope) {
            return matchesVersionSuffix(suffix, currentVersion, options.matchPrefixOnly)
        }
        // Unscoped fallback (e.g. no-SW browser): handle both "<version>" and "<scopeTag>-<version>".
        const scopedMatch = /^[0-9a-f]{8}-(.+)$/.exec(suffix)
        const versionPart = scopedMatch ? scopedMatch[1] : suffix
        return matchesVersionSuffix(versionPart, currentVersion, options?.matchPrefixOnly)
    }

    return false
}

export function isScopedGrammarUrl(url: string, scope: string): boolean {
    const directory = new URL('assets/', scope).href
    return url.startsWith(directory) && /^shiki-[^/?#]+\.js$/.test(url.slice(directory.length))
}

type RetirementHooks = {
    migrateGrammars?: (name: string, requests: readonly Request[]) => Promise<void>
    clearExpiration?: (name: string) => Promise<void>
}

async function cleanupLegacyUnscopedSyntaxCache(
    cacheStorage: CacheStorageLike,
    scope: string,
    hooks: RetirementHooks,
): Promise<void> {
    if (typeof cacheStorage.open !== 'function') {
        return
    }
    const cache = await cacheStorage.open(SYNTAX_GRAMMARS_LEGACY_CACHE_NAME)
    const requests = await cache.keys()
    const owned = requests.filter((req) => isScopedGrammarUrl(req.url, scope))
    if (owned.length > 0) {
        await hooks.migrateGrammars?.(SYNTAX_GRAMMARS_LEGACY_CACHE_NAME, owned)
        await Promise.all(owned.map((req) => cache.delete(req)))
    }
}

export async function cleanupOutdatedStaticCaches(
    cacheStorage: CacheStorageLike | undefined,
    currentVersion: string,
    options?: { matchPrefixOnly?: boolean; scope?: string; preserveGrammarCaches?: boolean } & RetirementHooks,
): Promise<string[]> {
    if (!cacheStorage) {
        return []
    }

    const keys = await cacheStorage.keys()
    const outdated = keys.filter((key) => isOutdatedStaticCacheName(key, currentVersion, options))
    const deleted: string[] = []

    if (outdated.length > 0) {
        for (const key of outdated) {
            if (key.startsWith(SYNTAX_GRAMMARS_CACHE_PREFIX) || key === SYNTAX_GRAMMARS_LEGACY_CACHE_NAME) {
                if (options?.migrateGrammars && cacheStorage.open) {
                    await options.migrateGrammars(key, await (await cacheStorage.open(key)).keys())
                }
                await options?.clearExpiration?.(key)
            }
            await cacheStorage.delete(key)
        }
        deleted.push(...outdated)
    }

    if (options?.scope && !options?.preserveGrammarCaches && keys.includes(SYNTAX_GRAMMARS_LEGACY_CACHE_NAME)) {
        await cleanupLegacyUnscopedSyntaxCache(cacheStorage, options.scope, options)
    }

    return deleted
}

export async function cleanupClientStaticCachesOnVersionChange(options: {
    appVersion: string
    scope?: string
    storage?: Pick<Storage, 'getItem' | 'setItem'> | null
    cacheStorage?: CacheStorageLike
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
            // Leave grammar caches intact during client-side fallback so the replacement
            // service worker can migrate reusable entries once it activates.
            { matchPrefixOnly: true, scope: options.scope, preserveGrammarCaches: true },
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

export type HubHealthProbe = {
    version?: string
    webBuildId?: string | null
    capabilities?: {
        titleSuggestion?: boolean
    }
}

export function buildPublicHealthUrl(baseUrl: string): string {
    if (!baseUrl) {
        return '/health'
    }
    try {
        return new URL('/health', baseUrl).toString()
    } catch {
        return '/health'
    }
}

export async function fetchPublicHubHealth(options: {
    baseUrl: string
    windowOrigin: string
    fetchImpl?: (input: string, init?: RequestInit) => Promise<Response>
}): Promise<HubHealthProbe | null> {
    if (!isSameOriginUrl(options.baseUrl, options.windowOrigin)) {
        return null
    }
    const fetchFn = options.fetchImpl ?? fetch
    const response = await fetchFn(buildPublicHealthUrl(options.baseUrl), { cache: 'no-store' })
    if (!response.ok) {
        return null
    }
    const payload = await response.json() as unknown
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
        return null
    }
    return payload as HubHealthProbe
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

export function recordHubWebBuildId(
    storage: Pick<Storage, 'setItem'> | null | undefined,
    webBuildId: string | null | undefined,
): void {
    const normalized = typeof webBuildId === 'string' ? webBuildId.trim() : ''
    if (!normalized) {
        return
    }
    try {
        storage?.setItem(HUB_WEB_BUILD_STORAGE_KEY, normalized)
    } catch {
        // Ignore storage write errors.
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

    if (hubVersion && hubVersion !== currentAppVersion) {
        return true
    }

    if (hubBuildId) {
        let previousBuildId: string | null = null
        try {
            previousBuildId = options.storage?.getItem(HUB_WEB_BUILD_STORAGE_KEY) ?? null
        } catch {
            previousBuildId = null
        }

        if (previousBuildId !== hubBuildId) {
            return true
        }
    }

    return false
}
