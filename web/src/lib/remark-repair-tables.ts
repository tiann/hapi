/**
 * Remark plugin that repairs GFM tables where the separator row has fewer
 * columns than the header row.
 *
 * Background: remark-gfm follows the GFM spec — the delimiter row controls
 * the column count. If an agent emits:
 *
 *   | A | B | C |
 *   |---|---|        ← only 2 cells; column C is silently dropped
 *   | x | y | z |
 *
 * remark-gfm produces a 2-column table and discards C/z entirely. This plugin
 * runs after remark-gfm, detects the mismatch by comparing the original source
 * (available via `file.value`) against the parsed column count, pads the
 * separator, and re-parses just that table block so all columns are preserved.
 *
 * Only the dominant failure pattern is repaired (separator off-by-one or
 * off-by-N). Other failures (missing separator entirely, severe column
 * mismatches in data rows) are left for the agent patch-request path.
 */

import remarkGfm from 'remark-gfm'
import remarkParse from 'remark-parse'
import { unified } from 'unified'
import type { Root, Table, TableRow, TableCell } from 'mdast'
import type { VFile } from 'vfile'

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Count pipe-delimited cells in one table row line of raw source. */
function countSourceCells(line: string): number {
    const trimmed = line.trim()
    // Strip optional surrounding pipes before splitting
    const inner = (trimmed.startsWith('|') ? trimmed.slice(1) : trimmed)
    const stripped = inner.endsWith('|') ? inner.slice(0, -1) : inner
    return stripped.split('|').length
}

/**
 * Pad `sepLine` to have `targetCols` cells.  Returns the repaired line, or
 * null if `sepLine` already has enough cells or doesn't look like a separator.
 */
function padSeparatorLine(sepLine: string, targetCols: number): string | null {
    const trimmed = sepLine.trim()
    if (!trimmed) return null

    const hasLeading = trimmed.startsWith('|')
    const hasTrailing = trimmed.endsWith('|')

    const inner = hasLeading ? trimmed.slice(1) : trimmed
    const stripped = inner.endsWith('|') ? inner.slice(0, -1) : inner
    const cells = stripped.split('|')

    if (cells.length >= targetCols) return null

    // Verify it's a separator row (cells should look like /^\s*:?-+:?\s*$/)
    const isSep = cells.every(c => /^\s*:?-+:?\s*$/.test(c))
    if (!isSep) return null

    const extra = Array(targetCols - cells.length).fill(' --- ')
    const paddedInner = [...cells, ...extra].join('|')
    return (hasLeading ? '|' : '') + paddedInner + (hasTrailing ? '|' : '')
}

/** Re-parse a repaired raw table string and extract the first table node. */
function parseTableBlock(source: string): Table | null {
    const tree = unified().use(remarkParse).use(remarkGfm).parse(source) as Root
    for (const node of tree.children) {
        if (node.type === 'table') return node as Table
    }
    return null
}

// ── Plugin ───────────────────────────────────────────────────────────────────

interface MdastParent {
    children: (Table | { type: string })[]
}

function visitTables(
    node: { type: string; children?: unknown[]; align?: unknown; position?: { start: { offset: number }; end: { offset: number } } },
    parent: MdastParent | null,
    index: number,
    source: string
): void {
    if (node.type === 'table' && parent && node.position && Array.isArray(node.align)) {
        const tableSource = source.slice(node.position.start.offset, node.position.end.offset)
        const lines = tableSource.split('\n')

        if (lines.length >= 2) {
            const headerCols = countSourceCells(lines[0])
            const sepCols = (node.align as unknown[]).length

            if (headerCols > sepCols && lines[1]) {
                const repairedSep = padSeparatorLine(lines[1], headerCols)
                if (repairedSep) {
                    const newLines = [...lines]
                    newLines[1] = repairedSep
                    const repaired = parseTableBlock(newLines.join('\n'))
                    if (repaired) {
                        parent.children.splice(index, 1, repaired as unknown as Table)
                        return
                    }
                }
            }
        }
    }

    if (Array.isArray(node.children)) {
        for (let i = 0; i < node.children.length; i++) {
            visitTables(
                node.children[i] as typeof node,
                node as unknown as MdastParent,
                i,
                source
            )
        }
    }
}

export default function remarkRepairTables() {
    return (tree: Root, file: VFile) => {
        const source = String(file.value)
        visitTables(tree as unknown as Parameters<typeof visitTables>[0], null, 0, source)
    }
}
