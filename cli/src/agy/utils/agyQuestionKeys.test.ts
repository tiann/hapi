import { describe, expect, it } from 'vitest'
import { buildAgyQuestionKeys } from './agyQuestionKeys'
import type { AgyAskQuestionQuestion } from './agyAskQuestion'

// Phase 0 ground truth (2026-07-10 isolated agy PTY measurement, pyte-replay
// verified — see plans/2026-07-10-HAPI-AGY-QUESTION-WIRING/PLAN.md §Phase 0):
//   - A bare digit keystroke (no Enter) selects AND submits the Nth listed
//     option in one step, advancing straight to the next question.
//   - Every question gets an agy-appended "Write-in..." option as the last row
//     (index = options.length). Selecting it opens a free-text sub-prompt
//     ("Your answer:") that submits with Enter.
//   - Multi-select footer documents `x` as the toggle key and `enter` submits
//     the whole toggled set; cursor starts at the first (top) option on every
//     fresh question render.
//   - No answer at all -> Escape (Skip), which skips only that one question.

const ESC = '\x1b'
const DOWN = '\x1b[B'
const ENTER = '\r'

function q(question: string, options: string[], multiSelect = false): AgyAskQuestionQuestion {
    return { question, options: options.map((label) => ({ label })), multiSelect }
}

