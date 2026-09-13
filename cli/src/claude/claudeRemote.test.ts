import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as claudeSdk from '@/claude/sdk';
import type { SDKMessage } from '@/claude/sdk/types';
import { join } from 'node:path';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { getProjectPath } from '@/claude/utils/path';
import type { CompactSummaryPayload } from './claudeRemote';

vi.mock('@/claude/utils/compactSummaryLookup', () => ({
    findLatestCompactSummary: vi.fn(async () => null)
}));

import { findLatestCompactSummary } from '@/claude/utils/compactSummaryLookup';
const findLatestCompactSummaryMock = vi.mocked(findLatestCompactSummary);

vi.mock('@/claude/utils/claudeCheckSession', () => ({
    claudeCheckSession: () => true
}));

vi.mock('@/modules/watcher/awaitFileExist', () => ({
    awaitFileExist: async () => true
}));

vi.mock('@/claude/sdk/utils', () => ({
    getDefaultClaudeCodePath: () => '/usr/bin/claude'
}));

const queryMock = vi.fn();

function deferred<T>(): {
    promise: Promise<T>;
    resolve: (value: T) => void;
    reject: (reason?: unknown) => void;
} {
    let resolve!: (value: T) => void;
    let reject!: (reason?: unknown) => void;
    const promise = new Promise<T>((res, rej) => {
        resolve = res;
        reject = rej;
    });
    return { promise, resolve, reject };
}

function createAsyncStream(messages: SDKMessage[]): AsyncIterable<SDKMessage> {
    return {
        async *[Symbol.asyncIterator]() {
            for (const message of messages) {
                await Promise.resolve();
                yield message;
            }
        }
    };
}

function createQueryThatMirrorsPromptErrors(messages: SDKMessage[]) {
    return ({ prompt }: { prompt: AsyncIterable<unknown> }) => ({
        async *[Symbol.asyncIterator]() {
            const promptIterator = prompt[Symbol.asyncIterator]();

            await promptIterator.next();

            for (const message of messages) {
                await Promise.resolve();
                yield message;
            }

            await promptIterator.next();
        }
    });
}

