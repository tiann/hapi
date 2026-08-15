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

    it('persists DSH-owned prompt ids across runner restarts', () => {
        const result = MetadataSchema.safeParse({
            ...base,
            dshPendingPrompts: {
                'rpc-1': { localIds: ['local-1'], createdAt: 1_700_000_000_000 }
            },
        });
        expect(result.success).toBe(true);
        expect(result.data?.dshPendingPrompts).toEqual({
            'rpc-1': { localIds: ['local-1'], createdAt: 1_700_000_000_000 }
        });
    });
});