describe('buildAgyQuestionKeys', () => {
    it('single-select: a listed answer sends a single bare digit (no trailing Enter)', () => {
        const questions = [q('Which fruit?', ['Apple', 'Banana', 'Cherry', 'Durian'])]
        const keys = buildAgyQuestionKeys(questions, { '0': ['Cherry'] })
        expect(keys).toBe('3')
    })

    it('single-select: first option is digit 1, not 0', () => {
        const questions = [q('Which fruit?', ['Apple', 'Banana'])]
        expect(buildAgyQuestionKeys(questions, { '0': ['Apple'] })).toBe('1')
        expect(buildAgyQuestionKeys(questions, { '0': ['Banana'] })).toBe('2')
    })

    it('single-select: a free-text (write-in) answer navigates to the Write-in row, submits, types, submits', () => {
        const questions = [q('Pick one', ['Foo', 'Bar'])]
        const keys = buildAgyQuestionKeys(questions, { '0': ['Something else entirely'] })
        // 2 options -> Write-in is row 3 -> 2 Down presses to reach it from row 1.
        expect(keys).toBe(DOWN + DOWN + ENTER + 'Something else entirely' + ENTER)
    })

    it('multi-select: toggles each selected option with x, moving the cursor from the top, then Enter submits', () => {
        const questions = [q('Which colors?', ['Red', 'Green', 'Blue'], true)]
        const keys = buildAgyQuestionKeys(questions, { '0': ['Green', 'Blue'] })
        // cursor starts at Red(0) -> Down to Green(1) -> x -> Down to Blue(2) -> x -> Enter
        expect(keys).toBe(DOWN + 'x' + DOWN + 'x' + ENTER)
    })

    it('multi-select: selections are toggled in ascending option order regardless of answer array order', () => {
        const questions = [q('Which colors?', ['Red', 'Green', 'Blue'], true)]
        const keys = buildAgyQuestionKeys(questions, { '0': ['Blue', 'Red'] })
        // Must visit Red(0) before Blue(2), not in the given answer order.
        expect(keys).toBe('x' + DOWN + DOWN + 'x' + ENTER)
    })

    it('multi-select: a single selection at the top option needs no Down presses', () => {
        const questions = [q('Which colors?', ['Red', 'Green', 'Blue'], true)]
        expect(buildAgyQuestionKeys(questions, { '0': ['Red'] })).toBe('x' + ENTER)
    })

    it('multi-select: an all-free-text answer routes through Write-in (bypasses checkbox toggling)', () => {
        const questions = [q('Which colors?', ['Red', 'Green', 'Blue'], true)]
        const keys = buildAgyQuestionKeys(questions, { '0': ['Some custom color'] })
        expect(keys).toBe(DOWN.repeat(3) + ENTER + 'Some custom color' + ENTER)
    })

    it('no answer for a question sends Escape (Skip) for just that question', () => {
        const questions = [q('Pick one', ['Foo', 'Bar'])]
        expect(buildAgyQuestionKeys(questions, { '0': [] })).toBe(ESC)
        expect(buildAgyQuestionKeys(questions, {})).toBe(ESC)
    })

    it('answers is entirely null -> Escape for every question (skip the whole set)', () => {
        const questions = [q('Q1', ['A']), q('Q2', ['B'])]
        expect(buildAgyQuestionKeys(questions, null)).toBe(ESC + ESC)
    })

    it('concatenates key sequences for multiple questions in declared order', () => {
        const questions = [
            q('Which fruit?', ['Apple', 'Banana', 'Cherry']),
            q('Which colors?', ['Red', 'Green', 'Blue'], true),
        ]
        const keys = buildAgyQuestionKeys(questions, { '0': ['Cherry'], '1': ['Green'] })
        expect(keys).toBe('3' + DOWN + 'x' + ENTER)
    })

    it('an empty questions array produces an empty key sequence', () => {
        expect(buildAgyQuestionKeys([], {})).toBe('')
        expect(buildAgyQuestionKeys([], null)).toBe('')
    })

    it('trims whitespace and ignores case-sensitive-but-otherwise-exact label matching', () => {
        const questions = [q('Pick', ['Foo', 'Bar'])]
        // Exact trim match still resolves to the listed option (not write-in).
        expect(buildAgyQuestionKeys(questions, { '0': ['  Foo  '] })).toBe('1')
    })

    // --- Finding F2: bare-digit select breaks at >= 10 options ---
    // A bare digit selects AND submits immediately (no Enter). For a 1-based
    // position >= 10 that would take TWO keystrokes ("1" then "0" for position
    // 10), but the FIRST digit alone already submits option 1 — wrong AND
    // irreversible — and the second digit leaks into whatever comes next.
    // Positions <= 9 keep using the single bare-digit keystroke; positions
    // >= 10 must navigate with Down presses + Enter instead.
    describe('Finding F2: 10+ option boundary', () => {
        it('position 9 (last single-digit position) still uses a bare digit', () => {
            const options = Array.from({ length: 9 }, (_, i) => `Option ${i + 1}`)
            const questions = [q('Pick', options)]
            expect(buildAgyQuestionKeys(questions, { '0': ['Option 9'] })).toBe('9')
        })

        it('position 10 navigates with Down x9 + Enter instead of the two-digit bare sequence "10"', () => {
            const options = Array.from({ length: 10 }, (_, i) => `Option ${i + 1}`)
            const questions = [q('Pick', options)]
            const keys = buildAgyQuestionKeys(questions, { '0': ['Option 10'] })
            // Must NOT be the bare two-character "10" (that would instantly
            // submit option 1 on the first keystroke, then leak the "0").
            expect(keys).not.toBe('10')
            expect(keys).toBe(DOWN.repeat(9) + ENTER)
        })

        it('position 11 (in an 11-option question) navigates with Down x10 + Enter', () => {
            const options = Array.from({ length: 11 }, (_, i) => `Option ${i + 1}`)
            const questions = [q('Pick', options)]
            const keys = buildAgyQuestionKeys(questions, { '0': ['Option 11'] })
            expect(keys).toBe(DOWN.repeat(10) + ENTER)
        })
    })

    // --- Finding F3: write-in free text must be sanitized ---
    // The web "Other" field is a multiline textarea, so answers can contain
    // \n/\r. agy's free-text sub-prompt submits on \r, so an embedded \r/\n
    // would prematurely submit a partial answer and leak the remainder as
    // keystrokes into whatever prompt is focused next.
    describe('Finding F3: write-in text sanitization', () => {
        it('strips embedded newlines from a single-select write-in answer', () => {
            const questions = [q('Pick one', ['Foo', 'Bar'])]
            const keys = buildAgyQuestionKeys(questions, { '0': ['line1\nline2'] })
            expect(keys).toBe(DOWN + DOWN + ENTER + 'line1 line2' + ENTER)
            // Never contains a raw \r or \n inside the typed text portion.
            expect(keys.slice((DOWN + DOWN + ENTER).length, -ENTER.length)).not.toMatch(/[\r\n]/)
        })

        it('strips embedded CRLF from a write-in answer', () => {
            const questions = [q('Pick one', ['Foo'])]
            const keys = buildAgyQuestionKeys(questions, { '0': ['a\r\nb\r\nc'] })
            expect(keys).toBe(DOWN + ENTER + 'a b c' + ENTER)
        })

        it('strips other control characters (e.g. bell) from a write-in answer', () => {
            const questions = [q('Pick one', ['Foo'])]
            const keys = buildAgyQuestionKeys(questions, { '0': ['ab\x07cd'] })
            expect(keys).toBe(DOWN + ENTER + 'abcd' + ENTER)
        })
    })

    // --- Finding F4: multi-select must not silently drop unmatched values ---
    // When the web submits both matched option labels AND an "Other" string
    // (e.g. ['Green', 'Blue', 'custom']), the prior code only routed through
    // Write-in when NOTHING matched — otherwise it toggled the matched
    // checkboxes and silently discarded every unmatched value. agy's Write-in
    // row replaces the whole checkbox set with one free-text string (there is
    // no keystroke sequence that both toggles checkboxes AND injects free
    // text), so the fix routes the ENTIRE picked set through Write-in whenever
    // any value is unmatched — nothing is silently lost.
    describe('Finding F4: multi-select mixed matched + free text', () => {
        it('routes the entire picked set through Write-in when some values match and one does not', () => {
            const questions = [q('Which colors?', ['Red', 'Green', 'Blue'], true)]
            const keys = buildAgyQuestionKeys(questions, { '0': ['Green', 'Blue', 'custom'] })
            expect(keys).toBe(DOWN.repeat(3) + ENTER + 'Green, Blue, custom' + ENTER)
        })

        it('does not silently drop a single unmatched value mixed with one matched value', () => {
            const questions = [q('Which colors?', ['Red', 'Green'], true)]
            const keys = buildAgyQuestionKeys(questions, { '0': ['Red', 'made-up-color'] })
            expect(keys).toContain('made-up-color')
            expect(keys).toBe(DOWN.repeat(2) + ENTER + 'Red, made-up-color' + ENTER)
        })
    })
})
