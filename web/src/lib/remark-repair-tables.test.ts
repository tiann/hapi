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
        // Structural check: each output row has exactly 3 pipe-delimited cells
        const rows = out.trim().split('\n').filter(l => l.trim().startsWith('|'))
        for (const row of rows) {
            const cells = row.split('|').filter(c => c.trim())
            expect(cells).toHaveLength(3)
        }
    })

    it('repairs separator with 1 cell for a 4-column header', () => {
        const md = '| W | X | Y | Z |\n|---|\n| a | b | c | d |\n'
        const out = process(md)
        expect(out).toContain('W')
        expect(out).toContain('Z')
        expect(out).toContain('a')
        expect(out).toContain('d')
        const rows = out.trim().split('\n').filter(l => l.trim().startsWith('|'))
        for (const row of rows) {
            expect(row.split('|').filter(c => c.trim())).toHaveLength(4)
        }
    })

    it('repairs separator without surrounding pipes', () => {
        const md = '| A | B | C |\n---|---\n| x | y | z |\n'
        const out = process(md)
        expect(out).toContain('C')
        expect(out).toContain('z')
    })

    it('preserves alignment hints in the separator cells that exist', () => {
        // :--- = left, ---: = right — these must survive in the repaired separator
        const md = '| A | B | C |\n|:---|---:|\n| x | y | z |\n'
        const out = process(md)
        expect(out).toContain('C')
        expect(out).toContain('z')
        // remark-stringify reflects alignment as :-- and --: in the separator row
        expect(out).toMatch(/:--/)
        expect(out).toMatch(/--:/)
        const rows = out.trim().split('\n').filter(l => l.trim().startsWith('|'))
        for (const row of rows) {
            expect(row.split('|').filter(c => c.trim())).toHaveLength(3)
        }
    })

    it('handles a header-only table (no data rows)', () => {
        // Some agents emit tables with only a header + broken separator and no data rows
        const md = '| A | B | C |\n|---|\n'
        const out = process(md)
        expect(out).toContain('A')
        expect(out).toContain('B')
        expect(out).toContain('C')
        const rows = out.trim().split('\n').filter(l => l.trim().startsWith('|'))
        for (const row of rows) {
            expect(row.split('|').filter(c => c.trim())).toHaveLength(3)
        }
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
