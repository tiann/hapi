import { describe, expect, it } from 'bun:test'
import { getStaticCacheHeaders } from './server'

describe('getStaticCacheHeaders', () => {
    it('caches content-hashed /assets/ bundles immutably for a year', () => {
        for (const path of [
            '/assets/index-RPnKyNwb.js',
            '/assets/index-B2c9x1qD.css',
            '/assets/architectureDiagram-Q4EWVU46-CQKiqRiS.js'
        ]) {
            expect(getStaticCacheHeaders(path)).toEqual({
                'Cache-Control': 'public, max-age=31536000, immutable'
            })
        }
    })

    it('bounds caching for the non-hashed KaTeX fonts under /assets/fonts/', () => {
        // copyKaTeXFonts emits original (non-content-hashed) names, so these
        // are the one /assets/ family that must never be immutable. Includes
        // the "BoldItalic" name that would defeat a naive hash-suffix regex.
        for (const path of [
            '/assets/fonts/KaTeX_Main-Regular.woff2',
            '/assets/fonts/KaTeX_Math-BoldItalic.woff2',
            '/assets/fonts/KaTeX_Typewriter-Regular.ttf'
        ]) {
            expect(getStaticCacheHeaders(path)).toEqual({
                'Cache-Control': 'public, max-age=86400'
            })
        }
    })

    it('keeps the service worker strictly uncacheable', () => {
        expect(getStaticCacheHeaders('/sw.js')).toEqual({
            'Cache-Control': 'no-store, no-cache, must-revalidate',
            'CDN-Cache-Control': 'no-store',
            'Cloudflare-CDN-Cache-Control': 'no-store'
        })
    })

    it('forces revalidation for the HTML shell, including the SPA fallback', () => {
        for (const path of ['/', '/index.html', '/404.html', '/manifest.webmanifest']) {
            expect(getStaticCacheHeaders(path)).toEqual({ 'Cache-Control': 'no-cache' })
        }
        expect(getStaticCacheHeaders('/some/route', { spaFallback: true }))
            .toEqual({ 'Cache-Control': 'no-cache' })
        // Deep links only get the shell via the spaFallback path, not on
        // their own.
        expect(getStaticCacheHeaders('/sessions/abc')).toEqual({})
    })
})
