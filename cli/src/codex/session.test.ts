import { describe, expect, it, vi, afterEach } from 'vitest';
import { MessageQueue2 } from '@/utils/MessageQueue2';
import { CodexSession } from './session';
import type { EnhancedMode } from './loop';

describe('CodexSession.resetCodexThread', () => {
    const sessions: CodexSession[] = [];

    afterEach(() => {
        for (const session of sessions.splice(0)) {
            session.stopKeepAlive();
        }
    });

    it('clears codexSessionId and drops stale codexUsage from metadata', () => {
        const updateMetadata = vi.fn((updater: (metadata: Record<string, unknown>) => Record<string, unknown>) => {
            const next = updater({
                path: '/tmp/project',
                host: 'example',
                flavor: 'codex',
                codexSessionId: 'thread-old',
                codexUsage: {
                    contextWindow: { usedTokens: 99_000, limitTokens: 100_000, percent: 99, updatedAt: 1 }
                }
            });
            expect(next.codexSessionId).toBeNull();
            expect('codexUsage' in next).toBe(false);
        });

        const session = new CodexSession({
            api: {} as never,
            client: {
                keepAlive: vi.fn(),
                updateMetadata,
                sendAgentMessage: vi.fn(),
                emitMessagesConsumed: vi.fn(),
                sendSessionEvent: vi.fn()
            } as never,
            path: '/tmp/project',
            logPath: '/tmp/log',
            sessionId: 'thread-old',
            messageQueue: new MessageQueue2<EnhancedMode>(() => 'default'),
            onModeChange: () => undefined,
            startedBy: 'terminal',
            startingMode: 'remote'
        });
        sessions.push(session);

        session.resetCodexThread();

        expect(session.sessionId).toBeNull();
        expect(updateMetadata).toHaveBeenCalledOnce();
    });
});
