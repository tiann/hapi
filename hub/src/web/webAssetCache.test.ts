import { describe, expect, it } from 'bun:test'
import { getWebAssetCacheControl } from './webAssetCache'

describe('getWebAssetCacheControl', () => {
    it('requires app-shell entrypoints to revalidate', () => {
        for (const path of ['/sw.js', '/index.html', '/manifest.webmanifest']) {
            expect(getWebAssetCacheControl(path)).toBe('no-cache, no-store, must-revalidate')
        }
    })

    it('allows fingerprinted assets to be cached immutably', () => {
        expect(getWebAssetCacheControl('/assets/index-B9KpkXam.js'))
            .toBe('public, max-age=31536000, immutable')
    })
})
