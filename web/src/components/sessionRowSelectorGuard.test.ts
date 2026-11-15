import { readdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * The session row's clickable element is a `<div role="button">`, not a
 * native `<button>` — SessionList.tsx switched it deliberately (hapi#238: a
 * focusable PR/issue-ref chip can't be a DOM descendant of a real button per
 * ARIA; a native button also eats Enter/Space before the row's long-press
 * hook can see it). That makes a `button` tag paired with the row's
 * `data-session-scroll-anchor` attribute a permanently stale selector here,
 * even though it's exactly what upstream's own (button-based) row
 * legitimately uses — so every upstream test sync touching session rows is
 * a fresh chance to reintroduce it. Hit three times on tiann/hapi#2147
 * alone before this guard existed; each time only a failing test caught it,
 * never git or tsc, since the file carrying the stale selector had no merge
 * conflict of its own.
 *
 * Built via concatenation, not written as a literal in this file: the guard
 * would otherwise flag itself (the string it searches for would appear in
 * its own source).
 */
const STALE_SELECTOR = 'button' + '[data-session-scroll-anchor]'

function sourceFiles(dir: string): string[] {
    return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
        if (entry.name === 'node_modules' || entry.name === 'dist') return []
        const path = join(dir, entry.name)
        if (entry.isDirectory()) return sourceFiles(path)
        return /\.tsx?$/.test(entry.name) ? [path] : []
    })
}

const ROOTS = [resolve(__dirname, '..'), resolve(__dirname, '../../e2e'), resolve(__dirname, '../../../e2e')]

// Comment-aware so prose discussing the bug (this file's own doc comments,
// or a regression test's description of a past broken selector) doesn't
// trip the check — handles both `/* ... */` / `{/* ... */}` block comments
// and `//` line comments. Crude (doesn't understand strings containing
// comment-like substrings) but sufficient for this codebase.
function stripComments(source: string): string {
    let inBlock = false
    return source.split('\n').map((rawLine) => {
        let line = rawLine
        if (inBlock) {
            const end = line.indexOf('*/')
            if (end === -1) return ''
            line = line.slice(end + 2)
            inBlock = false
        }
        for (;;) {
            const start = line.indexOf('/*')
            if (start === -1) break
            const end = line.indexOf('*/', start + 2)
            if (end === -1) {
                line = line.slice(0, start)
                inBlock = true
                break
            }
            line = line.slice(0, start) + line.slice(end + 2)
        }
        const lineCommentAt = line.indexOf('//')
        return lineCommentAt === -1 ? line : line.slice(0, lineCommentAt)
    }).join('\n')
}

describe('session row selector guard', () => {
    it('never re-adds a button-tag-qualified data-session-scroll-anchor selector', () => {
        // web/src (component + unit tests) and both Playwright trees (e2e/,
        // web/e2e/) — the bot's own soup check found the first two instances
        // via this exact split, a third one landed in a unit test.
        const offenders: string[] = []
        for (const file of ROOTS.flatMap(sourceFiles)) {
            if (file === __filename) continue
            const source = readFileSync(file, 'utf8')
            if (source.includes(STALE_SELECTOR)) {
                offenders.push(file)
            }
        }
        expect(
            offenders,
            'Match the row via [data-session-scroll-anchor] (optionally drilling into its [role="button"] descendant for focus), not a button-tag-qualified selector on it — this fork\'s row is a <div role="button">, not a native <button>.'
        ).toEqual([])
    })

    // The stale-tag check above is one syntax-specific instance of a wider
    // class: `session-list-item` names the ROW (the outer, non-focusable
    // wrapper — scroll anchoring, hover/quick-action CSS, data attributes),
    // while the actual focusable element is a separate inner div
    // (`session-row-control`). Four bugs — a JS test selector, a focus-
    // restoration fallback, a CSS pseudo-class, and the scroll-anchor
    // invariant this file's other test covers — all independently reached
    // for `session-list-item` meaning "the focusable element," because it
    // was the only name in scope at the time. A per-syntax guard will
    // always lag the next syntax (this one only covers JS; the CSS instance
    // slipped past it); this one keys on the semantic co-occurrence instead.
    //
    // No same-line `:has(` escape hatch: an EARLIER version of this check
    // had one, and it was wrong — `:has(.session-list-item:focus-visible)`
    // (the actual bug, nested inside an unrelated OUTER `:has()` wrapping a
    // different element entirely, exactly as index.css's real rule did)
    // still contains the broken pattern and must still be caught. The
    // correct fix (`.session-list-item:has(:focus-visible)`) never produces
    // the literal adjacent substring this checks for in the first place —
    // `:has(` sits between the class and the pseudo-class, not after it —
    // so no exception is needed at all. Caught by planting that exact
    // fixture and confirming the first version of this check went green
    // when it should have gone red.
    it('never directly chains session-list-item with a focus pseudo-class/property', () => {
        const CSS_FOCUS_CHAIN = 'session-list-item:focus'
        const JS_FOCUS_TOKENS = ['.focus(', 'activeElement']
        const offenders: string[] = []
        for (const file of ROOTS.flatMap(sourceFiles)) {
            if (file === __filename) continue
            const lines = stripComments(readFileSync(file, 'utf8')).split('\n')
            lines.forEach((line, index) => {
                const hasCssChain = line.includes(CSS_FOCUS_CHAIN)
                const hasJsCoOccurrence = line.includes('session-list-item') && JS_FOCUS_TOKENS.some(token => line.includes(token))
                if (hasCssChain || hasJsCoOccurrence) {
                    offenders.push(`${file}:${index + 1}`)
                }
            })
        }
        expect(
            offenders,
            'session-list-item names the row (the outer, non-focusable wrapper), not the focusable element — target .session-row-control for focus concerns, or use .session-list-item:has(:focus-visible) (not a direct chain) if it genuinely needs to react to a focus-visible descendant.'
        ).toEqual([])
    })
})
