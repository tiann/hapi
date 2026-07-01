import { describe, it, expect } from 'vitest'
import {
    classifyAcpRpcRejection,
    classifyCursorAgentMessage,
    isCompletionClaim,
    mapAcpStderrToFailure
} from './cursorAgentMessageClassifier'

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

    it('classifies RetriableError prefix from cursor session (real session 0e04ebe7)', () => {
        // Regression: 2026-06-20 session 0e04ebe7 ("teams structure").
        // Cursor ACP session (metadata.flavor=cursor) but HAPI persists
        // agent text in a codex-shaped envelope via convertAgentMessage —
        // that is NOT the Codex runner. The inline error used RetriableError
        // instead of Error: T: and was followed immediately by ready.
        const realWireFormat = '\n\nError: RetriableError: [canceled] http/2 stream closed with error code CANCEL (0x8)'
        const result = classifyCursorAgentMessage(realWireFormat)
        expect(result).not.toBeNull()
        expect(result?.kind).toBe('canceled')
        expect(result?.transient).toBe(true)
        expect(result?.source).toBe('text')
    })

    it('classifies error appended to in-flight agent text (real session e7d9b44b)', () => {
        // Regression: 2026-06-13 session e7d9b44b. cursor-agent appended
        // a gRPC stringification to the END of a normal narrative output
        // rather than rejecting the prompt. The structural signals
        // (RPC rejection / stderr) didn't fire because the agent never
        // crashed - it just dumped the error into its own text stream.
        // Start-of-string anchor missed it (text starts with prose);
        // multiline `^` (start-of-line after the `\n\n`) catches it.
        const realWireFormat =
            "Three of the four hit Codex's usage limit (#151, #153, #155) " +
            "- no code review delivered. Only #157 actually got reviewed. " +
            "Let me pull the inline comments to see Codex's specific suggestions:\n\n" +
            "Error: T: [resource_exhausted] Error"
        const result = classifyCursorAgentMessage(realWireFormat)
        expect(result).not.toBeNull()
        expect(result?.kind).toBe('quota_exhausted')
        expect(result?.transient).toBe(false)
    })

    it('still rejects bullet-listed pattern descriptions (no false positive)', () => {
        // Lines indented with whitespace+dash do NOT start with "Error:" -
        // multiline `^` requires the line to literally begin with the
        // pattern. Self-own from 2026-06-12 stays prevented.
        const proseDescribingPatterns =
            "Yes. In the soup since 23:51:24 BST.\n\n" +
            "Triggers on:\n" +
            "  - Error: T: [resource_exhausted]\n" +
            "  - Error: T: Connection stalled\n" +
            "  - Gemini prompt failed: .*token count exceeds\n" +
            "  - Gemini prompt failed: .*exhausted your capacity\n"
        expect(classifyCursorAgentMessage(proseDescribingPatterns)).toBeNull()
    })

    it('catches all gRPC kinds when appended after prose+newlines', () => {
        const prefix = "Working on the task. Got partial results before failure:\n\n"
        expect(classifyCursorAgentMessage(prefix + 'Error: T: [resource_exhausted] Error')?.kind).toBe('quota_exhausted')
        expect(classifyCursorAgentMessage(prefix + 'Error: T: [canceled] Operation aborted')?.kind).toBe('canceled')
        expect(classifyCursorAgentMessage(prefix + 'Error: T: [deadline_exceeded]')?.kind).toBe('deadline_exceeded')
        expect(classifyCursorAgentMessage(prefix + 'Error: T: [unavailable] Service down')?.kind).toBe('unavailable')
        expect(classifyCursorAgentMessage(prefix + 'Error: T: Connection stalled')?.kind).toBe('connection_stalled')
        expect(classifyCursorAgentMessage(prefix + 'Error: T: WritableIterable is closed')?.kind).toBe('unknown_t_prefix')
        expect(classifyCursorAgentMessage(prefix + 'Gemini prompt failed: token count exceeds 1M')?.kind).toBe('context_window')
        expect(classifyCursorAgentMessage(prefix + 'Gemini prompt failed: exhausted your capacity')?.kind).toBe('capacity_exhausted')
    })

    it("tags text-classifier results with source='text'", () => {
        const result = classifyCursorAgentMessage('Error: T: [canceled]')
        expect(result?.source).toBe('text')
    })
})

