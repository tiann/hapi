import { describe, expect, it, vi } from 'vitest'
import { encodeBase64 } from '@/lib/utils'
import {
    MAX_INLINED_ASSETS,
    inlineHtmlAssets,
    isHtmlFile,
    resolveRelativeAssetPath,
    withoutSymlinkedAssets
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
        expect(resolveRelativeAssetPath('site/css/main.css', '../fonts/a.woff2', 'site/index.html')).toBe('site/fonts/a.woff2')
        expect(resolveRelativeAssetPath('site/css/main.css', '../../x.png', 'site/index.html')).toBeNull()
    })
})

describe('inlineHtmlAssets', () => {
    const files: Record<string, string> = {
        'site/tokens.css': '@font-face { src: url("./fonts/a.woff2"); } body { background: url(img/bg.png); }',
        'site/app.js': 'document.body.dataset.ready = "</script>"',
        'site/fonts/a.woff2': 'FONT',
        'site/img/bg.png': 'BG',
        'site/logo.svg': '<svg/>',
        'site/inline.png': 'INLINE',
        'site/css/main.css': '@font-face { src: url(../fonts/a.woff2) } .x { background: url("../../outside.png") }',
        'site/defer.js': 'init()'
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
        expect(script?.getAttribute('src')).toBe(`data:text/javascript;base64,${encodeBase64(files['site/app.js']!)}`)
        expect(script?.textContent).toBe('')
    })

    it('keeps URL fragments such as SVG named views on inlined assets', async () => {
        const doc = parse(await inlineHtmlAssets(
            '<head><style>.i { background: url("logo.svg#icon-view") }</style></head><body><img src="logo.svg#frag"></body>',
            'site/index.html',
            readFile
        ))
        const dataUrl = `data:image/svg+xml;base64,${encodeBase64('<svg/>')}`
        expect(doc.querySelector('style')?.textContent).toContain(`url("${dataUrl}#icon-view")`)
        expect(doc.querySelector('img')?.getAttribute('src')).toBe(`${dataUrl}#frag`)
    })

    it('keeps inlined scripts external so defer and async still apply', async () => {
        const doc = parse(await inlineHtmlAssets(
            '<head><script defer src="defer.js"></script></head><body></body>',
            'site/index.html',
            readFile
        ))
        const script = doc.querySelector('script')
        expect(script?.hasAttribute('defer')).toBe(true)
        expect(script?.getAttribute('src')).toBe(`data:text/javascript;base64,${encodeBase64('init()')}`)
    })

    it('resolves stylesheet url() against the stylesheet but bounds it by the HTML directory', async () => {
        const out = await inlineHtmlAssets(
            '<head><link rel="stylesheet" href="css/main.css"></head>',
            'site/index.html',
            readFile
        )
        const css = parse(out).querySelector('style')?.textContent ?? ''
        expect(css).toContain(`url("data:font/woff2;base64,${encodeBase64('FONT')}")`)
        expect(css).toContain('url("../../outside.png")')
        expect(readFile).not.toHaveBeenCalledWith('outside.png')
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

describe('withoutSymlinkedAssets', () => {
    const tree: Record<string, Array<{ name: string; type: string }>> = {
        site: [
            { name: 'index.html', type: 'file' },
            { name: 'style.css', type: 'other' },
            { name: 'fonts', type: 'directory' },
            { name: 'linked', type: 'other' }
        ],
        'site/fonts': [{ name: 'a.woff2', type: 'file' }]
    }

    function setup(htmlPath = 'site/index.html') {
        const read = vi.fn(async (path: string) => encodeBase64(path))
        const list = vi.fn(async (dir: string) => tree[dir] ?? null)
        return { read, list, guarded: withoutSymlinkedAssets(read, list, htmlPath) }
    }

    it('reads assets whose every path component is a plain directory or file', async () => {
        const { read, list, guarded } = setup()
        expect(await guarded('site/fonts/a.woff2')).toBe(encodeBase64('site/fonts/a.woff2'))
        expect(read).toHaveBeenCalledWith('site/fonts/a.woff2')
        expect(list.mock.calls.map(([dir]) => dir)).toEqual(['site', 'site/fonts'])
    })

    it('refuses symlinked files and anything below a symlinked directory', async () => {
        const { read, guarded } = setup()
        expect(await guarded('site/style.css')).toBeNull()
        expect(await guarded('site/linked/x.png')).toBeNull()
        expect(await guarded('site/fonts/missing.woff2')).toBeNull()
        expect(await guarded('other/x.png')).toBeNull()
        expect(read).not.toHaveBeenCalled()
    })

    it('caches directory listings across assets', async () => {
        const { list, guarded } = setup()
        await guarded('site/fonts/a.woff2')
        await guarded('site/fonts/a.woff2')
        expect(list).toHaveBeenCalledTimes(2)
    })
})
