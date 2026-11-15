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

describe('session row selector guard', () => {
    it('never re-adds a button-tag-qualified data-session-scroll-anchor selector', () => {
        // web/src (component + unit tests) and both Playwright trees (e2e/,
        // web/e2e/) — the bot's own soup check found the first two instances
        // via this exact split, a third one landed in a unit test.
        const roots = [resolve(__dirname, '..'), resolve(__dirname, '../../e2e'), resolve(__dirname, '../../../e2e')]
        const offenders: string[] = []
        for (const file of roots.flatMap(sourceFiles)) {
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
})
