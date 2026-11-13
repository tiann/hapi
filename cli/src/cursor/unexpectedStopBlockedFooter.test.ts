import { describe, expect, it } from 'vitest';
import { extractNotifySummary } from '@hapi/protocol';
import {
    UNEXPECTED_STOP_BLOCKED_ACTION,
    formatUnexpectedStopBlockedFooter
} from './unexpectedStopBlockedFooter';

describe('formatUnexpectedStopBlockedFooter', () => {
    it('emits a last-line AGENT_NOTIFY_SUMMARY with blocked status for lastNotify ingest', () => {
        const text = formatUnexpectedStopBlockedFooter({
            summary: 'Cursor connection interrupted after tool activity; the prompt was not retried.'
        });
        const lines = text.split('\n').filter((line) => line.trim().length > 0);
        expect(lines.at(-1)).toMatch(/^AGENT_NOTIFY_SUMMARY \{/);

        const notify = extractNotifySummary(text);
        expect(notify).toMatchObject({
            version: 1,
            status: 'blocked',
            action: UNEXPECTED_STOP_BLOCKED_ACTION,
            summary: 'Cursor connection interrupted after tool activity; the prompt was not retried.'
        });
    });

    it('clamps an oversized summary so the footer stays parseable and note-sized', () => {
        const summary = `x${'y'.repeat(400)}`;
        const notify = extractNotifySummary(formatUnexpectedStopBlockedFooter({ summary }));
        expect(notify?.status).toBe('blocked');
        expect(notify?.summary?.length).toBeLessThanOrEqual(160);
        expect(notify?.summary?.endsWith('…')).toBe(true);
    });

    it('clamps a non-BMP character at the cutoff without splitting its surrogate pair', () => {
        // U+1F600 (😀) is a UTF-16 surrogate pair. Its high surrogate lands at
        // UTF-16 unit 158 (after 158 ASCII chars), so a naive
        // `trimmed.slice(0, 159)` keeps the high surrogate but drops the low
        // one, leaving a lone surrogate at the cut.
        const summary = `${'x'.repeat(158)}\u{1F600}xx`;
        const notify = extractNotifySummary(formatUnexpectedStopBlockedFooter({ summary }));
        expect(notify?.summary).toBe(`${'x'.repeat(158)}\u{1F600}…`);
        // Any surrogate code unit must be paired, not lone (dangling half of
        // the emoji at the truncation cut).
        expect(notify?.summary).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/);
    });

    it('allows a custom action when the caller has a sharper next step', () => {
        const notify = extractNotifySummary(formatUnexpectedStopBlockedFooter({
            summary: 'Cursor Agent failed after 3 retries.',
            action: 'Resend the prompt'
        }));
        expect(notify?.action).toBe('Resend the prompt');
    });
});
