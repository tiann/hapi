/**
 * Pure key-sequence builder for answering agy's native `ask_question` TUI
 * selector via raw PTY keystroke injection (`ptyControls.sendKeys`).
 *
 * agy has no hook-level answer-injection path (no `updatedInput` in its
 * PreToolUse stdout spec — see agyPermissionHandler.ts), so the only way to
 * deliver an answer to a question already rendered in the TUI is to drive the
 * SAME keys a human would type. The exact mechanics below are Phase 0 ground
 * truth from an isolated agy PTY measurement (2026-07-10, pyte-replay
 * verified — see plans/2026-07-10-HAPI-AGY-QUESTION-WIRING/PLAN.md):
 *   - Single-select: a bare digit keystroke (no Enter) selects AND submits
 *     the Nth listed option (1-based) in one step, advancing to the next
 *     question immediately.
 *   - Every question gets an agy-appended "Write-in..." option as the last
 *     row (index = options.length, i.e. one past the last listed option).
 *     Selecting it opens a free-text sub-prompt ("Your answer:") that
 *     submits with Enter.
 *   - Multi-select: `x` is the toggle key — EMPIRICALLY CONFIRMED (Finding
 *     F5, 2026-07-10 follow-up probe): an isolated throwaway agy session was
 *     spawned via Bun's native PTY (`Bun.spawn(..., { terminal: {...} })`,
 *     same technique as AgentPtyManager) in a fresh scratch cwd, asked a
 *     multi-select question ("Which colors do you like?" / Red, Green,
 *     Blue), and a single `x` keystroke was sent and the raw byte stream
 *     replayed through pyte (VT100 emulator). The row's checkbox rendered
 *     `1. [ ] Red` before the keystroke and `1. [x] Red` after — reproduced
 *     once, cleanly, with a screen diff (see the question-wiring plan doc,
 *     §Phase 0 addendum, for the before/after screen excerpt). A follow-up
 *     space keystroke had no further effect, consistent with the original
 *     Phase 0 observation that space is not the toggle key. Cursor starts at
 *     the first (top) option on every fresh question render, and Enter
 *     submits the toggled set. Selecting Write-in on a multi-select question
 *     bypasses the checkboxes entirely and resolves the question with a
 *     single free-text answer.
 *   - No answer -> Escape (Skip), which skips only that one question.
 */

import type { AgyAskQuestionQuestion } from './agyAskQuestion'

const ESC = '\x1b'
const DOWN = '\x1b[B'
const ENTER = '\r'

export type AgyQuestionAnswers = Record<string, string[]>

function normalizeAnswer(values: string[] | undefined): string[] {
    if (!values) return []
    return values.map((v) => v.trim()).filter((v) => v.length > 0)
}

/**
 * Strip characters from a write-in answer that would be misinterpreted as
 * keystrokes by agy's free-text sub-prompt (Finding F3). The web "Other"
 * field is a multiline textarea, so an answer can contain \n/\r; agy's
 * sub-prompt submits on \r, so an embedded \r/\n would prematurely submit a
 * partial answer and leak the remainder as keystrokes into whatever prompt
 * is focused next. Newlines are collapsed to a single space (preserving
 * word-boundary intent); any other ASCII control character is dropped.
 */
function sanitizeWriteInText(text: string): string {
    return text
        .replace(/[\r\n]+/g, ' ')
        .replace(/[\x00-\x09\x0b\x0c\x0e-\x1f\x7f]/g, '')
}

/** Key sequence that navigates to and submits agy's auto-appended Write-in row. */
function writeInSequence(optionCount: number, text: string): string {
    return DOWN.repeat(optionCount) + ENTER + sanitizeWriteInText(text) + ENTER
}

/**
 * Build the raw PTY key sequence that answers ALL of `questions` per
 * `answers` (keyed by question index, matching the shape
 * AskUserQuestionFooter already submits: `Record<string, string[]>`).
 *
 * `answers === null` means no answer was ever provided (e.g. the pending
 * request was denied/canceled with nothing to inject) — every question is
 * skipped via Escape rather than guessing an answer.
 */
export function buildAgyQuestionKeys(
    questions: AgyAskQuestionQuestion[],
    answers: AgyQuestionAnswers | null
): string {
    if (!answers) {
        return ESC.repeat(questions.length)
    }

    let out = ''
    for (let i = 0; i < questions.length; i += 1) {
        const question = questions[i]
        const picked = normalizeAnswer(answers[String(i)])

        if (picked.length === 0) {
            out += ESC
            continue
        }

        const labels = question.options.map((o) => o.label.trim())
        const matchedIndices = picked
            .map((p) => labels.findIndex((label) => label === p))
            .filter((idx): idx is number => idx !== -1)
        const allMatched = matchedIndices.length === picked.length

        if (!question.multiSelect) {
            if (allMatched && matchedIndices.length > 0) {
                const position = matchedIndices[0] + 1
                if (position <= 9) {
                    // Single listed option, single-digit position: bare digit
                    // selects AND submits in one keystroke.
                    out += String(position)
                } else {
                    // Finding F2: a bare digit selects AND submits IMMEDIATELY
                    // (no Enter) — for position >= 10 the two-character form
                    // ("10") would submit option 1 on the very first keystroke
                    // (wrong, irreversible) and leak the second digit into
                    // whatever prompt comes next. Navigate with the cursor
                    // instead (validated alternate path, Phase 0.1).
                    out += DOWN.repeat(matchedIndices[0]) + ENTER
                }
            } else {
                // Free-text (write-in) answer — only the first picked value is used;
                // agy's single-select write-in sub-prompt takes one free-text answer.
                out += writeInSequence(question.options.length, picked[0] ?? '')
            }
            continue
        }

        // Multi-select.
        if (!allMatched) {
            // Finding F4: at least one picked value did not match a listed
            // option label — either pure free text, or a MIX of matched
            // labels + free text (e.g. ['Green', 'Blue', 'custom']). agy's
            // Write-in row REPLACES the entire checkbox set with a single
            // free-text string (Phase 0.4) — there is no keystroke sequence
            // that both toggles some checkboxes AND injects free text in the
            // same submission. Route every picked value (matched labels
            // included) through Write-in as one joined string so nothing is
            // silently dropped.
            out += writeInSequence(question.options.length, picked.join(', '))
            continue
        }

        const sortedIndices = Array.from(new Set(matchedIndices)).sort((a, b) => a - b)
        let cursor = 0
        for (const idx of sortedIndices) {
            out += DOWN.repeat(idx - cursor) + 'x'
            cursor = idx
        }
        out += ENTER
    }

    return out
}
