import { describe, expect, it, vi } from 'vitest'
import { encodeBase64 } from '@/lib/utils'
import {
    MAX_INLINED_ASSETS,
    inlineHtmlAssets,
    isHtmlFile,
    resolveRelativeAssetPath
} from './file-html-preview'

function parse(html: string): Document {
    return new DOMParser().parseFromString(html, 'text/html')
}

describe('isHtmlFile', () => {
    it('matches .html and .htm case-insensitively', () => {
        expect(isHtmlFile('designs/index.html')).toBe(true)
        expect(isHtmlFile('A.HTM')).toBe(true)
        expect(isHtmlFile('notes.md')).toBe(false)
        expect(isHtmlFile('html')).toBe(false)
        expect(isHtmlFile('dir.html/readme')).toBe(false)
    })
})

describe('resolveRelativeAssetPath', () => {
    it('resolves relative refs against the file directory', () => {
        expect(resolveRelativeAssetPath('designs/a/index.html', 'tokens.css')).toBe('designs/a/tokens.css')
        expect(resolveRelativeAssetPath('designs/a/index.html', './img/x.png?v=2#top')).toBe('designs/a/img/x.png')
        expect(resolveRelativeAssetPath('designs/a/index.html', 'fonts/../My%20Font.woff2')).toBe('designs/a/My Font.woff2')
        expect(resolveRelativeAssetPath('/repo/site/index.html', 'img/logo.svg')).toBe('/repo/site/img/logo.svg')
    })

    it('never leaves the HTML file directory or reaches hidden files', () => {
        expect(resolveRelativeAssetPath('designs/a/index.html', '../shared/x.css')).toBeNull()
        expect(resolveRelativeAssetPath('/repo/site/index.html', '../../.env')).toBeNull()
        expect(resolveRelativeAssetPath('designs/a/index.html', 'img/../../b/x.png')).toBeNull()
        expect(resolveRelativeAssetPath('index.html', '.env')).toBeNull()
        expect(resolveRelativeAssetPath('index.html', '.git/config')).toBeNull()
        expect(resolveRelativeAssetPath('index.html', 'a/.hidden/x.png')).toBeNull()
    })

    it('skips refs that are not workspace-relative', () => {
        for (const ref of ['https://cdn.example/x.css', '//cdn.example/x.css', 'data:image/png;base64,AA', '#anchor', '/root.css', 'mailto:a@b', '']) {
            expect(resolveRelativeAssetPath('a/index.html', ref)).toBeNull()
        }
        expect(resolveRelativeAssetPath('index.html', '../outside.css')).toBeNull()
    })
})

describe('inlineHtmlAssets', () => {
    const files: Record<string, string> = {
        'site/tokens.css': '@font-face { src: url("./fonts/a.woff2"); } body { background: url(img/bg.png); }',
        'site/app.js': 'document.body.dataset.ready = "</script>"',
        'site/fonts/a.woff2': 'FONT',
        'site/img/bg.png': 'BG',
        'site/logo.svg': '<svg/>',
        'site/inline.png': 'INLINE'
    }
    const readFile = vi.fn(async (path: string) => (path in files ? encodeBase64(files[path]!) : null))

    it('inlines local stylesheets, scripts, images and CSS url() assets', async () => {
        const html = `<!doctype html><html><head>
            <link rel="stylesheet" href="tokens.css" media="screen">
            <link rel="stylesheet" href="https://cdn.example/remote.css">
            <style>.x { background: url('inline.png') }</style>
            </head><body>
            <img src="logo.svg" srcset="logo@2x.svg 2x">
            <img src="missing.png">
            <div style="background-image: url(inline.png)"></div>
            <script src="app.js"></script>
            </body></html>`

        const out = await inlineHtmlAssets(html, 'site/index.html', readFile)
        const doc = parse(out)

        expect(out.startsWith('<!DOCTYPE html>')).toBe(true)
        const styles = [...doc.querySelectorAll('style')]
        expect(styles[0]?.getAttribute('media')).toBe('screen')
        expect(styles[0]?.textContent).toContain(`url("data:font/woff2;base64,${encodeBase64('FONT')}")`)
        expect(styles[0]?.textContent).toContain(`url("data:image/png;base64,${encodeBase64('BG')}")`)
        expect(styles[1]?.textContent).toContain(`data:image/png;base64,${encodeBase64('INLINE')}`)
        expect(doc.querySelector('link[href="https://cdn.example/remote.css"]')).not.toBeNull()

        const [logo, missing] = [...doc.querySelectorAll('img')]
        expect(logo?.getAttribute('src')).toBe(`data:image/svg+xml;base64,${encodeBase64('<svg/>')}`)
        expect(logo?.hasAttribute('srcset')).toBe(false)
        expect(missing?.getAttribute('src')).toBe('missing.png')
        expect(doc.querySelector('div')?.getAttribute('style')).toContain('data:image/png;base64,')

        const script = doc.querySelector('script')
        expect(script?.hasAttribute('src')).toBe(false)
        expect(script?.textContent).toBe('document.body.dataset.ready = "<\\/script>"')
    })

    it('only reads web asset file types for each reference kind', async () => {
        const read = vi.fn(async () => encodeBase64('secret'))
        const out = await inlineHtmlAssets(`<head>
            <link rel="stylesheet" href="config.json">
            <style>body { background: url(keys/id_rsa) }</style>
            </head><body><script src="secrets.json"></script><img src="notes.txt"></body>`, 'index.html', read)

        expect(read).not.toHaveBeenCalled()
        expect(out).not.toContain(encodeBase64('secret'))
    })

    it('stops inlining once the asset budget is spent, in document order', async () => {
        const read = vi.fn(async () => encodeBase64('X'))
        const images = Array.from({ length: MAX_INLINED_ASSETS + 5 }, (_, i) => `<img src="img/${i}.png">`).join('')
        const doc = parse(await inlineHtmlAssets(`<body>${images}</body>`, 'index.html', read))
        const srcs = [...doc.querySelectorAll('img')].map((img) => img.getAttribute('src'))

        expect(read).toHaveBeenCalledTimes(MAX_INLINED_ASSETS)
        expect(srcs.slice(0, MAX_INLINED_ASSETS).every((src) => src?.startsWith('data:image/png'))).toBe(true)
        expect(srcs.slice(MAX_INLINED_ASSETS)).toEqual(['img/64.png', 'img/65.png', 'img/66.png', 'img/67.png', 'img/68.png'])
    })
})
