import { describe, expect, it } from 'vitest'
import { remarkSessionPathLinks } from './remark-session-path-links'

type Node = {
    type?: string
    value?: string
    url?: string
    children?: Node[]
}

function textTree(text: string): Node {
    return {
        type: 'root',
        children: [{ type: 'paragraph', children: [{ type: 'text', value: text }] }],
    }
}

function collectLinks(node: Node, out: { url?: string; text: string }[] = []) {
    if (node.type === 'link') {
        const text = (node.children ?? []).map((c) => c.value ?? '').join('')
        out.push({ url: node.url, text })
    }
    for (const child of node.children ?? []) collectLinks(child, out)
    return out
}

describe('remarkSessionPathLinks', () => {
    it('linkifies bare /sessions/<id> in a citation sentence', () => {
        const tree = textTree(
            'See session "upstream issue/pr discovery" (/sessions/abc-def) for context'
        )
        remarkSessionPathLinks()(tree)
        expect(collectLinks(tree)).toEqual([
            { url: '/sessions/abc-def', text: '/sessions/abc-def' },
        ])
    })

    it('does not rewrite paths already inside a link', () => {
        const tree: Node = {
            type: 'root',
            children: [
                {
                    type: 'paragraph',
                    children: [
                        {
                            type: 'link',
                            url: '/sessions/abc-def',
                            children: [{ type: 'text', value: '/sessions/abc-def' }],
                        },
                    ],
                },
            ],
        }
        remarkSessionPathLinks()(tree)
        expect(collectLinks(tree)).toHaveLength(1)
    })

    it('ignores non-session paths', () => {
        const tree = textTree('see /settings/general and ./src/foo.ts')
        remarkSessionPathLinks()(tree)
        expect(collectLinks(tree)).toEqual([])
    })

    it('does not steal source paths under a sessions/ directory', () => {
        const tree = textTree(
            'lives in web/src/routes/sessions/chat.tsx for this view'
        )
        remarkSessionPathLinks()(tree)
        expect(collectLinks(tree)).toEqual([])
    })
})
