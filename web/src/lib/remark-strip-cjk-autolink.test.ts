import { describe, expect, it } from 'vitest'
import remarkStripCjkAutolink from '@/lib/remark-strip-cjk-autolink'

/**
 * Unit tests for the remark-strip-cjk-autolink plugin.
 *
 * We test the tree-transform function directly by feeding it MDAST
 * structures that remark-gfm would produce for auto-linked URLs.
 */
describe('remarkStripCjkAutolink', () => {
    const transform = remarkStripCjkAutolink()

    function makeAutolink(url: string, prefix = 'See ', label = url) {
        return {
            type: 'root',
            children: [
                {
                    type: 'paragraph',
                    children: [
                        { type: 'text', value: prefix },
                        {
                            type: 'link',
                            url,
                            children: [{ type: 'text', value: label }]
                        }
                    ]
                }
            ]
        }
    }

    it('strips trailing fullwidth comma from URL', () => {
        const tree = makeAutolink('https://example.com/path，')
        transform(tree)

        const paragraph = tree.children[0]
        const link = paragraph.children[1]
        expect(link.url).toBe('https://example.com/path')
        expect(link.children![0].value).toBe('https://example.com/path')

        // Punctuation moved to a new text node after the link
        const punct = paragraph.children[2]
        expect(punct.type).toBe('text')
        expect(punct.value).toBe('，')
    })

    it('strips trailing ideographic full stop', () => {
        const tree = makeAutolink('https://example.com。')
        transform(tree)

        const paragraph = tree.children[0]
        const link = paragraph.children[1]
        expect(link.url).toBe('https://example.com')
        expect(paragraph.children[2].value).toBe('。')
    })

    it('strips multiple trailing CJK punctuation characters', () => {
        const tree = makeAutolink('https://example.com，。')
        transform(tree)

        const paragraph = tree.children[0]
        const link = paragraph.children[1]
        expect(link.url).toBe('https://example.com')
        expect(paragraph.children[2].value).toBe('，。')
    })

    it('stops the URL at punctuation followed by CJK prose', () => {
        const tree = makeAutolink('https://example.com/path（说明）')
        transform(tree)

        expect(tree.children[0].children).toEqual([
            { type: 'text', value: 'See ' },
            { type: 'link', url: 'https://example.com/path', children: [{ type: 'text', value: 'https://example.com/path' }] },
            { type: 'text', value: '（说明）' },
        ])
    })

    it.each([
        '，后续', '。后续', '！后续', '“说明”', '…后续', '｡next',
    ])('stops at different CJK/fullwidth punctuation: %s', (tail) => {
        const url = 'https://example.com/path'
        const tree = makeAutolink(url + tail)
        transform(tree)

        expect(tree.children[0].children[1]).toMatchObject({ url, children: [{ value: url }] })
        expect(tree.children[0].children[2]).toEqual({ type: 'text', value: tail })
    })

    it('also trims ASCII trailing punctuation exposed by the CJK boundary', () => {
        const tree = makeAutolink(`https://example.com/path.,:;!?'"*_~，后续`)
        transform(tree)

        expect(tree.children[0].children[1].url).toBe('https://example.com/path')
        expect(tree.children[0].children[2].value).toBe(`.,:;!?'"*_~，后续`)
    })

    it.each([
        ['**', 'strong'], ['__', 'strong'], ['*', 'emphasis'], ['_', 'emphasis'], ['~~', 'delete'],
    ])('repairs matching %s delimiters around the URL', (delimiter, type) => {
        const url = 'https://example.com/path'
        const tree = makeAutolink(`${url}${delimiter}，后续`, `See ${delimiter}`)
        transform(tree)

        expect(tree.children[0].children).toEqual([
            { type: 'text', value: 'See ' },
            { type, children: [{ type: 'link', url, children: [{ type: 'text', value: url }] }] },
            { type: 'text', value: '，后续' },
        ])
    })

    it('repairs a wrapper before a bracket-only suffix and removes an empty opening text node', () => {
        const url = 'https://example.com/path'
        const tree = makeAutolink(`${url}**）`, '**')
        transform(tree)

        expect(tree.children[0].children).toEqual([
            { type: 'strong', children: [{ type: 'link', url, children: [{ type: 'text', value: url }] }] },
            { type: 'text', value: '）' },
        ])
    })

    it('leaves mismatched delimiter runs literal', () => {
        const url = 'https://example.com/path'
        const tree = makeAutolink(`${url}*，后续`, 'See **')
        transform(tree)

        expect(tree.children[0].children).toEqual([
            { type: 'text', value: 'See **' },
            { type: 'link', url, children: [{ type: 'text', value: url }] },
            { type: 'text', value: '*，后续' },
        ])
    })

    it('does not pair delimiters across different parents', () => {
        const url = 'https://example.com/path'
        const tree = {
            type: 'paragraph',
            children: [
                { type: 'text', value: '**' },
                { type: 'emphasis', children: [{ type: 'link', url: `${url}**，后续`, children: [{ type: 'text', value: `${url}**，后续` }] }] },
            ],
        }
        transform(tree)

        expect(tree.children).toEqual([
            { type: 'text', value: '**' },
            { type: 'emphasis', children: [
                { type: 'link', url, children: [{ type: 'text', value: url }] },
                { type: 'text', value: '**，后续' },
            ] },
        ])
    })

    it('also repairs www. autolinks without adding http:// to the display text', () => {
        const label = 'www.example.com/path'
        const url = `http://${label}`
        const tree = makeAutolink(`${url}**，后续`, 'See **', `${label}**，后续`)
        transform(tree)

        expect(tree.children[0].children).toEqual([
            { type: 'text', value: 'See ' },
            { type: 'strong', children: [{ type: 'link', url, children: [{ type: 'text', value: label }] }] },
            { type: 'text', value: '，后续' },
        ])
    })

    it('does not modify URLs without CJK trailing punctuation', () => {
        const tree = makeAutolink('https://example.com/path')
        transform(tree)

        const link = tree.children[0].children[1]
        expect(link.url).toBe('https://example.com/path')
        // No extra node inserted
        expect(tree.children[0].children.length).toBe(2)
    })

    it.each([
        'https://example.com/路径/page',
        'https://zh.wikipedia.org/wiki/中文',
        'https://example.com/佐々木',
    ])('does not strip CJK characters that are part of the URL path: %s', (url) => {
        const tree = makeAutolink(url)
        transform(tree)

        const link = tree.children[0].children[1]
        expect(link.url).toBe(url)
        expect(tree.children[0].children.length).toBe(2)
    })

    it('does not strip fullwidth brackets/parens that may be part of the URL', () => {
        const tree = makeAutolink('https://example.com/路径）')
        transform(tree)

        const link = tree.children[0].children[1]
        expect(link.url).toBe('https://example.com/路径）')
        expect(tree.children[0].children.length).toBe(2)
    })

    it('strips sentence-ending punctuation followed by closing bracket', () => {
        const tree = makeAutolink('https://example.com/path。）')
        transform(tree)

        const paragraph = tree.children[0]
        const link = paragraph.children[1]
        expect(link.url).toBe('https://example.com/path')
        expect(paragraph.children[2].value).toBe('。）')
    })

    it('does not modify explicit markdown links', () => {
        // Explicit markdown link: [click here](https://example.com/path）)
        // The link text differs from the URL, so it's not an autolink
        const tree = {
            type: 'root',
            children: [
                {
                    type: 'paragraph',
                    children: [
                        {
                            type: 'link',
                            url: 'https://example.com/path）',
                            children: [{ type: 'text', value: 'click here' }]
                        }
                    ]
                }
            ]
        }
        transform(tree)

        const link = tree.children[0].children[0]
        expect(link.url).toBe('https://example.com/path）')
        expect(tree.children[0].children.length).toBe(1)
    })
})