describe('mapAcpStderrToFailure (structural stderr signal)', () => {
    it('maps rate_limit -> rate_limited (transient)', () => {
        const out = mapAcpStderrToFailure({ type: 'rate_limit', raw: 'status 429 ratelimitexceeded' })
        expect(out.kind).toBe('rate_limited')
        expect(out.transient).toBe(true)
        expect(out.source).toBe('stderr')
        expect(out.raw).toBe('status 429 ratelimitexceeded')
    })

    it('maps quota_exceeded -> quota_exhausted (non-transient)', () => {
        const out = mapAcpStderrToFailure({ type: 'quota_exceeded', raw: 'resource exhausted' })
        expect(out.kind).toBe('quota_exhausted')
        expect(out.transient).toBe(false)
        expect(out.source).toBe('stderr')
    })

    it('maps authentication -> auth_failed (non-transient)', () => {
        const out = mapAcpStderrToFailure({ type: 'authentication', raw: 'status 401 unauthenticated' })
        expect(out.kind).toBe('auth_failed')
        expect(out.transient).toBe(false)
        expect(out.source).toBe('stderr')
    })

    it('maps model_not_found -> model_not_found (non-transient)', () => {
        const out = mapAcpStderrToFailure({ type: 'model_not_found', raw: 'status 404 model not found' })
        expect(out.kind).toBe('model_not_found')
        expect(out.transient).toBe(false)
    })

    it('maps unknown -> unknown_stderr', () => {
        const out = mapAcpStderrToFailure({ type: 'unknown', raw: 'unexpected exception in agent' })
        expect(out.kind).toBe('unknown_stderr')
        expect(out.transient).toBe(false)
        expect(out.source).toBe('stderr')
    })
})

describe('classifyAcpRpcRejection (structural RPC signal)', () => {
    it('classifies WritableIterable is closed -> transport_closed (transient)', () => {
        // Real session b52b9117: the agent rejected sendRequest with this
        // exact message after the writable side of the ACP transport died.
        const err = new Error('WritableIterable is closed')
        const out = classifyAcpRpcRejection(err)
        expect(out).not.toBeNull()
        expect(out?.kind).toBe('transport_closed')
        expect(out?.transient).toBe(true)
        expect(out?.source).toBe('rpc')
    })

    it('classifies ACP transport closed -> transport_closed', () => {
        const err = new Error('ACP transport is closed')
        const out = classifyAcpRpcRejection(err)
        expect(out?.kind).toBe('transport_closed')
        expect(out?.transient).toBe(true)
    })

    it('classifies process exit -> transport_closed (rejectAllPending pathway)', () => {
        // markClosed wraps the process-exit message in a new Error; pending
        // sendRequests reject with that error.
        const err = new Error('ACP process exited (code=137, signal=SIGKILL)')
        const out = classifyAcpRpcRejection(err)
        expect(out?.kind).toBe('transport_closed')
        expect(out?.transient).toBe(true)
    })

    it('classifies spawn failure -> agent_crashed', () => {
        const err = new Error('Failed to spawn cursor-agent: ENOENT. Is it installed and on PATH?')
        const out = classifyAcpRpcRejection(err)
        expect(out?.kind).toBe('agent_crashed')
        expect(out?.transient).toBe(true)
    })

    it('classifies request timeout -> rpc_timeout', () => {
        const err = new Error("ACP request 'session/prompt' timed out after 120000ms")
        const out = classifyAcpRpcRejection(err)
        expect(out?.kind).toBe('rpc_timeout')
        expect(out?.transient).toBe(true)
    })

    it('returns null for user cancellations (NOT model errors)', () => {
        expect(classifyAcpRpcRejection(new Error('Aborted by user'))).toBeNull()
        expect(classifyAcpRpcRejection(new Error('user cancelled the request'))).toBeNull()
        expect(classifyAcpRpcRejection(new Error('user canceled the request'))).toBeNull()
    })

    it('passes through gRPC-status RPC errors with source=rpc', () => {
        // Cursor-agent sometimes returns the gRPC status as a JSON-RPC
        // error.message rather than emitting it as a text message.
        const err = new Error('Error: T: [resource_exhausted] quota exceeded')
        const out = classifyAcpRpcRejection(err)
        expect(out?.kind).toBe('quota_exhausted')
        expect(out?.transient).toBe(false)
        // The structural source overrides text classification's source tag.
        expect(out?.source).toBe('rpc')
    })

    it('falls through to prompt_failed for unrecognised RPC errors', () => {
        const err = new Error('Some weird internal SDK assertion failed')
        const out = classifyAcpRpcRejection(err)
        expect(out?.kind).toBe('prompt_failed')
        expect(out?.transient).toBe(false)
        expect(out?.source).toBe('rpc')
    })

    it('handles non-Error rejection values', () => {
        const out = classifyAcpRpcRejection('plain string rejection')
        expect(out?.kind).toBe('prompt_failed')
        expect(out?.raw).toBe('plain string rejection')
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
