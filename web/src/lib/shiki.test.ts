import type { Root, RootContent } from 'hast'
import { describe, expect, it } from 'vitest'
import { splitCodeLines, splitHastLines } from '@/lib/shiki'

function span(text: string): RootContent {
    return {
        type: 'element',
        tagName: 'span',
        properties: {},
        children: [{ type: 'text', value: text }],
    }
}

function br(): RootContent {
    return { type: 'element', tagName: 'br', properties: {}, children: [] }
}

function root(children: RootContent[]): Root {
    return { type: 'root', children }
}

function lineText(nodes: RootContent[]): string {
    return nodes
        .map((node) =>
            node.type === 'element'
                ? (node.children ?? []).map((c) => (c.type === 'text' ? c.value : '')).join('')
                : node.type === 'text'
                    ? node.value
                    : ''
        )
        .join('')
}

describe('splitHastLines', () => {
    it('splits a multi-line inline hast on <br> boundaries', () => {
        // "const a" <br> "return x" <br> "}"
        const tree = root([span('const a'), br(), span('return x'), br(), span('}')])

        const lines = splitHastLines(tree)

        expect(lines).toHaveLength(3)
        expect(lines.map(lineText)).toEqual(['const a', 'return x', '}'])
    })

    it('returns a single group for code with no line breaks', () => {
        const tree = root([span('const a = 1')])

        const lines = splitHastLines(tree)

        expect(lines).toHaveLength(1)
        expect(lineText(lines[0])).toBe('const a = 1')
    })

    it('preserves a trailing empty line (br at the end)', () => {
        // "a" <br>  -> two lines: "a" and ""
        const tree = root([span('a'), br()])

        const lines = splitHastLines(tree)

        expect(lines).toHaveLength(2)
        expect(lineText(lines[0])).toBe('a')
        expect(lineText(lines[1])).toBe('')
    })

    it('preserves interior empty lines', () => {
        // "a" <br> <br> "b" -> "a", "", "b"
        const tree = root([span('a'), br(), br(), span('b')])

        const lines = splitHastLines(tree)

        expect(lines.map(lineText)).toEqual(['a', '', 'b'])
    })

    it('groups all token spans belonging to one line together', () => {
        // one line made of several tokens, then a break, then another line
        const tree = root([span('const'), span(' '), span('a'), br(), span('b')])

        const lines = splitHastLines(tree)

        expect(lines).toHaveLength(2)
        expect(lines[0]).toHaveLength(3)
        expect(lineText(lines[0])).toBe('const a')
    })
})

describe('splitCodeLines', () => {
    it('splits multi-line code into one entry per line', () => {
        expect(splitCodeLines('a\nb\nc')).toEqual(['a', 'b', 'c'])
    })

    it('drops a single trailing newline so it is not counted as an extra line', () => {
        expect(splitCodeLines('a\nb\n')).toEqual(['a', 'b'])
    })

    it('keeps interior empty lines', () => {
        expect(splitCodeLines('a\n\nb')).toEqual(['a', '', 'b'])
    })

    it('returns a single entry for a one-line string', () => {
        expect(splitCodeLines('const a = 1')).toEqual(['const a = 1'])
    })
})
