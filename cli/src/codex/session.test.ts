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

    it('clears codexSessionId and drops thread-local usage while keeping account limits', () => {
        const updateMetadata = vi.fn((updater: (metadata: Record<string, unknown>) => Record<string, unknown>) => {
            const next = updater({
                path: '/tmp/project',
                host: 'example',
                flavor: 'codex',
                codexSessionId: 'thread-old',
                codexUsage: {
                    contextWindow: { usedTokens: 99_000, limitTokens: 100_000, percent: 99, updatedAt: 1 },
                    totalTokenUsage: { totalTokens: 99_000 },
                    rateLimits: {
                        fiveHour: { usedPercent: 100, windowMinutes: 300, resetAt: 2 }
                    },
                    credits: { hasCredits: false, balance: '0' },
                    rateLimitReachedType: 'primary',
                    planType: 'plus',
                    limitId: 'premium'
                }
            });
            expect(next.codexSessionId).toBeNull();
            expect(next.codexUsage).toEqual({
                rateLimits: {
                    fiveHour: { usedPercent: 100, windowMinutes: 300, resetAt: 2 }
                },
                credits: { hasCredits: false, balance: '0' },
                rateLimitReachedType: 'primary',
                planType: 'plus',
                limitId: 'premium'
            });
            expect(next.codexUsage).not.toHaveProperty('contextWindow');
            expect(next.codexUsage).not.toHaveProperty('totalTokenUsage');
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

    it('drops codexUsage entirely on /clear when only thread-local fields were present', () => {
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
        expect(updateMetadata).toHaveBeenCalledOnce();
    });

    it('merges partial usage updates without wiping prior rate limits', () => {
        let metadata: Record<string, unknown> = {
            path: '/tmp/project',
            host: 'example',
            flavor: 'codex',
            codexUsage: {
                contextWindow: { usedTokens: 10_000, limitTokens: 100_000, percent: 10, updatedAt: 1 },
                rateLimits: {
                    fiveHour: { usedPercent: 90, windowMinutes: 300, resetAt: 2 },
                    weekly: { usedPercent: 40, windowMinutes: 10080, resetAt: 3 }
                },
                credits: { hasCredits: true, balance: '12' }
            }
        };
        const updateMetadata = vi.fn((updater: (current: Record<string, unknown>) => Record<string, unknown>) => {
            metadata = updater(metadata);
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
            sessionId: 'thread-1',
            messageQueue: new MessageQueue2<EnhancedMode>(() => 'default'),
            onModeChange: () => undefined,
            startedBy: 'terminal',
            startingMode: 'remote'
        });
        sessions.push(session);

        session.recordCodexUsage({
            info: {
                model_context_window: 100_000,
                total_token_usage: { total_tokens: 25_000 }
            }
        });

        expect(metadata.codexUsage).toMatchObject({
            contextWindow: expect.objectContaining({ usedTokens: 25_000, limitTokens: 100_000 }),
            rateLimits: {
                fiveHour: { usedPercent: 90, windowMinutes: 300, resetAt: 2 },
                weekly: { usedPercent: 40, windowMinutes: 10080, resetAt: 3 }
            },
            credits: { hasCredits: true, balance: '12' }
        });

        session.recordCodexUsage({
            info: {
                model_context_window: 100_000,
                total_token_usage: { total_tokens: 30_000 }
            },
            rate_limits: {
                primary: null,
                secondary: null,
                credits: { has_credits: false, balance: '0' }
            }
        });

        expect(metadata.codexUsage).toMatchObject({
            contextWindow: expect.objectContaining({ usedTokens: 30_000 }),
            rateLimits: {},
            credits: { hasCredits: false, balance: '0' }
        });
        expect((metadata.codexUsage as { rateLimits: Record<string, unknown> }).rateLimits.fiveHour).toBeUndefined();
    });
});
