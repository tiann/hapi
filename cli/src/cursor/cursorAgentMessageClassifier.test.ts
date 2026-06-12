import { describe, it, expect } from 'vitest'
import { classifyCursorAgentMessage, isCompletionClaim } from './cursorAgentMessageClassifier'

describe('classifyCursorAgentMessage', () => {
    it('classifies resource_exhausted', () => {
        const result = classifyCursorAgentMessage('Error: T: [resource_exhausted] quota exceeded')
        expect(result).not.toBeNull()
        expect(result?.kind).toBe('quota_exhausted')
        expect(result?.transient).toBe(false)
    })

    it('classifies canceled', () => {
        const result = classifyCursorAgentMessage('Error: T: [canceled] the request was cancelled')
        expect(result).not.toBeNull()
        expect(result?.kind).toBe('canceled')
        expect(result?.transient).toBe(true)
    })

    it('classifies deadline_exceeded', () => {
        const result = classifyCursorAgentMessage('Error: T: [deadline_exceeded]')
        expect(result).not.toBeNull()
        expect(result?.kind).toBe('deadline_exceeded')
        expect(result?.transient).toBe(true)
    })

    it('classifies unavailable', () => {
        const result = classifyCursorAgentMessage('Error: T: [unavailable] service is down')
        expect(result).not.toBeNull()
        expect(result?.kind).toBe('unavailable')
        expect(result?.transient).toBe(true)
    })

    it('classifies connection_stalled', () => {
        const result = classifyCursorAgentMessage('Error: T: Connection stalled after 30s')
        expect(result).not.toBeNull()
        expect(result?.kind).toBe('connection_stalled')
        expect(result?.transient).toBe(true)
    })

    it('classifies context_window', () => {
        const result = classifyCursorAgentMessage(
            'Gemini prompt failed: token count exceeds the model limit'
        )
        expect(result).not.toBeNull()
        expect(result?.kind).toBe('context_window')
        expect(result?.transient).toBe(false)
    })

    it('classifies capacity_exhausted', () => {
        const result = classifyCursorAgentMessage(
            'Gemini prompt failed: you have exhausted your capacity for today'
        )
        expect(result).not.toBeNull()
        expect(result?.kind).toBe('capacity_exhausted')
        expect(result?.transient).toBe(false)
    })

    it('classifies unknown_t_prefix for unrecognised Error: T: variants', () => {
        const result = classifyCursorAgentMessage('Error: T: [some_new_error] weird thing happened')
        expect(result).not.toBeNull()
        expect(result?.kind).toBe('unknown_t_prefix')
        expect(result?.transient).toBe(false)
    })

    it('preserves raw text', () => {
        const raw = 'Error: T: [canceled] something something'
        const result = classifyCursorAgentMessage(raw)
        expect(result?.raw).toBe(raw)
    })

    it('returns null for benign messages', () => {
        expect(classifyCursorAgentMessage("Here's the diff:")).toBeNull()
        expect(classifyCursorAgentMessage('Done.')).toBeNull()
        expect(classifyCursorAgentMessage('All done.')).toBeNull()
        expect(classifyCursorAgentMessage('I found 3 files.')).toBeNull()
        expect(classifyCursorAgentMessage('Successfully updated the config.')).toBeNull()
    })

    it('returns null for empty string', () => {
        expect(classifyCursorAgentMessage('')).toBeNull()
    })

    it('is case-insensitive for Error: T: patterns', () => {
        const result = classifyCursorAgentMessage('error: t: [resource_exhausted]')
        expect(result?.kind).toBe('quota_exhausted')
    })

    it('does not match Error: T: patterns in the middle of text', () => {
        // These patterns are anchored at the start
        expect(classifyCursorAgentMessage('Partial text before Error: T: [canceled]')).toBeNull()
    })

    it('does not classify prose that describes the pattern', () => {
        // Regression: 2026-06-12 self-own. The classifier matched an
        // assistant message that *described* the patterns it looks for,
        // because the original Gemini patterns used unanchored "contains".
        // Real cursor-agent error emits come as the whole message body,
        // not embedded in narrative prose. Anchored patterns reject prose.
        const proseDescribingPatterns =
            "Yes. In the soup since 23:51:24 BST.\n\n" +
            "Triggers on:\n" +
            "  - Error: T: [resource_exhausted]\n" +
            "  - Error: T: Connection stalled\n" +
            "  - Gemini prompt failed: .*token count exceeds\n" +
            "  - Gemini prompt failed: .*exhausted your capacity\n"
        expect(classifyCursorAgentMessage(proseDescribingPatterns)).toBeNull()

        // Same idea, single line embedding the literal description.
        expect(
            classifyCursorAgentMessage(
                'The classifier looks for "Gemini prompt failed: .*token count exceeds" specifically.'
            )
        ).toBeNull()
    })

    it('still classifies real Gemini errors when they ARE the message body', () => {
        // Whitespace prefix is OK (trimStart handles it) but prose prefix is not.
        expect(
            classifyCursorAgentMessage(
                '  Gemini prompt failed: token count exceeds limit'
            )?.kind
        ).toBe('context_window')
        expect(
            classifyCursorAgentMessage(
                'Gemini prompt failed: you have exhausted your capacity'
            )?.kind
        ).toBe('capacity_exhausted')
    })

    it('classifies Error: T: patterns with leading whitespace (real wire format)', () => {
        // Regression: 2026-06-12 session b52b9117. Cursor ACP transport
        // emitted "\n\nError: T: WritableIterable is closed" — leading
        // newlines made the unanchored-tolerant `^Error: T:` regex miss
        // it because JS `^` matches start of string, not start of line
        // (without the `m` flag). trimStart() before the test fixes it.
        const realWireFormat = '\n\nError: T: WritableIterable is closed'
        const result = classifyCursorAgentMessage(realWireFormat)
        expect(result).not.toBeNull()
        expect(result?.kind).toBe('unknown_t_prefix')
        expect(result?.transient).toBe(false)
        // Raw text preserved as-is (leading newlines included) so the
        // banner can show the operator exactly what arrived.
        expect(result?.raw).toBe(realWireFormat)
    })

    it('classifies leading-whitespace variants of all Error: T: kinds', () => {
        expect(classifyCursorAgentMessage('\n\nError: T: [resource_exhausted]')?.kind).toBe('quota_exhausted')
        expect(classifyCursorAgentMessage('  Error: T: [canceled]')?.kind).toBe('canceled')
        expect(classifyCursorAgentMessage('\tError: T: [deadline_exceeded]')?.kind).toBe('deadline_exceeded')
        expect(classifyCursorAgentMessage('\n\n  Error: T: [unavailable]')?.kind).toBe('unavailable')
        expect(classifyCursorAgentMessage('\nError: T: Connection stalled after 30s')?.kind).toBe('connection_stalled')
    })
})

describe('isCompletionClaim', () => {
    it('matches Done', () => expect(isCompletionClaim('Done.')).toBe(true))
    it('matches All done', () => expect(isCompletionClaim('All done. The PR is filed.')).toBe(true))
    it('matches Committed', () => expect(isCompletionClaim('Committed all changes.')).toBe(true))
    it('matches Successfully', () => expect(isCompletionClaim('Successfully updated the file.')).toBe(true))
    it('matches Fixed', () => expect(isCompletionClaim('Fixed the bug.')).toBe(true))
    it('matches Complete', () => expect(isCompletionClaim('Complete.')).toBe(true))
    it('is case-insensitive', () => {
        expect(isCompletionClaim('DONE everything')).toBe(true)
        expect(isCompletionClaim('all done')).toBe(true)
    })
    it('does not match non-completion phrases', () => {
        expect(isCompletionClaim("Here's the plan")).toBe(false)
        expect(isCompletionClaim("I'm working on it")).toBe(false)
    })
    it('handles empty string', () => {
        expect(isCompletionClaim('')).toBe(false)
    })
})
