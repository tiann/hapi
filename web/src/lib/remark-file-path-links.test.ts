import { describe, expect, it } from 'vitest'
import { decodeFilePathHref, remarkFilePathLinks } from '@/lib/remark-file-path-links'

type TestNode = {
    type: string
    value?: string
    url?: string
    children?: TestNode[]
}

function transform(text: string): TestNode[] {
    const tree: TestNode = {
        type: 'root',
        children: [{ type: 'paragraph', children: [{ type: 'text', value: text }] }]
    }
    remarkFilePathLinks()(tree)
    return tree.children?.[0]?.children ?? []
}

// Run the plugin against a hand-built mdast paragraph (for inlineCode / link
// nodes that can't be produced from a plain text string).
function transformNodes(children: TestNode[]): TestNode[] {
    const tree: TestNode = {
        type: 'root',
        children: [{ type: 'paragraph', children }]
    }
    remarkFilePathLinks()(tree)
    return tree.children?.[0]?.children ?? []
}

function linkedPath(node: TestNode): string | null {
    return typeof node.url === 'string' ? decodeFilePathHref(node.url) : null
}

describe('remarkFilePathLinks', () => {
    it('links relative code paths and strips line suffixes from the target path', () => {
        const nodes = transform('Open web/src/router.tsx:42 please')
        const link = nodes.find((node) => node.type === 'link')

        expect(link?.children?.[0]?.value).toBe('web/src/router.tsx:42')
        expect(linkedPath(link!)).toBe('web/src/router.tsx')
    })

    it('links image and markdown filenames for preview', () => {
        const nodes = transform('See screenshot.png and README.md')
        const links = nodes.filter((node) => node.type === 'link')

        expect(links.map(linkedPath)).toEqual(['screenshot.png', 'README.md'])
    })


    it('does not link paths that are outside the session workspace', () => {
        const nodes = transform('Skip /Users/dev/project/a.png, ~/a.png, ../a.png and C:\\tmp\\a.png')

        expect(nodes.some((node) => node.type === 'link')).toBe(false)
    })

    it('does not rewrite ordinary urls', () => {
        const nodes = transform('Visit https://example.com/web/src/router.tsx')

        expect(nodes.some((node) => node.type === 'link')).toBe(false)
    })

    it('links newly allowlisted diagram/doc/config extensions', () => {
        const nodes = transform('See docs/diagram.mmd, arch.puml, notes.rst, data.csv and app.ini')
        const links = nodes.filter((node) => node.type === 'link')

        expect(links.map(linkedPath)).toEqual([
            'docs/diagram.mmd',
            'arch.puml',
            'notes.rst',
            'data.csv',
            'app.ini'
        ])
    })

    it('does not link TLD-lookalike extensions in domains', () => {
        const nodes = transform('Reach example.org or foo.com for details')

        expect(nodes.some((node) => node.type === 'link')).toBe(false)
    })
})

// ── inlineCode autolinking (prong 2) ─────────────────────────────────────────

describe('remarkFilePathLinks — inlineCode', () => {
    it('links an inlineCode node whose whole value is a relative path', () => {
        const nodes = transformNodes([{ type: 'inlineCode', value: 'web/src/router.tsx' }])
        const link = nodes.find((node) => node.type === 'link')

        expect(linkedPath(link!)).toBe('web/src/router.tsx')
        // Preserves monospace by wrapping an inlineCode child.
        expect(link?.children?.[0]?.type).toBe('inlineCode')
        expect(link?.children?.[0]?.value).toBe('web/src/router.tsx')
    })

    it('links a bare filename inlineCode and strips line suffix from target', () => {
        const nodes = transformNodes([{ type: 'inlineCode', value: 'README.md:12' }])
        const link = nodes.find((node) => node.type === 'link')

        expect(linkedPath(link!)).toBe('README.md')
        expect(link?.children?.[0]?.value).toBe('README.md:12')
    })

    it('links a .mmd inlineCode path', () => {
        const nodes = transformNodes([{ type: 'inlineCode', value: 'docs/flow.mmd' }])
        expect(linkedPath(nodes.find((n) => n.type === 'link')!)).toBe('docs/flow.mmd')
    })

    it.each([
        'npm run build',
        'str.split()',
        'Math.PI',
        'array.map',
        'const x = 1',
        'obj.property',
        'foo.unknownext'
    ])('leaves non-path inlineCode %s untouched', (value) => {
        const nodes = transformNodes([{ type: 'inlineCode', value }])
        expect(nodes.some((node) => node.type === 'link')).toBe(false)
        expect(nodes[0]?.type).toBe('inlineCode')
    })

    it('does not link unsafe paths inside inlineCode', () => {
        for (const value of ['/etc/passwd.sh', '~/secrets.env', '../escape.ts', 'C:\\win.ini']) {
            const nodes = transformNodes([{ type: 'inlineCode', value }])
            expect(nodes.some((node) => node.type === 'link')).toBe(false)
        }
    })
})

