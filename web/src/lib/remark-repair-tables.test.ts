import { describe, expect, it } from 'vitest'
import remarkParse from 'remark-parse'
import remarkGfm from 'remark-gfm'
import remarkStringify from 'remark-stringify'
import { unified } from 'unified'
import remarkRepairTables from './remark-repair-tables'

function process(md: string): string {
    return unified()
        .use(remarkParse)
        .use(remarkGfm)
        .use(remarkRepairTables)
        .use(remarkStringify)
        .processSync(md)
        .toString()
}

/** Count <th> / <td> cells in a stringified table row. */
function parseTableCols(md: string): number[][] {
    // remark-stringify outputs | cell | cell | rows
    const rows = md.split('\n').filter(l => l.trim().startsWith('|') && !l.trim().match(/^\|[\s|:-]+\|$/))
    return rows.map(row => {
        const inner = row.trim().replace(/^\||\|$/g, '')
        return inner.split('|').map(c => c.trim())
    }).map(cells => cells.map(c => c.length))
}

describe('remarkRepairTables', () => {
    it('leaves a valid 3-column table unchanged', () => {
        const md = '| A | B | C |\n|---|---|---|\n| x | y | z |\n'
        const out = process(md)
        expect(out).toContain('| A |')
        expect(out).toContain('| C |')
    })

    it('repairs separator with 2 cells for a 3-column header', () => {
        const md = '| A | B | C |\n|---|---|\n| x | y | z |\n'
        const out = process(md)
        // All 3 header columns must survive
        expect(out).toContain('A')
        expect(out).toContain('B')
        expect(out).toContain('C')
        // All 3 data cells must survive
        expect(out).toContain('x')
        expect(out).toContain('y')
        expect(out).toContain('z')
    })

    it('repairs separator with 1 cell for a 4-column header', () => {
        const md = '| W | X | Y | Z |\n|---|\n| a | b | c | d |\n'
        const out = process(md)
        expect(out).toContain('W')
        expect(out).toContain('Z')
        expect(out).toContain('a')
        expect(out).toContain('d')
    })

    it('repairs separator without surrounding pipes', () => {
        const md = '| A | B | C |\n---|---\n| x | y | z |\n'
        const out = process(md)
        expect(out).toContain('C')
        expect(out).toContain('z')
    })

    it('preserves alignment hints in the separator cells that exist', () => {
        const md = '| A | B | C |\n|:---|---:|\n| x | y | z |\n'
        const out = process(md)
        expect(out).toContain('C')
        expect(out).toContain('z')
    })

    it('does not modify a table where separator already matches', () => {
        const md = '| A | B |\n|---|---|\n| x | y |\n'
        const out = process(md)
        expect(out).toContain('A')
        expect(out).toContain('B')
    })

    it('handles multiple tables — repairs broken, leaves valid untouched', () => {
        const md = [
            '| A | B | C |',
            '|---|---|',
            '| x | y | z |',
            '',
            '| P | Q |',
            '|---|---|',
            '| 1 | 2 |',
        ].join('\n') + '\n'
        const out = process(md)
        // First table repaired
        expect(out).toContain('C')
        expect(out).toContain('z')
        // Second table unchanged
        expect(out).toContain('P')
        expect(out).toContain('Q')
    })

    it('does not touch pipe characters in code spans or prose', () => {
        const md = 'Use `foo | bar` for piping.\n'
        const out = process(md)
        expect(out).toContain('foo | bar')
    })

    it('ignores a paragraph that merely contains pipe characters', () => {
        const md = 'Run: `jq \'.[] | select(.active)\'`\n'
        const out = process(md)
        // Should not throw and should leave content intact
        expect(out).toContain('jq')
    })
})
