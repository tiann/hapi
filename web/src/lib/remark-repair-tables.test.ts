import { describe, expect, it } from 'vitest'
import remarkParse from 'remark-parse'
import remarkGfm from 'remark-gfm'
import remarkStringify from 'remark-stringify'
import { unified } from 'unified'
import remarkRepairTables, { repairMarkdownTables } from './remark-repair-tables'

function process(md: string): string {
    return unified()
        .use(remarkParse)
        .use(remarkGfm)
        .use(remarkRepairTables)
        .use(remarkStringify)
        .processSync(md)
        .toString()
}

/**
 * Returns table rows from the stringified output.
 * A proper table row starts with | (not \| which is escaped paragraph content).
 */
function tableRows(md: string): string[] {
    return md.split('\n').filter(l => {
        const t = l.trim()
        return t.startsWith('|') && !t.startsWith('\\|')
    })
}

// ── String-level function ────────────────────────────────────────────────────

describe('repairMarkdownTables (string)', () => {
    it('pads a 2-cell separator for a 3-column header', () => {
        const input = '| A | B | C |\n|---|---|\n| x | y | z |\n'
        const out = repairMarkdownTables(input)
        expect(out).not.toBe(input)
        // Separator line should now have 3 cells
        const sepLine = out.split('\n')[1]
        expect(sepLine.split('|').filter(c => c.trim()).length).toBe(3)
    })

    it('pads a 1-cell separator for a 4-column header', () => {
        const input = '| W | X | Y | Z |\n|---|\n| a | b | c | d |\n'
        const out = repairMarkdownTables(input)
        const sepLine = out.split('\n')[1]
        expect(sepLine.split('|').filter(c => c.trim()).length).toBe(4)
    })

    it('returns the source unchanged when separator already matches', () => {
        const input = '| A | B | C |\n|---|---|---|\n| x | y | z |\n'
        expect(repairMarkdownTables(input)).toBe(input)
    })

    it('does not modify separator lines not following a |-starting row', () => {
        const input = 'Some prose\n|---|---|\n| x | y | z |\n'
        expect(repairMarkdownTables(input)).toBe(input)
    })

    it('does not modify table-like lines inside a fenced code block', () => {
        const input = [
            'Here is an example:',
            '```',
            '| A | B | C |',
            '|---|---|',
            '| x | y | z |',
            '```',
            '',
        ].join('\n')
        expect(repairMarkdownTables(input)).toBe(input)
    })

    it('does not modify table-like lines inside a ~~~ fenced code block', () => {
        const input = '~~~\n| A | B | C |\n|---|---|\n| x | y | z |\n~~~\n'
        expect(repairMarkdownTables(input)).toBe(input)
    })

    it('does not pad a valid table whose header contains a code span with a pipe', () => {
        // | `a | b` | c |  is a 2-column header; separator has 2 cells — valid
        const input = '| `a | b` | c |\n|---|---|\n| x | y |\n'
        expect(repairMarkdownTables(input)).toBe(input)
    })

    it('does not close a ```` fence on a ``` line (closer must be >= opener length)', () => {
        const input = [
            '````',
            '```',
            '| A | B | C |',
            '|---|---|',
            '| x | y | z |',
            '```',
            '````',
            '',
        ].join('\n')
        expect(repairMarkdownTables(input)).toBe(input)
    })

    it('does not close a ~~~~ fence on a ~~~ line (closer must be >= opener length)', () => {
        const input = [
            '~~~~',
            '~~~',
            '| A | B | C |',
            '|---|---|',
            '| x | y | z |',
            '~~~',
            '~~~~',
            '',
        ].join('\n')
        expect(repairMarkdownTables(input)).toBe(input)
    })

    it('does not flip fence state when ``` appears inside a ~~~ block', () => {
        const input = [
            '~~~',
            '```',
            '| A | B | C |',
            '|---|---|',
            '| x | y | z |',
            '```',
            '~~~',
            '',
        ].join('\n')
        expect(repairMarkdownTables(input)).toBe(input)
    })

    it('repairs a broken table after a fenced code block closes', () => {
        const input = [
            '```',
            '| A | B | C |',
            '|---|---|',
            '```',
            '| A | B | C |',
            '|---|---|',
            '| x | y | z |',
        ].join('\n')
        const out = repairMarkdownTables(input)
        // Lines inside the fence should be unchanged
        expect(out.split('\n')[2]).toBe('|---|---|')
        // The real table after the fence should be repaired
        const sepLine = out.split('\n')[5]
        expect(sepLine.split('|').filter(c => c.trim()).length).toBe(3)
    })
})

// ── Plugin (parse + transform + stringify) ────────────────────────────────────

describe('remarkRepairTables (plugin)', () => {
    it('leaves a valid 3-column table unchanged', () => {
        const md = '| A | B | C |\n|---|---|---|\n| x | y | z |\n'
        const out = process(md)
        // Must render as table rows (no escaped \|)
        const rows = tableRows(out)
        expect(rows.length).toBeGreaterThanOrEqual(3)
        expect(out).toContain('| A |')
        expect(out).toContain('| C |')
    })

    it('repairs separator with 2 cells for a 3-column header', () => {
        const md = '| A | B | C |\n|---|---|\n| x | y | z |\n'
        const out = process(md)
        // Must render as a table — no escaped \| prefix
        const rows = tableRows(out)
        expect(rows.length).toBeGreaterThanOrEqual(2)
        // All 3 header columns survive as proper table cells
        expect(out).toContain('| A |')
        expect(out).toContain('| B |')
        expect(out).toContain('| C |')
    })

    it('repairs separator with 1 cell for a 4-column header', () => {
        const md = '| W | X | Y | Z |\n|---|\n| a | b | c | d |\n'
        const out = process(md)
        expect(out).toContain('| W |')
        expect(out).toContain('| Z |')
        expect(tableRows(out).length).toBeGreaterThanOrEqual(2)
    })

    it('preserves alignment hints in existing separator cells', () => {
        const md = '| A | B | C |\n|:---|---:|\n| x | y | z |\n'
        const out = process(md)
        expect(out).toContain('| C |')
        const rows = tableRows(out)
        expect(rows.length).toBeGreaterThanOrEqual(2)
    })

    it('does not corrupt a valid table with an escaped pipe in the header', () => {
        // | A \| B | C |  is a 2-column header (the \| is a literal pipe, not a delimiter)
        // separator has 2 cells — valid, must not be padded to 3
        const md = '| A \\| B | C |\n|---|---|\n| x | y |\n'
        const out = process(md)
        const sepRow = out.split('\n').find(l => /^\|[\s|:|-]+\|$/.test(l.trim()))
        expect(sepRow).toBeDefined()
        expect(sepRow!.split('|').filter(c => c.trim()).length).toBe(2)
    })

    it('does not modify a table where separator already matches', () => {
        const md = '| A | B |\n|---|---|\n| x | y |\n'
        const out = process(md)
        expect(out).toContain('| A |')
        expect(out).toContain('| B |')
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
        // First table repaired — C must be in a proper table row
        expect(out).toContain('| C |')
        // Second table unchanged and intact
        expect(out).toContain('| P |')
        expect(out).toContain('| Q |')
    })

    it('does not touch pipe characters in code spans or prose', () => {
        const md = 'Use `foo | bar` for piping.\n'
        const out = process(md)
        expect(out).toContain('foo | bar')
    })

    it('ignores a paragraph that merely contains pipe characters', () => {
        const md = 'Run: `jq \'.[] | select(.active)\'`\n'
        const out = process(md)
        expect(out).toContain('jq')
    })
})
