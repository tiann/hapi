import { describe, expect, it } from 'vitest';
import { MetadataSchema } from './schemas';

describe('MetadataSchema cursorSessionProtocol', () => {
    const base = {
        path: '/tmp',
        host: 'test'
    };

    it('accepts acp and stream-json protocol values', () => {
        expect(MetadataSchema.safeParse({ ...base, cursorSessionProtocol: 'acp' }).success).toBe(true);
        expect(MetadataSchema.safeParse({ ...base, cursorSessionProtocol: 'stream-json' }).success).toBe(true);
    });

    it('rejects unknown protocol values', () => {
        expect(MetadataSchema.safeParse({ ...base, cursorSessionProtocol: 'websocket' }).success).toBe(false);
    });

    it('persists Pi native history entry ids', () => {
        const result = MetadataSchema.safeParse({
            ...base,
            conversationHistoryEntryIds: { 'local-user-id': 'pi-entry-id' },
        });
        expect(result.success).toBe(true);
        expect(result.data?.conversationHistoryEntryIds).toEqual({ 'local-user-id': 'pi-entry-id' });
    });

    it('accepts the Hub-owned automatic title attempt marker', () => {
        const result = MetadataSchema.safeParse({
            ...base,
            titleSuggestionAutoAttemptedAt: 1234,
            titleSuggestionTurn: { first: true, completed: false },
        });

        expect(result.success).toBe(true);
        expect(result.data?.titleSuggestionAutoAttemptedAt).toBe(1234);
        expect(result.data?.titleSuggestionTurn).toEqual({ first: true, completed: false });
    });
});

describe('MetadataSchema claudeRewind', () => {
    const base = {
        path: '/tmp',
        host: 'test',
        flavor: 'claude',
    };

    const validIntent = {
        targetLocalId: 'local-1',
        truncateFromLocalId: 'local-1',
        keepBoundary: 'boundary-uuid',
        droppedPrompts: ['prompt-uuid'],
    };

    it('parses a valid rewind intent unchanged', () => {
        const result = MetadataSchema.safeParse({ ...base, claudeRewind: validIntent });
        expect(result.success).toBe(true);
        expect(result.data?.claudeRewind).toEqual(validIntent);
        expect(result.data?.flavor).toBe('claude');
    });

    it('ignores a legacy-shaped claudeRewind instead of failing the whole metadata', () => {
        const result = MetadataSchema.safeParse({
            ...base,
            claudeRewind: {
                operationId: 'op-1',
                phase: 'pending',
                requestedLocalId: 'local-1',
                truncateFromLocalId: 'local-1',
                keepBoundary: 'boundary-uuid',
                cutoffSeq: 7,
            },
        });
        expect(result.success).toBe(true);
        expect(result.data?.claudeRewind).toBeUndefined();
        expect(result.data?.path).toBe('/tmp');
        expect(result.data?.host).toBe('test');
        expect(result.data?.flavor).toBe('claude');
    });

    it('ignores a garbage claudeRewind value instead of failing the whole metadata', () => {
        const result = MetadataSchema.safeParse({ ...base, claudeRewind: 'legacy' });
        expect(result.success).toBe(true);
        expect(result.data?.claudeRewind).toBeUndefined();
        expect(result.data?.path).toBe('/tmp');
        expect(result.data?.host).toBe('test');
    });
});
