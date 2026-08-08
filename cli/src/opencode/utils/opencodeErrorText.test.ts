import { describe, expect, it } from 'vitest';
import {
    OPENCODE_PROVIDER_TEXT_MAX_LENGTH,
    formatOpencodePromptError,
    truncateOpencodeProviderText
} from './opencodeErrorText';

/** The wording this path rendered before the reason was wired through. */
const FALLBACK = 'OpenCode prompt failed. Check logs for details.';

describe('truncateOpencodeProviderText', () => {
    it('leaves text that already fits untouched', () => {
        const text = 'Rate limit exceeded: free-models-per-day.';
        expect(truncateOpencodeProviderText(text)).toBe(text);
    });

    it('caps text no provider bounds, marking that it was cut', () => {
        // Measured: a provider answering a rate limit with a 20KB body
        // produces a 20,210-character message, forwarded verbatim.
        const capped = truncateOpencodeProviderText('x'.repeat(20_210));

        expect(capped).toHaveLength(OPENCODE_PROVIDER_TEXT_MAX_LENGTH);
        expect(capped.endsWith('…')).toBe(true);
    });
});

describe('formatOpencodePromptError', () => {
    it('states the provider reason the ACP transport already delivered', () => {
        const error = new Error('Internal error: Rate limit exceeded: free-models-per-day. Add credits to unlock 1000 free models.');

        expect(formatOpencodePromptError(error)).toBe(
            'OpenCode prompt failed: Rate limit exceeded: free-models-per-day. Add credits to unlock 1000 free models.'
        );
    });

    it('strips only the JSON-RPC wrapper, keeping a message that never had one', () => {
        expect(formatOpencodePromptError(new Error('Session not found')))
            .toBe('OpenCode prompt failed: Session not found');
    });

    it('does not mistake a reason that merely mentions an internal error for the wrapper', () => {
        // The prefix is anchored, so text about an internal error survives.
        expect(formatOpencodePromptError(new Error('The provider reported an Internal error: upstream')))
            .toBe('OpenCode prompt failed: The provider reported an Internal error: upstream');
    });

    it('reads a rejection thrown as a bare string', () => {
        expect(formatOpencodePromptError('Internal error: Overloaded'))
            .toBe('OpenCode prompt failed: Overloaded');
    });

    it('reads a rejection thrown as a plain JSON-RPC error object', () => {
        expect(formatOpencodePromptError({
            code: -32603,
            message: 'Internal error: Overloaded',
            data: { service: 'session', errorName: 'APIError' }
        })).toBe('OpenCode prompt failed: Overloaded');
    });

    it('collapses embedded newlines so one failure stays one timeline line', () => {
        expect(formatOpencodePromptError(new Error('Internal error: Rate limit exceeded.\n\n  Try again later.')))
            .toBe('OpenCode prompt failed: Rate limit exceeded. Try again later.');
    });

    it('caps a message no provider bounds', () => {
        const formatted = formatOpencodePromptError(new Error(`Internal error: ${'y'.repeat(20_210)}`));

        expect(formatted).toBe(`OpenCode prompt failed: ${'y'.repeat(OPENCODE_PROVIDER_TEXT_MAX_LENGTH - 1)}…`);
    });

    it('keeps the original wording when there is no message', () => {
        expect(formatOpencodePromptError(new Error(''))).toBe(FALLBACK);
        expect(formatOpencodePromptError(new Error('   '))).toBe(FALLBACK);
    });

    it('keeps the original wording when the wrapper is all there was', () => {
        // A bare "Internal error:" says nothing the fallback does not.
        expect(formatOpencodePromptError(new Error('Internal error: '))).toBe(FALLBACK);
    });

    it('keeps the original wording for a rejection that is not an error at all', () => {
        expect(formatOpencodePromptError(null)).toBe(FALLBACK);
        expect(formatOpencodePromptError(undefined)).toBe(FALLBACK);
        expect(formatOpencodePromptError(42)).toBe(FALLBACK);
        expect(formatOpencodePromptError({ code: -32603 })).toBe(FALLBACK);
    });
});