// ── explicit markdown link rewriting (prong 3) ───────────────────────────────

describe('remarkFilePathLinks — explicit markdown links', () => {
    function linkNode(url: string, label = 'label'): TestNode {
        return { type: 'link', url, children: [{ type: 'text', value: label }] }
    }

    it('rewrites [label](relative/file.md) to a hapi-file link and keeps the label', () => {
        const nodes = transformNodes([linkNode('docs/foo.md', 'the docs')])
        const link = nodes.find((node) => node.type === 'link')

        expect(linkedPath(link!)).toBe('docs/foo.md')
        expect(link?.children?.[0]?.value).toBe('the docs')
    })

    it('rewrites a relative link with a line suffix, stripping it from the target', () => {
        const nodes = transformNodes([linkNode('web/src/router.tsx:42')])
        expect(linkedPath(nodes.find((n) => n.type === 'link')!)).toBe('web/src/router.tsx')
    })

    it('rewrites ./ prefixed relative file links', () => {
        const nodes = transformNodes([linkNode('./diagram.mmd')])
        expect(linkedPath(nodes.find((n) => n.type === 'link')!)).toBe('./diagram.mmd')
    })

    it.each([
        'https://example.com/a.md',
        'mailto:dev@example.com',
        'obsidian://open?file=a.md',
        '/abs/path.md',
        '~/home.md',
        '../escape.md',
        'C:\\win\\a.md',
        'foo:bar.md',
        '/settings',
        './relative-route',
        '#section'
    ])('does not rewrite non-file / unsafe link url %s', (url) => {
        const nodes = transformNodes([linkNode(url)])
        const link = nodes.find((node) => node.type === 'link')!
        // url is either untouched or still not a hapi-file target
        expect(decodeFilePathHref(link.url as string)).toBeNull()
        expect(link.url).toBe(url)
    })
})

// ── standalone gate: rewriteExplicitLinks:false (file-preview surface) ────────
// The standalone renderer has no HappyChatContext, so a hapi-file: link would
// collapse to plain text. It disables explicit-link rewrite but keeps bare-path
// and inlineCode autolinks (already inert on that surface, so no regression).

describe('remarkFilePathLinks — rewriteExplicitLinks:false', () => {
    function transformStandalone(children: TestNode[]): TestNode[] {
        const tree: TestNode = { type: 'root', children: [{ type: 'paragraph', children }] }
        remarkFilePathLinks({ rewriteExplicitLinks: false })(tree)
        return tree.children?.[0]?.children ?? []
    }

    it('leaves explicit markdown links untouched', () => {
        const nodes = transformStandalone([
            { type: 'link', url: 'docs/foo.md', children: [{ type: 'text', value: 'the docs' }] }
        ])
        const link = nodes.find((node) => node.type === 'link')!
        expect(link.url).toBe('docs/foo.md')
        expect(decodeFilePathHref(link.url as string)).toBeNull()
    })

    it('still autolinks bare paths and inlineCode', () => {
        const nodes = transformStandalone([
            { type: 'text', value: 'see docs/flow.mmd and ' },
            { type: 'inlineCode', value: 'web/src/router.tsx' }
        ])
        const links = nodes.filter((node) => node.type === 'link')
        expect(links.map(linkedPath)).toEqual(['docs/flow.mmd', 'web/src/router.tsx'])
    })
})