async function waitFor(condition: () => boolean, timeoutMs = 300, intervalMs = 10): Promise<void> {
    const startedAt = Date.now();
    while (!condition()) {
        if (Date.now() - startedAt > timeoutMs) {
            throw new Error('Timed out waiting for condition');
        }
        await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
}

describe('claudeRemote async message handling', () => {
    beforeEach(() => {
        findLatestCompactSummaryMock.mockReset();
        findLatestCompactSummaryMock.mockImplementation(async () => null);
    });
    // CI occasionally exceeds the default 5s under load (unrelated to job work).
    it('reports the initial normal message once after the first result', { timeout: 15_000 }, async () => {
        const querySpy = vi.spyOn(claudeSdk, 'query').mockImplementation(queryMock as typeof claudeSdk.query);
        const { claudeRemote } = await import('./claudeRemote');
        const onFirstResult = vi.fn();

        queryMock.mockReturnValueOnce(createAsyncStream([
            { type: 'result', subtype: 'success' } as unknown as SDKMessage,
            { type: 'result', subtype: 'success' } as unknown as SDKMessage
        ]));

        let nextCallCount = 0;
        try {
            await claudeRemote({
                sessionId: 'session-1',
                path: process.cwd(),
                mcpServers: {},
                claudeEnvVars: {},
                claudeArgs: [],
                allowedTools: [],
                hookSettingsPath: '/tmp/hook.json',
                canCallTool: async () => ({ behavior: 'allow', updatedInput: {} }),
                nextMessage: async () => nextCallCount++ === 0
                    ? { message: 'Review this project', mode: { permissionMode: 'default' } }
                    : null,
                onReady: () => {},
                isAborted: () => false,
                onSessionFound: () => {},
                onMessage: () => {},
                onFirstResult
            });

            expect(onFirstResult).toHaveBeenCalledTimes(1);
            expect(onFirstResult).toHaveBeenCalledWith('Review this project');
        } finally {
            queryMock.mockReset();
            querySpy.mockRestore();
        }
    });

    it('waits for async onReady work before completing the result stream', async () => {
        const querySpy = vi.spyOn(claudeSdk, 'query').mockImplementation(queryMock as typeof claudeSdk.query);
        const { claudeRemote } = await import('./claudeRemote');
        const releaseReady = deferred<void>();
        queryMock.mockReturnValueOnce(createAsyncStream([
            { type: 'result', subtype: 'success' } as unknown as SDKMessage
        ]));

        let nextCallCount = 0;
        let readyStarted = false;
        let settled = false;
        try {
            const runPromise = claudeRemote({
                sessionId: 'session-1',
                path: process.cwd(),
                mcpServers: {},
                claudeEnvVars: {},
                claudeArgs: [],
                allowedTools: [],
                hookSettingsPath: '/tmp/hook.json',
                canCallTool: async () => ({ behavior: 'allow', updatedInput: {} }),
                nextMessage: async () => nextCallCount++ === 0
                    ? { message: 'Review this project', mode: { permissionMode: 'default' } }
                    : null,
                onReady: async () => {
                    readyStarted = true;
                    await releaseReady.promise;
                },
                isAborted: () => false,
                onSessionFound: () => {},
                onMessage: () => {}
            });
            void runPromise.finally(() => { settled = true; });

            await waitFor(() => readyStarted);
            await new Promise((resolve) => setTimeout(resolve, 0));
            expect(settled).toBe(false);

            releaseReady.resolve();
            await runPromise;
        } finally {
            releaseReady.resolve();
            queryMock.mockReset();
            querySpy.mockRestore();
        }
    });

    it('continues consuming assistant messages even when next user message is pending', async () => {
        const querySpy = vi.spyOn(claudeSdk, 'query').mockImplementation(queryMock as typeof claudeSdk.query);
        const { claudeRemote } = await import('./claudeRemote');
        const pendingNext = deferred<{ message: string; mode: { permissionMode: 'default' } } | null>();
        const received: SDKMessage[] = [];

        const sdkMessages: SDKMessage[] = [
            {
                type: 'assistant',
                message: {
                    role: 'assistant',
                    content: [{ type: 'text', text: 'A_1' }]
                }
            } as unknown as SDKMessage,
            {
                type: 'result',
                subtype: 'success',
                num_turns: 1,
                total_cost_usd: 0,
                duration_ms: 1,
                duration_api_ms: 1,
                is_error: false,
                session_id: 's-1'
            } as unknown as SDKMessage,
            {
                type: 'assistant',
                message: {
                    role: 'assistant',
                    content: [{ type: 'text', text: 'A_2' }]
                }
            } as unknown as SDKMessage
        ];

        queryMock.mockReturnValueOnce(createAsyncStream(sdkMessages));

        let nextCallCount = 0;
        const runPromise = claudeRemote({
            sessionId: 'session-1',
            path: process.cwd(),
            mcpServers: {},
            claudeEnvVars: {},
            claudeArgs: [],
            allowedTools: [],
            hookSettingsPath: '/tmp/hook.json',
            canCallTool: async () => ({ behavior: 'allow', updatedInput: {} }),
            nextMessage: async () => {
                nextCallCount += 1;
                if (nextCallCount === 1) {
                    return { message: 'A', mode: { permissionMode: 'default' } };
                }
                return await pendingNext.promise;
            },
            onReady: () => {},
            isAborted: () => false,
            onSessionFound: () => {},
            onMessage: (message) => {
                received.push(message);
            },
            onCompletionEvent: () => {},
            onSessionReset: () => {}
        });

        await waitFor(() => received.length >= 3);
        expect(received.map((m) => m.type)).toEqual(['assistant', 'result', 'assistant']);

        try {
            pendingNext.resolve(null);
            await runPromise;
        } finally {
            queryMock.mockReset();
            querySpy.mockRestore();
        }
    }, 15_000);

    it('handles rejected next user message fetch without unhandled rejection', async () => {
        const querySpy = vi.spyOn(claudeSdk, 'query').mockImplementation(queryMock as typeof claudeSdk.query);
        const { claudeRemote } = await import('./claudeRemote');
        const received: SDKMessage[] = [];
        const unhandled: unknown[] = [];
        const onUnhandled = (reason: unknown) => {
            unhandled.push(reason);
        };
        process.on('unhandledRejection', onUnhandled);

        const sdkMessages: SDKMessage[] = [
            {
                type: 'assistant',
                message: {
                    role: 'assistant',
                    content: [{ type: 'text', text: 'A_1' }]
                }
            } as unknown as SDKMessage,
            {
                type: 'result',
                subtype: 'success',
                num_turns: 1,
                total_cost_usd: 0,
                duration_ms: 1,
                duration_api_ms: 1,
                is_error: false,
                session_id: 's-1'
            } as unknown as SDKMessage
        ];

        queryMock.mockImplementationOnce(createQueryThatMirrorsPromptErrors(sdkMessages));

        let nextCallCount = 0;
        const runPromise = claudeRemote({
            sessionId: 'session-1',
            path: process.cwd(),
            mcpServers: {},
            claudeEnvVars: {},
            claudeArgs: [],
            allowedTools: [],
            hookSettingsPath: '/tmp/hook.json',
            canCallTool: async () => ({ behavior: 'allow', updatedInput: {} }),
            nextMessage: async () => {
                nextCallCount += 1;
                if (nextCallCount === 1) {
                    return { message: 'A', mode: { permissionMode: 'default' } };
                }
                throw new Error('next message failed');
            },
            onReady: () => {},
            isAborted: () => false,
            onSessionFound: () => {},
            onMessage: (message) => {
                received.push(message);
            },
            onCompletionEvent: () => {},
            onSessionReset: () => {}
        });

        try {
            await expect(runPromise).rejects.toThrow('next message failed');
            await new Promise((resolve) => setTimeout(resolve, 0));
            expect(received.map((m) => m.type)).toEqual(['assistant', 'result']);
            expect(unhandled).toEqual([]);
        } finally {
            queryMock.mockReset();
            querySpy.mockRestore();
            process.off('unhandledRejection', onUnhandled);
        }
    });

    it('treats AbortError from scheduled next user message fetch as graceful shutdown', async () => {
        const querySpy = vi.spyOn(claudeSdk, 'query').mockImplementation(queryMock as typeof claudeSdk.query);
        const { claudeRemote } = await import('./claudeRemote');
        const received: SDKMessage[] = [];
        const unhandled: unknown[] = [];
        const onUnhandled = (reason: unknown) => {
            unhandled.push(reason);
        };
        process.on('unhandledRejection', onUnhandled);

        const sdkMessages: SDKMessage[] = [
            {
                type: 'assistant',
                message: {
                    role: 'assistant',
                    content: [{ type: 'text', text: 'A_1' }]
                }
            } as unknown as SDKMessage,
            {
                type: 'result',
                subtype: 'success',
                num_turns: 1,
                total_cost_usd: 0,
                duration_ms: 1,
                duration_api_ms: 1,
                is_error: false,
                session_id: 's-1'
            } as unknown as SDKMessage
        ];

        queryMock.mockReturnValueOnce(createAsyncStream(sdkMessages));

        let nextCallCount = 0;
        const runPromise = claudeRemote({
            sessionId: 'session-1',
            path: process.cwd(),
            mcpServers: {},
            claudeEnvVars: {},
            claudeArgs: [],
            allowedTools: [],
            hookSettingsPath: '/tmp/hook.json',
            canCallTool: async () => ({ behavior: 'allow', updatedInput: {} }),
            nextMessage: async () => {
                nextCallCount += 1;
                if (nextCallCount === 1) {
                    return { message: 'A', mode: { permissionMode: 'default' } };
                }
                throw new claudeSdk.AbortError('aborted');
            },
            onReady: () => {},
            isAborted: () => false,
            onSessionFound: () => {},
            onMessage: (message) => {
                received.push(message);
            },
            onCompletionEvent: () => {},
            onSessionReset: () => {}
        });

        try {
            await runPromise;
            await new Promise((resolve) => setTimeout(resolve, 0));
            expect(received.map((m) => m.type)).toEqual(['assistant', 'result']);
            expect(unhandled).toEqual([]);
        } finally {
            queryMock.mockReset();
            querySpy.mockRestore();
            process.off('unhandledRejection', onUnhandled);
        }
    });
});

describe('claudeRemote /compact result reporting', () => {
    beforeEach(() => {
        findLatestCompactSummaryMock.mockReset();
        findLatestCompactSummaryMock.mockImplementation(async () => null);
    });
    const resultMessage = {
        type: 'result',
        subtype: 'success',
        num_turns: 1,
        total_cost_usd: 0,
        duration_ms: 1,
        duration_api_ms: 1,
        is_error: false,
        session_id: 's-1'
    } as unknown as SDKMessage;

    let lastForwarded: SDKMessage[] = [];
    async function runCompact(sdkMessages: SDKMessage[]): Promise<string[]> {
        const querySpy = vi.spyOn(claudeSdk, 'query').mockImplementation(queryMock as typeof claudeSdk.query);
        const { claudeRemote } = await import('./claudeRemote');
        const completionEvents: string[] = [];
        const forwarded: SDKMessage[] = [];

        queryMock.mockReturnValueOnce(createAsyncStream(sdkMessages));

        let nextCallCount = 0;
        try {
            await claudeRemote({
                sessionId: 'session-1',
                path: process.cwd(),
                mcpServers: {},
                claudeEnvVars: {},
                claudeArgs: [],
                allowedTools: [],
                hookSettingsPath: '/tmp/hook.json',
                canCallTool: async () => ({ behavior: 'allow', updatedInput: {} }),
                nextMessage: async () => {
                    nextCallCount += 1;
                    if (nextCallCount === 1) {
                        return { message: '/compact', mode: { permissionMode: 'default' } };
                    }
                    return null;
                },
                onReady: (completionEvent) => {
                    if (completionEvent) completionEvents.push(completionEvent);
                },
                isAborted: () => false,
                onSessionFound: () => {},
                onMessage: (message) => {
                    forwarded.push(message);
                },
                onCompletionEvent: (message) => {
                    completionEvents.push(message);
                },
                onSessionReset: () => {}
            });
        } finally {
            queryMock.mockReset();
            querySpy.mockRestore();
        }

        lastForwarded = forwarded;
        return completionEvents;
    }

    it('reports the failure reason when the SDK says the compaction failed', async () => {
        // Shape taken from a real session: the SDK emits a 'compacting' status
        // first, then a second status carrying the outcome.
        const completionEvents = await runCompact([
            {
                type: 'system',
                subtype: 'status',
                status: 'compacting',
                session_id: 's-1',
                uuid: 'u-1'
            } as unknown as SDKMessage,
            {
                type: 'system',
                subtype: 'status',
                status: null,
                compact_result: 'failed',
                compact_error: 'Not enough messages to compact.',
                session_id: 's-1',
                uuid: 'u-2'
            } as unknown as SDKMessage,
            resultMessage
        ]);

        expect(completionEvents).toContain('📦 Compaction started');
        expect(completionEvents.some((event) => event.includes('Not enough messages to compact.'))).toBe(true);
        expect(completionEvents).not.toContain('📦 Compacted');
    }, 15_000);

    it('reports a generic failure without duplicating the fallback text', async () => {
        const completionEvents = await runCompact([
            {
                type: 'system',
                subtype: 'status',
                status: 'compacting',
                session_id: 's-1',
                uuid: 'u-1'
            } as unknown as SDKMessage,
            {
                type: 'system',
                subtype: 'status',
                status: null,
                compact_result: 'failed',
                session_id: 's-1',
                uuid: 'u-2'
            } as unknown as SDKMessage,
            resultMessage
        ]);

        expect(completionEvents).toEqual(['📦 Compaction started', '📦 Compaction failed']);
    }, 15_000);

    it('still reports success when no failure status arrives', async () => {
        const completionEvents = await runCompact([
            {
                type: 'system',
                subtype: 'status',
                status: 'compacting',
                session_id: 's-1',
                uuid: 'u-1'
            } as unknown as SDKMessage,
            resultMessage
        ]);

        expect(completionEvents).toEqual(['📦 Compaction started', '📦 Compacted']);
    }, 15_000);

    it('reports the token delta from the compact_boundary metadata', async () => {
        const completionEvents = await runCompact([
            {
                type: 'system',
                subtype: 'status',
                status: 'compacting',
                session_id: 's-1',
                uuid: 'u-1'
            } as unknown as SDKMessage,
            {
                type: 'system',
                subtype: 'compact_boundary',
                compact_metadata: { trigger: 'manual', pre_tokens: 34492, post_tokens: 2082 },
                session_id: 's-1',
                uuid: 'u-2'
            } as unknown as SDKMessage,
            resultMessage
        ]);

        expect(completionEvents).toEqual(['📦 Compaction started', '📦 Compacted (34492 → 2082 tokens)']);
    }, 15_000);

    it('ignores an autonomous result until the compact stream signal arrives', async () => {
        const completionEvents = await runCompact([
            resultMessage,
            {
                type: 'system',
                subtype: 'status',
                status: 'compacting',
                session_id: 's-1',
                uuid: 'u-status'
            } as unknown as SDKMessage,
            {
                type: 'system',
                subtype: 'compact_boundary',
                compact_metadata: { trigger: 'manual', pre_tokens: 100, post_tokens: 10 },
                session_id: 's-1',
                uuid: 'u-boundary'
            } as unknown as SDKMessage,
            resultMessage
        ]);

        expect(completionEvents).toEqual(['📦 Compaction started', '📦 Compacted (100 → 10 tokens)']);
    }, 15_000);

    it('does not relay the compact_boundary system message during a manual /compact', async () => {
        // The boundary is already surfaced by the completion output (summary
        // card or token-delta line). Relaying it too renders a second
        // "Conversation compacted" event line next to it in the web chat.
        await runCompact([
            {
                type: 'system',
                subtype: 'status',
                status: 'compacting',
                session_id: 's-1',
                uuid: 'u-1'
            } as unknown as SDKMessage,
            {
                type: 'system',
                subtype: 'compact_boundary',
                compact_metadata: { trigger: 'manual', pre_tokens: 34492, post_tokens: 2082 },
                session_id: 's-1',
                uuid: 'u-2'
            } as unknown as SDKMessage,
            resultMessage
        ]);

        expect(
            lastForwarded.some((m) => m.type === 'system' && (m as { subtype?: string }).subtype === 'compact_boundary')
        ).toBe(false);
    }, 15_000);

    it('keeps an automatic boundary visible while a manual /compact is pending', async () => {
        await runCompact([
            {
                type: 'system',
                subtype: 'compact_boundary',
                compact_metadata: { trigger: 'auto', pre_tokens: 50000, post_tokens: 3000 },
                session_id: 's-1',
                uuid: 'u-auto'
            } as unknown as SDKMessage,
            {
                type: 'system',
                subtype: 'compact_boundary',
                compact_metadata: { trigger: 'manual', pre_tokens: 34000, post_tokens: 2000 },
                session_id: 's-1',
                uuid: 'u-manual'
            } as unknown as SDKMessage,
            resultMessage
        ]);

        expect(
            lastForwarded.some((m) =>
                m.type === 'system' &&
                (m as { subtype?: string; compact_metadata?: { trigger?: string } }).subtype === 'compact_boundary' &&
                (m as { compact_metadata?: { trigger?: string } }).compact_metadata?.trigger === 'auto'
            )
        ).toBe(true);
        expect(lastForwarded.some((m) =>
            m.type === 'system' &&
            (m as { compact_metadata?: { trigger?: string } }).compact_metadata?.trigger === 'manual'
        )).toBe(false);
    }, 15_000);

    it('does not relay the Compacted stdout echo during a manual /compact', async () => {
        // The stdout echo is CLI bookkeeping for the active compact only —
        // scoping the suppression here (where the command state lives) keeps
        // identical output from other slash commands visible.
        await runCompact([
            {
                type: 'system',
                subtype: 'status',
                status: 'compacting',
                session_id: 's-1',
                uuid: 'u-1'
            } as unknown as SDKMessage,
            {
                type: 'user',
                message: { role: 'user', content: '<local-command-stdout>Compacted </local-command-stdout>' }
            } as unknown as SDKMessage,
            resultMessage
        ]);

        expect(
            lastForwarded.some((m) =>
                m.type === 'user' &&
                (m as { message?: { content?: unknown } }).message?.content === '<local-command-stdout>Compacted </local-command-stdout>'
            )
        ).toBe(false);
    }, 15_000);

    it('keeps the Compacted stdout echo visible outside a compact turn', async () => {
        const querySpy = vi.spyOn(claudeSdk, 'query').mockImplementation(queryMock as typeof claudeSdk.query);
        const { claudeRemote } = await import('./claudeRemote');
        const forwarded: SDKMessage[] = [];
        queryMock.mockReturnValueOnce(createAsyncStream([
            {
                type: 'user',
                message: { role: 'user', content: '<local-command-stdout>Compacted </local-command-stdout>' }
            } as unknown as SDKMessage,
            resultMessage
        ]));

        let nextCallCount = 0;
        try {
            await claudeRemote({
                sessionId: 'session-1', path: process.cwd(), mcpServers: {}, claudeEnvVars: {},
                claudeArgs: [], allowedTools: [], hookSettingsPath: '/tmp/hook.json',
                canCallTool: async () => ({ behavior: 'allow', updatedInput: {} }),
                nextMessage: async () => {
                    nextCallCount += 1;
                    if (nextCallCount === 1) return { message: 'hi', mode: { permissionMode: 'default' } };
                    return null;
                },
                onReady: () => {},
                isAborted: () => false,
                onSessionFound: () => {},
                onMessage: (message) => {
                    forwarded.push(message);
                },
                onCompletionEvent: () => {},
                onSessionReset: () => {}
            });
        } finally {
            queryMock.mockReset();
            querySpy.mockRestore();
        }

        expect(
            forwarded.some((m) =>
                m.type === 'user' &&
                (m as { message?: { content?: unknown } }).message?.content === '<local-command-stdout>Compacted </local-command-stdout>'
            )
        ).toBe(true);
    }, 15_000);

    it('detects a /compact sent on a later turn, not just the initial one', async () => {
        const querySpy = vi.spyOn(claudeSdk, 'query').mockImplementation(queryMock as typeof claudeSdk.query);
        const { claudeRemote } = await import('./claudeRemote');
        const completionEvents: string[] = [];
        queryMock.mockImplementationOnce(({ prompt }: { prompt: AsyncIterable<unknown> }) => ({
            async *[Symbol.asyncIterator]() {
                const promptIterator = prompt[Symbol.asyncIterator]();
                await promptIterator.next();
                yield resultMessage;
                // A compact response cannot arrive until the later-turn
                // command has actually entered the SDK prompt queue.
                await promptIterator.next();
                yield {
                    type: 'system',
                    subtype: 'compact_boundary',
                    compact_metadata: { trigger: 'manual', pre_tokens: 100, post_tokens: 10 },
                    session_id: 's-1',
                    uuid: 'u-2'
                } as unknown as SDKMessage;
                yield resultMessage;
            }
        }));

        let nextCallCount = 0;
        try {
            await claudeRemote({
                sessionId: 'session-1', path: process.cwd(), mcpServers: {}, claudeEnvVars: {},
                claudeArgs: [], allowedTools: [], hookSettingsPath: '/tmp/hook.json',
                canCallTool: async () => ({ behavior: 'allow', updatedInput: {} }),
                nextMessage: async () => {
                    nextCallCount += 1;
                    if (nextCallCount === 1) return { message: 'hi', mode: { permissionMode: 'default' } };
                    if (nextCallCount === 2) return { message: '/compact', mode: { permissionMode: 'default' } };
                    return null;
                },
                onReady: (completionEvent) => {
                    if (completionEvent) completionEvents.push(completionEvent);
                },
                isAborted: () => false,
                onSessionFound: () => {},
                onMessage: () => {},
                onCompletionEvent: (message) => {
                    completionEvents.push(message);
                },
                onSessionReset: () => {}
            });
        } finally {
            queryMock.mockReset();
            querySpy.mockRestore();
        }

        expect(completionEvents).toContain('📦 Compaction started');
        expect(completionEvents).toContain('📦 Compacted (100 → 10 tokens)');
    }, 15_000);

    it('flushes the result carrier before publishing compact completion', async () => {
        const querySpy = vi.spyOn(claudeSdk, 'query').mockImplementation(queryMock as typeof claudeSdk.query);
        const { claudeRemote } = await import('./claudeRemote');
        const wireOrder: string[] = [];
        const queued: string[] = [];
        queryMock.mockReturnValueOnce(createAsyncStream([
            {
                type: 'system',
                subtype: 'status',
                status: 'compacting',
                session_id: 's-1',
                uuid: 'u-status'
            } as unknown as SDKMessage,
            resultMessage
        ]));

        let nextCallCount = 0;
        try {
            await claudeRemote({
                sessionId: 'session-1', path: process.cwd(), mcpServers: {}, claudeEnvVars: {},
                claudeArgs: [], allowedTools: [], hookSettingsPath: '/tmp/hook.json',
                canCallTool: async () => ({ behavior: 'allow', updatedInput: {} }),
                nextMessage: async () => nextCallCount++ === 0
                    ? { message: '/compact', mode: { permissionMode: 'default' } }
                    : null,
                onReady: (completionEvent) => {
                    wireOrder.push(...queued.splice(0));
                    if (completionEvent) wireOrder.push(completionEvent);
                    wireOrder.push('ready');
                },
                isAborted: () => false,
                onSessionFound: () => {},
                onMessage: (message) => {
                    if (message.type === 'result') queued.push('result');
                },
                onCompletionEvent: (message) => {
                    if (message !== '📦 Compaction started') wireOrder.push(message);
                }
            });
        } finally {
            queryMock.mockReset();
            querySpy.mockRestore();
        }

        expect(wireOrder).toEqual(['result', '📦 Compacted', 'ready']);
    }, 15_000);
});

describe('claudeRemote compact summary promotion', () => {
    beforeEach(() => {
        findLatestCompactSummaryMock.mockReset();
        findLatestCompactSummaryMock.mockImplementation(async () => null);
    });

    const initMessage = {
        type: 'system',
        subtype: 'init',
        session_id: 's-9'
    } as unknown as SDKMessage;

    const resultMessage = {
        type: 'result',
        subtype: 'success',
        num_turns: 1,
        total_cost_usd: 0,
        duration_ms: 1,
        duration_api_ms: 1,
        is_error: false,
        session_id: 's-9'
    } as unknown as SDKMessage;

    let transcriptDir: string | null = null;

    afterEach(async () => {
        if (transcriptDir) {
            await rm(transcriptDir, { recursive: true, force: true });
            transcriptDir = null;
        }
    });

    async function runCompactWithSummary(
        mockSummary: string | null
    ): Promise<{ completionEvents: string[]; compactSummaries: CompactSummaryPayload[]; contextTokens: Array<number | undefined> }> {
        findLatestCompactSummaryMock.mockImplementation(async () => mockSummary);
        const querySpy = vi.spyOn(claudeSdk, 'query').mockImplementation(queryMock as typeof claudeSdk.query);
        const { claudeRemote } = await import('./claudeRemote');
        const completionEvents: string[] = [];
        const compactSummaries: CompactSummaryPayload[] = [];
        const contextTokens: Array<number | undefined> = [];

        // The baseline capture stats the transcript at /compact detection; a
        // missing file makes the lookup skip promotion, so tests that exercise
        // promotion need a real (empty) transcript on disk.
        transcriptDir = await mkdtemp(join(tmpdir(), 'claude-compact-'));
        const projectDir = getProjectPath(transcriptDir);
        await mkdir(projectDir, { recursive: true });
        await writeFile(join(projectDir, 's-9.jsonl'), '');

        queryMock.mockReturnValueOnce(createAsyncStream([
            initMessage,
            {
                type: 'system',
                subtype: 'compact_boundary',
                compact_metadata: { trigger: 'manual', pre_tokens: 34492, post_tokens: 2082 },
                session_id: 's-9',
                uuid: 'u-2'
            } as unknown as SDKMessage,
            resultMessage
        ]));

        let nextCallCount = 0;
        try {
            await claudeRemote({
                sessionId: 's-9',
                path: transcriptDir,
                mcpServers: {},
                claudeEnvVars: {},
                claudeArgs: [],
                allowedTools: [],
                hookSettingsPath: '/tmp/hook.json',
                canCallTool: async () => ({ behavior: 'allow', updatedInput: {} }),
                nextMessage: async () => {
                    nextCallCount += 1;
                    if (nextCallCount === 1) {
                        return { message: '/compact', mode: { permissionMode: 'default' } };
                    }
                    return null;
                },
                onReady: (completionEvent, compactSummary, compactContextTokens) => {
                    if (completionEvent) completionEvents.push(completionEvent);
                    if (compactSummary) compactSummaries.push(compactSummary);
                    contextTokens.push(compactContextTokens);
                },
                isAborted: () => false,
                onSessionFound: () => {},
                onMessage: () => {},
                onCompletionEvent: (message) => {
                    completionEvents.push(message);
                },
                onSessionReset: () => {}
            });
        } finally {
            queryMock.mockReset();
            querySpy.mockRestore();
        }

        return { completionEvents, compactSummaries, contextTokens };
    }

    it('promotes the transcript summary into a structured compact-summary payload', async () => {
        const { completionEvents, compactSummaries, contextTokens } = await runCompactWithSummary('The conversation was about X');

        expect(findLatestCompactSummaryMock).toHaveBeenCalledWith(
            expect.stringContaining(join(getProjectPath(transcriptDir!), 's-9.jsonl').slice(-40)),
            expect.objectContaining({ minBytes: expect.any(Number) })
        );
        expect(compactSummaries).toEqual([
            { summary: 'The conversation was about X', tokensBefore: 34492, tokensAfter: 2082 }
        ]);
        expect(contextTokens).toEqual([2082]);
        expect(completionEvents).toEqual(['📦 Compaction started']);
    }, 15_000);

    it('continues consuming SDK messages while the compact summary is pending', async () => {
        const summary = deferred<string | null>();
        findLatestCompactSummaryMock.mockImplementation(() => summary.promise);
        const querySpy = vi.spyOn(claudeSdk, 'query').mockImplementation(queryMock as typeof claudeSdk.query);
        const { claudeRemote } = await import('./claudeRemote');
        const forwarded: SDKMessage[] = [];
        transcriptDir = await mkdtemp(join(tmpdir(), 'claude-compact-stream-'));
        const projectDir = getProjectPath(transcriptDir);
        await mkdir(projectDir, { recursive: true });
        await writeFile(join(projectDir, 's-9.jsonl'), '');
        queryMock.mockReturnValueOnce(createAsyncStream([
            initMessage,
            {
                type: 'system',
                subtype: 'compact_boundary',
                compact_metadata: { trigger: 'manual', pre_tokens: 100, post_tokens: 10 },
                session_id: 's-9',
                uuid: 'u-boundary'
            } as unknown as SDKMessage,
            resultMessage,
            {
                type: 'assistant',
                message: { role: 'assistant', content: [{ type: 'text', text: 'autonomous' }] },
                session_id: 's-9',
                uuid: 'u-autonomous'
            } as unknown as SDKMessage
        ]));

        let nextCallCount = 0;
        const run = claudeRemote({
            sessionId: 's-9', path: transcriptDir, mcpServers: {}, claudeEnvVars: {},
            claudeArgs: [], allowedTools: [], hookSettingsPath: '/tmp/hook.json',
            canCallTool: async () => ({ behavior: 'allow', updatedInput: {} }),
            nextMessage: async () => nextCallCount++ === 0
                ? { message: '/compact', mode: { permissionMode: 'default' } }
                : null,
            onReady: () => {},
            isAborted: () => false,
            onSessionFound: () => {},
            onMessage: (message) => forwarded.push(message),
            onCompletionEvent: () => {},
            onSessionReset: () => {}
        });

        try {
            await vi.waitFor(() => {
                expect(findLatestCompactSummaryMock).toHaveBeenCalled();
                expect(forwarded.some((message) => message.type === 'assistant')).toBe(true);
            });
            summary.resolve(null);
            await run;
        } finally {
            summary.resolve(null);
            await run.catch(() => {});
            queryMock.mockReset();
            querySpy.mockRestore();
        }
    }, 15_000);

    it('does not publish a successful compact outcome when summary polling is aborted', async () => {
        findLatestCompactSummaryMock.mockImplementation(async (_path, opts) => {
            if (opts?.signal?.aborted) return null;
            await new Promise<void>((resolve) => {
                opts?.signal?.addEventListener('abort', () => resolve(), { once: true });
            });
            return null;
        });
        const querySpy = vi.spyOn(claudeSdk, 'query').mockImplementation(queryMock as typeof claudeSdk.query);
        const { claudeRemote } = await import('./claudeRemote');
        const controller = new AbortController();
        const completionEvents: string[] = [];
        let readyCount = 0;
        transcriptDir = await mkdtemp(join(tmpdir(), 'claude-compact-signal-abort-'));
        const projectDir = getProjectPath(transcriptDir);
        await mkdir(projectDir, { recursive: true });
        await writeFile(join(projectDir, 's-9.jsonl'), '');
        queryMock.mockReturnValueOnce({
            async *[Symbol.asyncIterator]() {
                yield initMessage;
                yield {
                    type: 'system',
                    subtype: 'compact_boundary',
                    compact_metadata: { trigger: 'manual', pre_tokens: 100, post_tokens: 10 },
                    session_id: 's-9',
                    uuid: 'u-boundary'
                } as unknown as SDKMessage;
                yield resultMessage;
                await new Promise<never>(() => {});
            }
        });

        let nextCallCount = 0;
        const run = claudeRemote({
            sessionId: 's-9', path: transcriptDir, mcpServers: {}, claudeEnvVars: {},
            claudeArgs: [], allowedTools: [], hookSettingsPath: '/tmp/hook.json',
            signal: controller.signal,
            canCallTool: async () => ({ behavior: 'allow', updatedInput: {} }),
            nextMessage: async () => {
                nextCallCount += 1;
                return nextCallCount === 1
                    ? { message: '/compact', mode: { permissionMode: 'default' } }
                    : { message: 'must stay queued', mode: { permissionMode: 'default' } };
            },
            onReady: () => {
                readyCount += 1;
            },
            isAborted: () => false,
            onSessionFound: () => {},
            onMessage: () => {},
            onCompletionEvent: (message) => completionEvents.push(message),
            onSessionReset: () => {}
        });

        try {
            await vi.waitFor(() => expect(findLatestCompactSummaryMock).toHaveBeenCalled());
            controller.abort();
            await run;
        } finally {
            controller.abort();
            await run.catch(() => {});
            queryMock.mockReset();
            querySpy.mockRestore();
        }

        expect(completionEvents).toEqual(['📦 Compaction started']);
        expect(readyCount).toBe(0);
        expect(nextCallCount).toBe(1);
    }, 15_000);

    it('publishes compact outcome before consuming an already queued next prompt', async () => {
        const summary = deferred<string | null>();
        findLatestCompactSummaryMock.mockImplementation(() => summary.promise);
        const querySpy = vi.spyOn(claudeSdk, 'query').mockImplementation(queryMock as typeof claudeSdk.query);
        const { claudeRemote } = await import('./claudeRemote');
        const wireOrder: string[] = [];
        transcriptDir = await mkdtemp(join(tmpdir(), 'claude-compact-order-'));
        const projectDir = getProjectPath(transcriptDir);
        await mkdir(projectDir, { recursive: true });
        await writeFile(join(projectDir, 's-9.jsonl'), '');

        queryMock.mockImplementationOnce(({ prompt }: { prompt: AsyncIterable<unknown> }) => ({
            async *[Symbol.asyncIterator]() {
                const promptIterator = prompt[Symbol.asyncIterator]();
                await promptIterator.next();
                yield initMessage;
                yield {
                    type: 'system',
                    subtype: 'compact_boundary',
                    compact_metadata: { trigger: 'manual', pre_tokens: 100, post_tokens: 10 },
                    session_id: 's-9',
                    uuid: 'u-boundary'
                } as unknown as SDKMessage;
                yield resultMessage;
                await promptIterator.next();
                yield resultMessage;
            }
        }));

        let nextCallCount = 0;
        const run = claudeRemote({
            sessionId: 's-9', path: transcriptDir, mcpServers: {}, claudeEnvVars: {},
            claudeArgs: [], allowedTools: [], hookSettingsPath: '/tmp/hook.json',
            canCallTool: async () => ({ behavior: 'allow', updatedInput: {} }),
            nextMessage: async () => {
                nextCallCount += 1;
                if (nextCallCount === 1) return { message: '/compact', mode: { permissionMode: 'default' } };
                if (nextCallCount === 2) {
                    wireOrder.push('next prompt consumed');
                    return { message: 'after compact', mode: { permissionMode: 'default' } };
                }
                return null;
            },
            onReady: (_completionEvent, compactSummary) => {
                if (compactSummary) wireOrder.push('compact outcome');
                wireOrder.push('ready');
            },
            isAborted: () => false,
            onSessionFound: () => {},
            onMessage: () => {},
            onCompletionEvent: () => {},
            onSessionReset: () => {}
        });

        try {
            await vi.waitFor(() => expect(findLatestCompactSummaryMock).toHaveBeenCalled());
            expect(nextCallCount).toBe(1);
            summary.resolve('summary');
            await run;
        } finally {
            summary.resolve(null);
            await run.catch(() => {});
            queryMock.mockReset();
            querySpy.mockRestore();
        }

        expect(wireOrder.slice(0, 3)).toEqual(['compact outcome', 'ready', 'next prompt consumed']);
    }, 15_000);

    it('publishes deferred compact completion before propagating a later stream failure', async () => {
        const summary = deferred<string | null>();
        findLatestCompactSummaryMock.mockImplementation(() => summary.promise);
        const querySpy = vi.spyOn(claudeSdk, 'query').mockImplementation(queryMock as typeof claudeSdk.query);
        const { claudeRemote } = await import('./claudeRemote');
        transcriptDir = await mkdtemp(join(tmpdir(), 'claude-compact-failure-'));
        const projectDir = getProjectPath(transcriptDir);
        await mkdir(projectDir, { recursive: true });
        await writeFile(join(projectDir, 's-9.jsonl'), '');
        queryMock.mockReturnValueOnce({
            async *[Symbol.asyncIterator]() {
                yield initMessage;
                yield {
                    type: 'system',
                    subtype: 'compact_boundary',
                    compact_metadata: { trigger: 'manual', pre_tokens: 100, post_tokens: 10 },
                    session_id: 's-9',
                    uuid: 'u-boundary'
                } as unknown as SDKMessage;
                yield resultMessage;
                throw new Error('stream failed');
            }
        });

        let nextCallCount = 0;
        let readyCount = 0;
        let acceptedCount = 0;
        const readyEvents: Array<string | undefined> = [];
        const completionEvents: string[] = [];
        const run = claudeRemote({
            sessionId: 's-9', path: transcriptDir, mcpServers: {}, claudeEnvVars: {},
            claudeArgs: [], allowedTools: [], hookSettingsPath: '/tmp/hook.json',
            canCallTool: async () => ({ behavior: 'allow', updatedInput: {} }),
            nextMessage: async () => {
                nextCallCount += 1;
                if (nextCallCount === 1) return { message: '/compact', mode: { permissionMode: 'default' } };
                return { message: 'must stay queued', mode: { permissionMode: 'default' } };
            },
            onReady: (completionEvent) => {
                readyCount += 1;
                readyEvents.push(completionEvent);
            },
            onCompactResultAccepted: () => {
                acceptedCount += 1;
            },
            isAborted: () => false,
            onSessionFound: () => {},
            onMessage: () => {},
            onCompletionEvent: (message) => completionEvents.push(message),
            onSessionReset: () => {}
        });
        try {
            await vi.waitFor(() => expect(findLatestCompactSummaryMock).toHaveBeenCalled());
            summary.resolve(null);
            await expect(run).rejects.toThrow('stream failed');
        } finally {
            summary.resolve(null);
            await run.catch(() => {});
            queryMock.mockReset();
            querySpy.mockRestore();
        }

        expect(nextCallCount).toBe(1);
        expect(readyCount).toBe(1);
        expect(acceptedCount).toBe(1);
        expect(readyEvents).toEqual(['📦 Compacted (100 → 10 tokens)']);
        expect(completionEvents).toEqual(['📦 Compaction started']);
    }, 15_000);

    it('does not consume the next prompt when completion and stream failure settle together', async () => {
        findLatestCompactSummaryMock.mockImplementation(async () => null);
        const querySpy = vi.spyOn(claudeSdk, 'query').mockImplementation(queryMock as typeof claudeSdk.query);
        const { claudeRemote } = await import('./claudeRemote');
        transcriptDir = await mkdtemp(join(tmpdir(), 'claude-compact-failure-tie-'));
        const projectDir = getProjectPath(transcriptDir);
        await mkdir(projectDir, { recursive: true });
        await writeFile(join(projectDir, 's-9.jsonl'), '');
        queryMock.mockReturnValueOnce({
            async *[Symbol.asyncIterator]() {
                yield initMessage;
                yield {
                    type: 'system',
                    subtype: 'compact_boundary',
                    compact_metadata: { trigger: 'manual', pre_tokens: 100, post_tokens: 10 },
                    session_id: 's-9',
                    uuid: 'u-boundary'
                } as unknown as SDKMessage;
                yield resultMessage;
                throw new Error('stream failed in tie');
            }
        });

        let nextCallCount = 0;
        const readyEvents: Array<string | undefined> = [];
        try {
            await expect(claudeRemote({
                sessionId: 's-9', path: transcriptDir, mcpServers: {}, claudeEnvVars: {},
                claudeArgs: [], allowedTools: [], hookSettingsPath: '/tmp/hook.json',
                canCallTool: async () => ({ behavior: 'allow', updatedInput: {} }),
                nextMessage: async () => {
                    nextCallCount += 1;
                    return nextCallCount === 1
                        ? { message: '/compact', mode: { permissionMode: 'default' } }
                        : { message: 'must stay queued', mode: { permissionMode: 'default' } };
                },
                onReady: (completionEvent) => {
                    readyEvents.push(completionEvent);
                },
                isAborted: () => false,
                onSessionFound: () => {},
                onMessage: () => {},
                onCompletionEvent: () => {},
                onSessionReset: () => {}
            })).rejects.toThrow('stream failed in tie');
        } finally {
            queryMock.mockReset();
            querySpy.mockRestore();
        }

        expect(readyEvents).toEqual(['📦 Compacted (100 → 10 tokens)']);
        expect(nextCallCount).toBe(1);
    }, 15_000);

    it('propagates a rejected compact onReady callback to the response attempt', async () => {
        findLatestCompactSummaryMock.mockImplementation(async () => 'summary');
        const querySpy = vi.spyOn(claudeSdk, 'query').mockImplementation(queryMock as typeof claudeSdk.query);
        const { claudeRemote } = await import('./claudeRemote');
        transcriptDir = await mkdtemp(join(tmpdir(), 'claude-compact-ready-error-'));
        const projectDir = getProjectPath(transcriptDir);
        await mkdir(projectDir, { recursive: true });
        await writeFile(join(projectDir, 's-9.jsonl'), '');
        queryMock.mockImplementationOnce(createQueryThatMirrorsPromptErrors([
            initMessage,
            {
                type: 'system',
                subtype: 'compact_boundary',
                compact_metadata: { trigger: 'manual', pre_tokens: 100, post_tokens: 10 },
                session_id: 's-9',
                uuid: 'u-boundary'
            } as unknown as SDKMessage,
            resultMessage
        ]));

        let nextCallCount = 0;
        try {
            await expect(claudeRemote({
                sessionId: 's-9', path: transcriptDir, mcpServers: {}, claudeEnvVars: {},
                claudeArgs: [], allowedTools: [], hookSettingsPath: '/tmp/hook.json',
                canCallTool: async () => ({ behavior: 'allow', updatedInput: {} }),
                nextMessage: async () => {
                    nextCallCount += 1;
                    if (nextCallCount === 1) return { message: '/compact', mode: { permissionMode: 'default' } };
                    return { message: 'must stay queued', mode: { permissionMode: 'default' } };
                },
                onReady: async () => {
                    throw new Error('ready failed');
                },
                isAborted: () => false,
                onSessionFound: () => {},
                onMessage: () => {},
                onCompletionEvent: () => {},
                onSessionReset: () => {}
            })).rejects.toThrow('ready failed');
        } finally {
            queryMock.mockReset();
            querySpy.mockRestore();
        }

        expect(nextCallCount).toBe(1);
    }, 15_000);

    it('propagates compact completion failure after the prompt iterable has ended', async () => {
        findLatestCompactSummaryMock.mockImplementation(async () => 'summary');
        const querySpy = vi.spyOn(claudeSdk, 'query').mockImplementation(queryMock as typeof claudeSdk.query);
        const { claudeRemote } = await import('./claudeRemote');
        transcriptDir = await mkdtemp(join(tmpdir(), 'claude-compact-ended-prompt-'));
        const projectDir = getProjectPath(transcriptDir);
        await mkdir(projectDir, { recursive: true });
        await writeFile(join(projectDir, 's-9.jsonl'), '');

        queryMock.mockImplementationOnce(({ prompt }: { prompt: AsyncIterable<unknown> }) => {
            const responseError = deferred<never>();
            return {
                setError(error: Error) {
                    responseError.reject(error);
                },
                async *[Symbol.asyncIterator]() {
                    const promptIterator = prompt[Symbol.asyncIterator]();
                    await promptIterator.next();
                    await promptIterator.return?.();
                    yield initMessage;
                    yield {
                        type: 'system',
                        subtype: 'compact_boundary',
                        compact_metadata: { trigger: 'manual', pre_tokens: 100, post_tokens: 10 },
                        session_id: 's-9',
                        uuid: 'u-boundary'
                    } as unknown as SDKMessage;
                    yield resultMessage;
                    await responseError.promise;
                }
            };
        });

        try {
            await expect(claudeRemote({
                sessionId: 's-9', path: transcriptDir, mcpServers: {}, claudeEnvVars: {},
                claudeArgs: [], allowedTools: [], hookSettingsPath: '/tmp/hook.json',
                canCallTool: async () => ({ behavior: 'allow', updatedInput: {} }),
                nextMessage: async () => ({ message: '/compact', mode: { permissionMode: 'default' } }),
                onReady: async () => {
                    throw new Error('ready failed after prompt end');
                },
                isAborted: () => false,
                onSessionFound: () => {},
                onMessage: () => {},
                onCompletionEvent: () => {},
                onSessionReset: () => {}
            })).rejects.toThrow('ready failed after prompt end');
        } finally {
            queryMock.mockReset();
            querySpy.mockRestore();
        }
    }, 15_000);

    it('cancels deferred compact completion when an aborted tool exits the stream loop', async () => {
        findLatestCompactSummaryMock.mockImplementation(async (_path, opts) => {
            if (opts?.signal?.aborted) return null;
            await new Promise<void>((resolve) => {
                opts?.signal?.addEventListener('abort', () => resolve(), { once: true });
            });
            return null;
        });
        const querySpy = vi.spyOn(claudeSdk, 'query').mockImplementation(queryMock as typeof claudeSdk.query);
        const { claudeRemote } = await import('./claudeRemote');
        transcriptDir = await mkdtemp(join(tmpdir(), 'claude-compact-abort-'));
        const projectDir = getProjectPath(transcriptDir);
        await mkdir(projectDir, { recursive: true });
        await writeFile(join(projectDir, 's-9.jsonl'), '');
        queryMock.mockReturnValueOnce(createAsyncStream([
            initMessage,
            {
                type: 'system',
                subtype: 'compact_boundary',
                compact_metadata: { trigger: 'manual', pre_tokens: 100, post_tokens: 10 },
                session_id: 's-9',
                uuid: 'u-boundary'
            } as unknown as SDKMessage,
            resultMessage,
            {
                type: 'user',
                message: {
                    role: 'user',
                    content: [{ type: 'tool_result', tool_use_id: 'tool-aborted', content: 'cancelled' }]
                }
            } as unknown as SDKMessage
        ]));

        let nextCallCount = 0;
        let readyCount = 0;
        try {
            await claudeRemote({
                sessionId: 's-9', path: transcriptDir, mcpServers: {}, claudeEnvVars: {},
                claudeArgs: [], allowedTools: [], hookSettingsPath: '/tmp/hook.json',
                canCallTool: async () => ({ behavior: 'allow', updatedInput: {} }),
                nextMessage: async () => {
                    nextCallCount += 1;
                    if (nextCallCount === 1) return { message: '/compact', mode: { permissionMode: 'default' } };
                    return { message: 'must stay queued', mode: { permissionMode: 'default' } };
                },
                onReady: () => {
                    readyCount += 1;
                },
                isAborted: (toolCallId) => toolCallId === 'tool-aborted',
                onSessionFound: () => {},
                onMessage: () => {},
                onCompletionEvent: () => {},
                onSessionReset: () => {}
            });
        } finally {
            queryMock.mockReset();
            querySpy.mockRestore();
        }

        expect(nextCallCount).toBe(1);
        expect(readyCount).toBe(0);
    }, 15_000);

    it('skips summary promotion entirely when the transcript baseline cannot be established', async () => {
        // No transcript file on disk: stat fails, the baseline stays null, and
        // reading from offset 0 could promote a previous compaction's summary
        // row — so the lookup must not run at all.
        findLatestCompactSummaryMock.mockImplementation(async () => 'stale summary');
        const dir = await mkdtemp(join(tmpdir(), 'claude-compact-missing-'));
        try {
            const querySpy = vi.spyOn(claudeSdk, 'query').mockImplementation(queryMock as typeof claudeSdk.query);
            const { claudeRemote } = await import('./claudeRemote');
            const completionEvents: string[] = [];
            const readyPayloads: Array<Record<string, unknown> | undefined> = [];
            queryMock.mockReturnValueOnce(createAsyncStream([
                initMessage,
                {
                    type: 'system',
                    subtype: 'status',
                    status: 'compacting',
                    session_id: 's-9',
                    uuid: 'u-status'
                } as unknown as SDKMessage,
                resultMessage
            ]));

            let nextCallCount = 0;
            try {
                await claudeRemote({
                    sessionId: 's-9',
                    path: dir,
                    mcpServers: {},
                    claudeEnvVars: {},
                    claudeArgs: [],
                    allowedTools: [],
                    hookSettingsPath: '/tmp/hook.json',
                    canCallTool: async () => ({ behavior: 'allow', updatedInput: {} }),
                    nextMessage: async () => {
                        nextCallCount += 1;
                        if (nextCallCount === 1) {
                            return { message: '/compact', mode: { permissionMode: 'default' } };
                        }
                        return null;
                    },
                    onReady: (completionEvent, compactSummary) => {
                        if (completionEvent) completionEvents.push(completionEvent);
                        readyPayloads.push(compactSummary as Record<string, unknown> | undefined);
                    },
                    isAborted: () => false,
                    onSessionFound: () => {},
                    onMessage: () => {},
                    onCompletionEvent: (message) => {
                        completionEvents.push(message);
                    },
                    onSessionReset: () => {}
                });
            } finally {
                queryMock.mockReset();
                querySpy.mockRestore();
            }

            expect(findLatestCompactSummaryMock).not.toHaveBeenCalled();
            expect(readyPayloads).toEqual([undefined]);
            expect(completionEvents).toEqual(['📦 Compaction started', '📦 Compacted']);
        } finally {
            await rm(dir, { recursive: true, force: true });
        }
    }, 15_000);

    it('keeps the token delta fallback line when the transcript never yields a summary', async () => {
        const { completionEvents, compactSummaries, contextTokens } = await runCompactWithSummary(null);

        expect(compactSummaries).toEqual([]);
        expect(contextTokens).toEqual([2082]);
        expect(completionEvents).toEqual(['📦 Compaction started', '📦 Compacted (34492 → 2082 tokens)']);
    }, 15_000);
});
