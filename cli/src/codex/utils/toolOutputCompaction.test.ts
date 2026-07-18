import { describe, expect, it } from 'vitest';
import { compactToolOutputForHapi } from './toolOutputCompaction';

describe('compactToolOutputForHapi', () => {
    it('keeps small tool outputs unchanged', () => {
        const output = { stdout: 'ok', exit_code: 0 };

        expect(compactToolOutputForHapi(output, { callId: 'call-1', toolName: 'CodexBash' })).toEqual(output);
    });

    it('handles non-JSON values without throwing', () => {
        expect(compactToolOutputForHapi(undefined)).toBeUndefined();
        expect(compactToolOutputForHapi(undefined, { maxChars: 1 })).toMatchObject({
            type: 'hapi-tool-output-summary',
            truncated: true,
            preview: 'undefined'
        });
    });

    it('replaces large tool outputs with a preview and evidence metadata', () => {
        const output = {
            stdout: `head\n${'x'.repeat(5000)}\ntail`,
            exit_code: 0
        };

        const compacted = compactToolOutputForHapi(output, {
            callId: 'call-2',
            toolName: 'CodexBash',
            maxChars: 80
        });

        expect(compacted).toMatchObject({
            type: 'hapi-tool-output-summary',
            truncated: true,
            callId: 'call-2',
            toolName: 'CodexBash',
            originalChars: expect.any(Number),
            preview: expect.stringContaining('head'),
            fullOutputRetainedBy: 'codex-rollout'
        });
        expect((compacted as { preview: string }).preview.length).toBeLessThanOrEqual(200);
        expect(JSON.stringify(compacted).length).toBeLessThan(JSON.stringify(output).length);
    });
});
