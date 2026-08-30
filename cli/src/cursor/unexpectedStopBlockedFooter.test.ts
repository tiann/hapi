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

    it('allows a custom action when the caller has a sharper next step', () => {
        const notify = extractNotifySummary(formatUnexpectedStopBlockedFooter({
            summary: 'Cursor Agent failed after 3 retries.',
            action: 'Resend the prompt'
        }));
        expect(notify?.action).toBe('Resend the prompt');
    });
});
