const IMMUTABLE_ASSET_CACHE_CONTROL = 'public, max-age=31536000, immutable'
const MUTABLE_ASSET_CACHE_CONTROL = 'no-cache, no-store, must-revalidate'

export function getWebAssetCacheControl(path: string): string {
    return path.startsWith('/assets/')
        ? IMMUTABLE_ASSET_CACHE_CONTROL
        : MUTABLE_ASSET_CACHE_CONTROL
}
