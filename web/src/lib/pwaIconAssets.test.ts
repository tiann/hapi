import indexHtml from '../../index.html?raw'
import viteConfigSource from '../../vite.config.ts?raw'
import { describe, expect, it } from 'vitest'

describe('PWA icon startup assets', () => {
    it('does not request the large SVG favicon during page startup', () => {
        const html = indexHtml

        expect(html).toContain('href="/favicon.ico"')
        expect(html).toContain('href="/pwa-64x64.png"')
        expect(html).not.toContain('href="/icon.svg"')
    })

    it('keeps install icons while excluding the large SVG icon from precache', () => {
        const viteConfig = viteConfigSource

        expect(viteConfig).toContain("includeAssets: ['favicon.ico', 'apple-touch-icon-180x180.png', 'mask-icon.svg']")
        expect(viteConfig).toContain("src: 'pwa-64x64.png'")
        expect(viteConfig).toContain("src: 'pwa-192x192.png'")
        expect(viteConfig).toContain("src: 'pwa-512x512.png'")
        expect(viteConfig).toContain("'**/icon.svg'")
    })
})
