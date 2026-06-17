/**
 * Remark plugin that repairs GFM tables where the separator row has fewer
 * columns than the header row.
 *
 * Background: remark-gfm 4.x follows the GFM spec strictly — if the delimiter
 * row has fewer cells than the header row, the entire block is degraded to a
 * paragraph (no table node is produced at all). The previous approach of
 * visiting `table` AST nodes could never trigger because remark-gfm never
 * produced one. This version operates at the source level: it scans file.value
 * for broken separator rows and pads them BEFORE remark-gfm parses, so the
 * table is preserved with all columns intact.
 */

import type { Processor } from 'unified'
import type { Root } from 'mdast'
import type { VFile } from 'vfile'

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Count pipe-delimited cells in one table row line of raw source.
 *  Skips escaped pipes (\|) which are literal characters, not cell boundaries. */
function countSourceCells(line: string): number {
    const trimmed = line.trim()
    const inner = trimmed.startsWith('|') ? trimmed.slice(1) : trimmed
    const stripped = inner.endsWith('|') ? inner.slice(0, -1) : inner
    let cells = 1
    let escaped = false
    for (const ch of stripped) {
        if (escaped) { escaped = false; continue }
        if (ch === '\\') { escaped = true; continue }
        if (ch === '|') cells++
    }
    return cells
}

/** Returns true if every pipe-delimited cell in the line matches the GFM separator pattern. */
function isSeparatorLine(line: string): boolean {
    const trimmed = line.trim()
    if (!trimmed.includes('-')) return false
    const inner = trimmed.startsWith('|') ? trimmed.slice(1) : trimmed
    const stripped = inner.endsWith('|') ? inner.slice(0, -1) : inner
    const cells = stripped.split('|')
    return cells.length > 0 && cells.every(c => /^\s*:?-+:?\s*$/.test(c))
}

/** Count cells in a separator line (returns null if line is not a separator). */
function countSeparatorCells(line: string): number | null {
    if (!isSeparatorLine(line)) return null
    const trimmed = line.trim()
    const inner = trimmed.startsWith('|') ? trimmed.slice(1) : trimmed
    const stripped = inner.endsWith('|') ? inner.slice(0, -1) : inner
    return stripped.split('|').length
}

/**
 * Pad `sepLine` to have `targetCols` cells, preserving any existing alignment
 * hints in the cells that are already there. Returns the repaired line, or
 * null if the line already has enough cells or is not a valid separator.
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
    if (!cells.every(c => /^\s*:?-+:?\s*$/.test(c))) return null

    const extra = Array(targetCols - cells.length).fill(' --- ')
    const paddedInner = [...cells, ...extra].join('|')
    return (hasLeading ? '|' : '') + paddedInner + (hasTrailing ? '|' : '')
}

// ── String-level preprocessor ─────────────────────────────────────────────────

/**
 * Scan raw markdown for broken table separators and pad them in-place.
 * This must run before any markdown parser sees the source, because
 * remark-gfm 4.x degrades a mismatched-separator table block to a paragraph.
 *
 * Tracks fenced code blocks so table-like lines inside ``` or ~~~ fences are
 * never modified. Also preserves leading whitespace when replacing the
 * separator line so indented tables are not affected.
 */
export function repairMarkdownTables(source: string): string {
    const lines = source.split('\n')
    let changed = false
    let inFence = false

    for (let i = 0; i < lines.length; i++) {
        // Toggle fenced-code state on ``` / ~~~ opening/closing lines
        if (/^\s*(```|~~~)/.test(lines[i])) {
            inFence = !inFence
            continue
        }
        if (inFence) continue
        if (i === 0) continue

        const sep = lines[i]
        if (!isSeparatorLine(sep)) continue

        const hdr = lines[i - 1]
        // Only repair when the header row starts with | (the common LLM output form)
        if (!hdr.trim().startsWith('|')) continue

        const headerCols = countSourceCells(hdr)
        const sepCols = countSeparatorCells(sep)
        if (sepCols === null || sepCols >= headerCols) continue

        const repaired = padSeparatorLine(sep, headerCols)
        if (repaired !== null) {
            // Preserve original leading whitespace so indented tables are unchanged
            const prefix = sep.match(/^\s*/)?.[0] ?? ''
            lines[i] = prefix + repaired.trimStart()
            changed = true
        }
    }

    return changed ? lines.join('\n') : source
}

// ── Plugin ───────────────────────────────────────────────────────────────────

export default function remarkRepairTables(this: Processor) {
    const processor = this
    return (tree: Root, file: VFile) => {
        const original = String(file.value)
        const repaired = repairMarkdownTables(original)
        if (repaired === original) return

        // Re-parse with the repaired source so remark-gfm produces table nodes
        // processor.parse() runs only the parse phase, not transformers
        const newTree = processor.parse(repaired) as Root
        tree.children = newTree.children
    }
}
