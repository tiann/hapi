export const LEGACY_AUTHENTICATED_API_CACHE_NAMES = [
    'api-sessions',
    'api-session-detail',
    'api-machines',
] as const

type CacheDeletionTarget = {
    delete(cacheName: string): Promise<boolean>
}

type CacheInspectionTarget = {
    keys(): Promise<string[]>
}

export async function hasLegacyAuthenticatedApiCaches(
    cacheStorage: CacheInspectionTarget,
): Promise<boolean> {
    const cacheNames = await cacheStorage.keys()
    return LEGACY_AUTHENTICATED_API_CACHE_NAMES.some((cacheName) => cacheNames.includes(cacheName))
}

export async function removeLegacyAuthenticatedApiCaches(
    cacheStorage: CacheDeletionTarget,
): Promise<void> {
    await Promise.all(
        LEGACY_AUTHENTICATED_API_CACHE_NAMES.map((cacheName) => cacheStorage.delete(cacheName)),
    )
}
