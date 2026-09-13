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

    it('accepts versioned Claude and Codex context details', () => {
        const result = MetadataSchema.safeParse({
            ...base,
            contextDetails: {
                version: 1,
                updatedAt: 123,
                provider: 'codex',
                model: 'gpt-5-codex',
                contextWindow: 258_400,
                usage: { contextTokens: 12_000, cacheReadTokens: 8_000 },
                codex: {
                    slashCommands: ['clear'],
                    skills: [{ name: 'find-docs', scope: 'user' }],
                    mcpServers: [{ name: 'hapi', toolNames: ['change_title'] }]
                },
                claude: {
                    systemTools: ['Read', 'Bash'],
                    slashCommands: ['/context', '/compact']
                }
            }
        });

        expect(result.success).toBe(true);
        expect(result.data?.contextDetails?.codex?.skills?.[0]?.name).toBe('find-docs');
        expect(result.data?.contextDetails?.codex?.slashCommands).toEqual(['clear']);
        expect(result.data?.contextDetails?.claude?.systemTools).toEqual(['Read', 'Bash']);
        expect('sandbox' in (result.data?.contextDetails?.codex ?? {})).toBe(false);
    });
});
