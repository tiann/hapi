import { describe, expect, it } from 'bun:test'
import { serveEmbeddedAsset } from './server'
import type { EmbeddedWebAsset } from './embeddedAssets'

function asset(path: string, mimeType: string): EmbeddedWebAsset {
    return { path, sourcePath: '/dev/null', mimeType } as EmbeddedWebAsset
}

describe('serveEmbeddedAsset cache policy', () => {
    it('caches content-hashed /assets/ bundles immutably for a year', () => {
        for (const [path, mimeType] of [
            ['/assets/index-RPnKyNwb.js', 'application/javascript; charset=utf-8'],
            ['/assets/index-B2c9x1qD.css', 'text/css; charset=utf-8'],
            ['/assets/architectureDiagram-Q4EWVU46-CQKiqRiS.js', 'application/javascript; charset=utf-8']
        ] as const) {
            const headers = serveEmbeddedAsset(asset(path, mimeType)).headers
            expect(headers.get('Cache-Control')).toBe('public, max-age=31536000, immutable')
        }
    })

    it('keeps the service worker strictly uncacheable', () => {
        const headers = serveEmbeddedAsset(asset('/sw.js', 'application/javascript; charset=utf-8')).headers
        expect(headers.get('Cache-Control')).toBe('no-store, no-cache, must-revalidate')
        expect(headers.get('CDN-Cache-Control')).toBe('no-store')
        expect(headers.get('Cloudflare-CDN-Cache-Control')).toBe('no-store')
    })

    it('forces revalidation for the HTML shell so stale indexes cannot pin retired bundles', () => {
        for (const path of ['/index.html', '/404.html']) {
            const headers = serveEmbeddedAsset(asset(path, 'text/html; charset=utf-8')).headers
            expect(headers.get('Cache-Control')).toBe('no-cache')
        }
    })

    it('leaves other root files without an explicit cache policy', () => {
        const headers = serveEmbeddedAsset(asset('/manifest.webmanifest', 'application/manifest+json')).headers
        expect(headers.get('Cache-Control')).toBeNull()
    })
})
