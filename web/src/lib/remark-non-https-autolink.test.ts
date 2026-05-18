import { describe, expect, it } from 'vitest'
import remarkNonHttpsAutolink from '@/lib/remark-non-https-autolink'

/**
 * Unit tests for remark-non-https-autolink.
 *
 * We test the tree-transform function directly by feeding it MDAST
 * structures. The plugin converts raw "scheme://..." text in paragraph
 * text nodes into link nodes, skipping http/https (handled by GFM),
 * explicit markdown links, and code blocks/inline code.
 */
describe('remarkNonHttpsAutolink', () => {
    const transform = remarkNonHttpsAutolink()

    function makeRoot(children: any[]) { return { type: 'root', children } as any }
    function makeParagraph(children: any[]) { return { type: 'paragraph', children } as any }
    function makeText(value: string) { return { type: 'text', value } as any }
    function makeLink(url: string, textValue: string) {
        return { type: 'link', url, children: [{ type: 'text', value: textValue }] } as any
    }
    function makeCode(lang: string, value: string) { return { type: 'code', lang, value } as any }
    function makeInlineCode(value: string) { return { type: 'inlineCode', value } as any }

    // ── Basic autolink ───────────────────────────────────────────────────

    it('converts obsidian:// raw URI in text to a link node', () => {
        const tree = makeRoot([makeParagraph([makeText('Check obsidian://open?vault=V&file=F here')])])
        transform(tree)
        const para = tree.children[0]
        expect(para.children[0]).toMatchObject({ type: 'text', value: 'Check ' })
        expect(para.children[1]).toMatchObject({ type: 'link', url: 'obsidian://open?vault=V&file=F' })
        expect(para.children[2]).toMatchObject({ type: 'text', value: ' here' })
    })

    it.each([
        ['vscode://file/path/to/file', 'Open vscode://file/path/to/file'],
        ['slack://channel?team=T123', 'Join slack://channel?team=T123'],
    ])('converts %s URI to a link node', (expectedUrl, inputText) => {
        const tree = makeRoot([makeParagraph([makeText(inputText)])])
        transform(tree)
        const link = tree.children[0].children.find((c: any) => c.type === 'link')
        expect(link?.url).toBe(expectedUrl)
    })

    it('sets the link text to the full URI (autolink style)', () => {
        const tree = makeRoot([makeParagraph([makeText('obsidian://vault/file')])])
        transform(tree)
        const link = tree.children[0].children[0]
        expect(link.children[0].value).toBe('obsidian://vault/file')
    })

    // ── http/https NOT converted (GFM handles those) ─────────────────────

    it.each([
        'http://example.com',
        'https://example.com',
    ])('does NOT convert %s (GFM handles those)', (url) => {
        const tree = makeRoot([makeParagraph([makeText(`Visit ${url}`)])])
        transform(tree)
        const links = tree.children[0].children.filter((c: any) => c.type === 'link')
        expect(links.length).toBe(0)
    })

    // ── Existing link nodes not touched ──────────────────────────────────

    it('does not modify an existing explicit markdown link node', () => {
        const existingLink = makeLink('obsidian://open', 'My Note')
        const tree = makeRoot([makeParagraph([existingLink])])
        transform(tree)
        const para = tree.children[0]
        expect(para.children.length).toBe(1)
        expect(para.children[0]).toMatchObject({ type: 'link', url: 'obsidian://open' })
        expect(para.children[0].children[0].value).toBe('My Note')
    })

    // ── Code blocks / inline code not touched ────────────────────────────

    it('does not linkify URIs inside code blocks', () => {
        const tree = makeRoot([makeCode('sh', 'open obsidian://vault/file')])
        transform(tree)
        expect(tree.children[0].type).toBe('code')
        expect(tree.children[0].value).toBe('open obsidian://vault/file')
    })

    it('does not linkify URIs inside inline code', () => {
        const tree = makeRoot([makeParagraph([makeInlineCode('obsidian://vault/file')])])
        transform(tree)
        expect(tree.children[0].children[0].type).toBe('inlineCode')
    })

    // ── Trailing punctuation handling ────────────────────────────────────

    it.each([
        ['period',         'See obsidian://open?vault=V.',  'obsidian://open?vault=V',  '.'],
        ['comma',          'Link obsidian://open,',          'obsidian://open',           ','],
        ['closing paren',  'See (obsidian://open)',           'obsidian://open',           ')'],
    ])('strips trailing %s from the linked URL', (_label, inputText, expectedUrl, expectedTrailing) => {
        const tree = makeRoot([makeParagraph([makeText(inputText)])])
        transform(tree)
        const para = tree.children[0]
        const link = para.children.find((c: any) => c.type === 'link')
        expect(link?.url).toBe(expectedUrl)
        const trailingText = para.children[para.children.indexOf(link) + 1]
        expect(trailingText?.value).toContain(expectedTrailing)
    })

    // ── Balanced paren/bracket preservation (GFM autolink literal behaviour) ───

    it.each([
        ['balanced paren in URL', 'obsidian://open?file=Note(1)',   'obsidian://open?file=Note(1)'],
        ['balanced bracket in URL', 'obsidian://open?file=Note[1]', 'obsidian://open?file=Note[1]'],
        ['nested balanced parens', 'obsidian://open?q=(a(b)c)',     'obsidian://open?q=(a(b)c)'],
    ])('keeps %s inside the linked URL', (_label, inputText, expectedUrl) => {
        const tree = makeRoot([makeParagraph([makeText(inputText)])])
        transform(tree)
        const link = tree.children[0].children.find((c: any) => c.type === 'link')
        expect(link?.url).toBe(expectedUrl)
        // No trailing text node should be emitted for a balanced URL.
        expect(tree.children[0].children.length).toBe(1)
    })

    it('strips period after a balanced-paren URL but keeps the parens', () => {
        const tree = makeRoot([makeParagraph([makeText('See obsidian://open?file=Note(1).')])])
        transform(tree)
        const para = tree.children[0]
        const link = para.children.find((c: any) => c.type === 'link')
        expect(link?.url).toBe('obsidian://open?file=Note(1)')
        const trailingText = para.children[para.children.indexOf(link) + 1]
        expect(trailingText?.value).toBe('.')
    })

    it('strips an unmatched closing paren (no opener in URL body)', () => {
        const tree = makeRoot([makeParagraph([makeText('(see obsidian://x).')])])
        transform(tree)
        const para = tree.children[0]
        const link = para.children.find((c: any) => c.type === 'link')
        expect(link?.url).toBe('obsidian://x')
        const trailingText = para.children[para.children.indexOf(link) + 1]
        expect(trailingText?.value).toBe(').')
    })

    // ── Multiple URIs in one text node ───────────────────────────────────

    it('converts multiple non-https URIs in the same text node', () => {
        const tree = makeRoot([
            makeParagraph([makeText('A: obsidian://vault/a and B: vscode://file/b done')])
        ])
        transform(tree)
        const links = tree.children[0].children.filter((c: any) => c.type === 'link')
        expect(links.length).toBe(2)
        expect(links[0].url).toBe('obsidian://vault/a')
        expect(links[1].url).toBe('vscode://file/b')
    })

    // ── Scheme-only / edge cases ─────────────────────────────────────────

    it('does not linkify a bare scheme without "://"', () => {
        // mailto: without // is valid URI but our plugin targets scheme:// only
        const tree = makeRoot([makeParagraph([makeText('mailto:user@example.com')])])
        transform(tree)
        const links = tree.children[0].children.filter((c: any) => c.type === 'link')
        expect(links.length).toBe(0)
    })
})
