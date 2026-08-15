import { describe, expect, it } from 'vitest';
import { AgentStateSchema, MetadataSchema } from './schemas';

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

    it('accepts a Reasonix native session id and transcript persistence state', () => {
        const result = MetadataSchema.safeParse({
            ...base,
            flavor: 'reasonix',
            reasonixSessionId: 'reasonix-session-1',
            reasonixTranscriptPersisted: true
        });
        expect(result.success).toBe(true);
        expect(result.data?.reasonixSessionId).toBe('reasonix-session-1');
        expect(result.data?.reasonixTranscriptPersisted).toBe(true);
    });

    it('preserves ACP permission options in completed requests', () => {
        const result = AgentStateSchema.safeParse({
            completedRequests: {
                'request-1': {
                    tool: 'AskUserQuestion',
                    arguments: {},
                    status: 'denied',
                    permissionOptions: [{
                        optionId: 'q1:cancel',
                        name: 'Cancel',
                        kind: 'reject_once'
                    }]
                }
            }
        });
        expect(result.success).toBe(true);
        expect(result.success && result.data.completedRequests?.['request-1']?.permissionOptions)
            .toEqual([{ optionId: 'q1:cancel', name: 'Cancel', kind: 'reject_once' }]);
    });
});
