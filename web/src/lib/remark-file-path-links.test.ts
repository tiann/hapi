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
})
