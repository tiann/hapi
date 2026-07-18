import { describe, it, expect, vi } from 'vitest';
import * as claudeSdk from '@/claude/sdk';
import type { CanCallToolCallback, QueryOptions, SDKAssistantMessage, SDKMessage } from '@/claude/sdk/types';
import type { ClaudeLiveAppend } from './claudeRemote';
import { ClaudeProcessExitError } from './utils/remoteFailure';

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
    it('passes /compact through to the official Claude SDK and reports compaction lifecycle events', async () => {
        const querySpy = vi.spyOn(claudeSdk, 'query').mockImplementation(queryMock as typeof claudeSdk.query);
        const { claudeRemote } = await import('./claudeRemote');
        const promptMessages: unknown[] = [];
        const completionEvents: string[] = [];

        queryMock.mockImplementationOnce(({ prompt }: { prompt: AsyncIterable<unknown> }) => ({
            async *[Symbol.asyncIterator]() {
                const promptIterator = prompt[Symbol.asyncIterator]();
                const first = await promptIterator.next();
                promptMessages.push(first.value);

                yield {
                    type: 'result',
                    subtype: 'success',
                    num_turns: 1,
                    total_cost_usd: 0,
                    duration_ms: 1,
                    duration_api_ms: 1,
                    is_error: false,
                    session_id: 's-compact'
                } as unknown as SDKMessage;
            }
        }));

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
                    return nextCallCount === 1
                        ? { message: '/compact now', mode: { permissionMode: 'default' } }
                        : null;
                },
                onReady: () => {},
                isAborted: () => false,
                onSessionFound: () => {},
                onMessage: () => {},
                onCompletionEvent: (event) => {
                    completionEvents.push(event);
                },
                onSessionReset: () => {}
            });

            expect(promptMessages).toEqual([
                { type: 'user', message: { role: 'user', content: '/compact now' } }
            ]);
            expect(completionEvents).toEqual(['Compaction started', 'Compaction completed']);
        } finally {
            queryMock.mockReset();
            querySpy.mockRestore();
        }
    });

    it('can append a user message into the active Claude input stream before result', async () => {
        const querySpy = vi.spyOn(claudeSdk, 'query').mockImplementation(queryMock as typeof claudeSdk.query);
        const { claudeRemote } = await import('./claudeRemote');
        const promptMessages: unknown[] = [];
        const secondPromptReceived = deferred<void>();
        const received: SDKMessage[] = [];

        const appendMessageRef: { current: ClaudeLiveAppend | null } = { current: null };

        queryMock.mockImplementationOnce(({ prompt }: { prompt: AsyncIterable<unknown> }) => ({
            async *[Symbol.asyncIterator]() {
                const promptIterator = prompt[Symbol.asyncIterator]();
                const first = await promptIterator.next();
                promptMessages.push(first.value);

                yield {
                    type: 'assistant',
                    message: {
                        role: 'assistant',
                        content: [{ type: 'text', text: 'working' }]
                    }
                } as unknown as SDKMessage;

                const second = await promptIterator.next();
                promptMessages.push(second.value);
                secondPromptReceived.resolve();

                yield {
                    type: 'result',
                    subtype: 'success',
                    num_turns: 1,
                    total_cost_usd: 0,
                    duration_ms: 1,
                    duration_api_ms: 1,
                    is_error: false,
                    session_id: 's-1'
                } as unknown as SDKMessage;
            }
        }));

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
                return null;
            },
            onReady: () => {},
            isAborted: () => false,
            onSessionFound: () => {},
            onMessage: (message) => {
                received.push(message);
            },
            onCompletionEvent: () => {},
            onSessionReset: () => {},
            registerLiveAppend: (append) => {
                appendMessageRef.current = append;
            }
        });

        try {
            await waitFor(() => appendMessageRef.current !== null && received.length === 1, 1_000);
            expect(appendMessageRef.current?.({ message: 'B', mode: { permissionMode: 'default' } })).toBe(true);
            await secondPromptReceived.promise;
            await runPromise;

            expect(promptMessages).toEqual([
                { type: 'user', message: { role: 'user', content: 'A' } },
                { type: 'user', message: { role: 'user', content: 'B' } }
            ]);
            expect(received.map((m) => m.type)).toEqual(['assistant', 'result']);
        } finally {
            queryMock.mockReset();
            querySpy.mockRestore();
            await runPromise.catch(() => undefined);
        }
    }, 10_000);


    it('marks Claude as thinking again when a scheduled next message starts another stream turn', async () => {
        const querySpy = vi.spyOn(claudeSdk, 'query').mockImplementation(queryMock as typeof claudeSdk.query);
        const { claudeRemote } = await import('./claudeRemote');
        const thinkingChanges: boolean[] = [];

        queryMock.mockImplementationOnce(({ prompt }: { prompt: AsyncIterable<unknown> }) => ({
            async *[Symbol.asyncIterator]() {
                const promptIterator = prompt[Symbol.asyncIterator]();
                await promptIterator.next();

                yield {
                    type: 'result',
                    subtype: 'success',
                    num_turns: 1,
                    total_cost_usd: 0,
                    duration_ms: 1,
                    duration_api_ms: 1,
                    is_error: false,
                    session_id: 's-1'
                } as unknown as SDKMessage;

                await promptIterator.next();

                yield {
                    type: 'result',
                    subtype: 'success',
                    num_turns: 1,
                    total_cost_usd: 0,
                    duration_ms: 1,
                    duration_api_ms: 1,
                    is_error: false,
                    session_id: 's-1'
                } as unknown as SDKMessage;
            }
        }));

        let nextCallCount = 0;
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
                    return { message: 'A', mode: { permissionMode: 'default' } };
                }
                if (nextCallCount === 2) {
                    return { message: 'B', mode: { permissionMode: 'default' } };
                }
                return null;
            },
            onReady: () => {},
            isAborted: () => false,
            onSessionFound: () => {},
            onThinkingChange: (thinking) => {
                thinkingChanges.push(thinking);
            },
            onMessage: () => {},
            onCompletionEvent: () => {},
            onSessionReset: () => {}
        });

        queryMock.mockReset();
        querySpy.mockRestore();

        expect(thinkingChanges).toEqual([true, false, true, false]);
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

        try {
            await waitFor(() => received.length >= 3, 2_000);
            expect(received.map((m) => m.type)).toEqual(['assistant', 'result', 'assistant']);

            pendingNext.resolve(null);
            await runPromise;
        } finally {
            pendingNext.resolve(null);
            await runPromise.catch(() => undefined);
            queryMock.mockReset();
            querySpy.mockRestore();
        }
    }, 10_000);

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

    it('preserves ordinary and observed-exit failures for truthful launcher classification', async () => {
        const querySpy = vi.spyOn(claudeSdk, 'query').mockImplementation(queryMock as typeof claudeSdk.query);
        const { claudeRemote } = await import('./claudeRemote');
        const failures = [
            new Error('Permission denied for this workspace'),
            new ClaudeProcessExitError({ code: 9, signal: null })
        ];

        try {
            for (const failure of failures) {
                queryMock.mockImplementationOnce(() => ({
                    async *[Symbol.asyncIterator]() {
                        throw failure;
                    }
                }));

                const caught = await claudeRemote({
                    sessionId: 'session-1',
                    path: process.cwd(),
                    mcpServers: {},
                    claudeEnvVars: {},
                    claudeArgs: [],
                    allowedTools: [],
                    hookSettingsPath: '/tmp/hook.json',
                    canCallTool: async () => ({ behavior: 'allow', updatedInput: {} }),
                    nextMessage: async () => ({ message: 'A', mode: { permissionMode: 'default' } }),
                    onReady: () => {},
                    isAborted: () => false,
                    onSessionFound: () => {},
                    onMessage: () => {},
                    onCompletionEvent: () => {},
                    onSessionReset: () => {}
                }).catch((error) => error);

                expect(caught).toBe(failure);
            }
        } finally {
            queryMock.mockReset();
            querySpy.mockRestore();
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



    it('arms the background notification guard from the initial queued message before the SDK echo arrives', async () => {
        const querySpy = vi.spyOn(claudeSdk, 'query').mockImplementation(queryMock as typeof claudeSdk.query);
        const { claudeRemote } = await import('./claudeRemote');
        const queryStarted = deferred<void>();
        const continueStream = deferred<void>();
        const capturedCanCallTool: { current?: CanCallToolCallback } = {};

        queryMock.mockImplementationOnce(({ options }: { prompt: AsyncIterable<unknown>; options: QueryOptions }) => {
            capturedCanCallTool.current = options.canCallTool;
            queryStarted.resolve();
            return {
                async *[Symbol.asyncIterator]() {
                    await continueStream.promise;
                    yield {
                        type: 'result',
                        subtype: 'success',
                        num_turns: 1,
                        total_cost_usd: 0,
                        duration_ms: 1,
                        duration_api_ms: 1,
                        is_error: false,
                        session_id: 's-1'
                    } as unknown as SDKMessage;
                }
            };
        });

        let nextCallCount = 0;
        const runPromise = claudeRemote({
            sessionId: 'session-1',
            path: process.cwd(),
            mcpServers: {},
            claudeEnvVars: {},
            claudeArgs: [],
            allowedTools: ['mcp__hapi__send_attachment'],
            hookSettingsPath: '/tmp/hook.json',
            canCallTool: async () => ({ behavior: 'allow', updatedInput: {} }),
            nextMessage: async () => {
                nextCallCount += 1;
                if (nextCallCount === 1) {
                    return {
                        message: '<task-notification><summary>Background command stopped</summary></task-notification>',
                        mode: { permissionMode: 'default' }
                    };
                }
                return null;
            },
            onReady: () => {},
            isAborted: () => false,
            onSessionFound: () => {},
            onMessage: () => {},
            onCompletionEvent: () => {},
            onSessionReset: () => {}
        });

        try {
            await queryStarted.promise;
            const canCallTool = capturedCanCallTool.current;
            if (!canCallTool) throw new Error('Expected canCallTool to be captured');
            await expect(canCallTool('mcp__hapi__send_attachment', { files: [] }, { signal: new AbortController().signal })).resolves.toMatchObject({
                behavior: 'deny',
                message: expect.stringContaining('background task notification')
            });

            continueStream.resolve();
            await runPromise;
        } finally {
            continueStream.resolve();
            await runPromise.catch(() => undefined);
            queryMock.mockReset();
            querySpy.mockRestore();
        }
    }, 10_000);

    it('denies tool calls while handling a background task notification until the SDK echoes a real user message', async () => {
        const querySpy = vi.spyOn(claudeSdk, 'query').mockImplementation(queryMock as typeof claudeSdk.query);
        const { claudeRemote } = await import('./claudeRemote');
        const notificationProcessed = deferred<void>();
        const continueStream = deferred<void>();
        const appendMessageRef: { current: ClaudeLiveAppend | null } = { current: null };
        const capturedCanCallTool: { current?: CanCallToolCallback } = {};
        const capturedOptions: { current?: QueryOptions } = {};
        const downstreamCanCallTool = vi.fn(async () => ({ behavior: 'allow' as const, updatedInput: {} }));

        queryMock.mockImplementationOnce(({ options }: { prompt: AsyncIterable<unknown>; options: QueryOptions }) => {
            capturedOptions.current = options;
            capturedCanCallTool.current = options.canCallTool;
            return {
                async *[Symbol.asyncIterator]() {
                    yield {
                        type: 'user',
                        message: {
                            role: 'user',
                            content: '<task-notification><summary>Background command stopped</summary></task-notification>'
                        }
                    } as unknown as SDKMessage;
                    await continueStream.promise;
                    yield {
                        type: 'result',
                        subtype: 'success',
                        num_turns: 1,
                        total_cost_usd: 0,
                        duration_ms: 1,
                        duration_api_ms: 1,
                        is_error: false,
                        session_id: 's-1'
                    } as unknown as SDKMessage;
                }
            };
        });

        let nextCallCount = 0;
        const runPromise = claudeRemote({
            sessionId: 'session-1',
            path: process.cwd(),
            mcpServers: {},
            claudeEnvVars: {},
            claudeArgs: [],
            allowedTools: ['mcp__hapi__change_title'],
            hookSettingsPath: '/tmp/hook.json',
            canCallTool: downstreamCanCallTool,
            nextMessage: async () => {
                nextCallCount += 1;
                if (nextCallCount === 1) {
                    return { message: 'A', mode: { permissionMode: 'default', allowedTools: ['Bash(echo:*)'] } };
                }
                return null;
            },
            registerLiveAppend: (append) => {
                appendMessageRef.current = append;
            },
            onReady: () => {},
            isAborted: () => false,
            onSessionFound: () => {},
            onMessage: (message) => {
                if (message.type === 'user') notificationProcessed.resolve();
            },
            onCompletionEvent: () => {},
            onSessionReset: () => {}
        });

        try {
            await notificationProcessed.promise;
            const canCallTool = capturedCanCallTool.current;
            if (!canCallTool) throw new Error('Expected canCallTool to be captured');
            expect(capturedOptions.current?.allowedTools).toEqual([]);

            await expect(canCallTool('Bash', { command: 'ls' }, { signal: new AbortController().signal })).resolves.toMatchObject({
                behavior: 'deny',
                message: expect.stringContaining('background task notification')
            });
            expect(downstreamCanCallTool).not.toHaveBeenCalled();

            expect(appendMessageRef.current?.({
                message: '<system-reminder>internal follow-up</system-reminder>',
                mode: { permissionMode: 'default' }
            })).toBe(true);
            await expect(canCallTool('mcp__hapi__change_title', { title: 'x' }, { signal: new AbortController().signal })).resolves.toMatchObject({
                behavior: 'deny',
                message: expect.stringContaining('background task notification')
            });
            expect(downstreamCanCallTool).not.toHaveBeenCalled();

            expect(appendMessageRef.current?.({ message: 'real user follow-up', mode: { permissionMode: 'default' } })).toBe(true);
            await expect(canCallTool('mcp__hapi__change_title', { title: 'x' }, { signal: new AbortController().signal })).resolves.toMatchObject({
                behavior: 'deny',
                message: expect.stringContaining('background task notification')
            });
            expect(downstreamCanCallTool).not.toHaveBeenCalled();

            continueStream.resolve();
            await runPromise;
        } finally {
            continueStream.resolve();
            await runPromise.catch(() => undefined);
            queryMock.mockReset();
            querySpy.mockRestore();
        }
    }, 10_000);

    it('suppresses assistant text emitted while handling an initial background task notification', async () => {
        const querySpy = vi.spyOn(claudeSdk, 'query').mockImplementation(queryMock as typeof claudeSdk.query);
        const { claudeRemote } = await import('./claudeRemote');
        const received: SDKMessage[] = [];
        const durations: number[] = [];
        let readyCount = 0;

        queryMock.mockReturnValueOnce(createAsyncStream([
            {
                type: 'assistant',
                message: {
                    role: 'assistant',
                    content: [{ type: 'text', text: '我会自己继续整条链，不用你管。' }]
                }
            } as unknown as SDKMessage,
            {
                type: 'result',
                subtype: 'success',
                num_turns: 1,
                total_cost_usd: 0,
                duration_ms: 99,
                duration_api_ms: 99,
                is_error: false,
                session_id: 's-1'
            } as unknown as SDKMessage
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
                nextMessage: async () => {
                    nextCallCount += 1;
                    if (nextCallCount === 1) {
                        return {
                            message: '<task-notification><summary>Background command completed</summary></task-notification>',
                            mode: { permissionMode: 'default' }
                        };
                    }
                    return null;
                },
                onReady: () => {
                    readyCount += 1;
                },
                onTurnDuration: (durationMs) => {
                    durations.push(durationMs);
                },
                isAborted: () => false,
                onSessionFound: () => {},
                onMessage: (message) => {
                    received.push(message);
                },
                onCompletionEvent: () => {},
                onSessionReset: () => {}
            });

            expect(received.some((message) => message.type === 'assistant')).toBe(false);
            expect(readyCount).toBe(1);
            expect(durations).toEqual([99]);
        } finally {
            queryMock.mockReset();
            querySpy.mockRestore();
        }
    });

    it('arms the background notification guard from Claude SDK system task_notification events', async () => {
        const querySpy = vi.spyOn(claudeSdk, 'query').mockImplementation(queryMock as typeof claudeSdk.query);
        const { claudeRemote } = await import('./claudeRemote');
        const notificationProcessed = deferred<void>();
        const continueStream = deferred<void>();
        const capturedCanCallTool: { current?: CanCallToolCallback } = {};
        const downstreamCanCallTool = vi.fn(async () => ({ behavior: 'allow' as const, updatedInput: {} }));

        queryMock.mockImplementationOnce(({ options }: { prompt: AsyncIterable<unknown>; options: QueryOptions }) => {
            capturedCanCallTool.current = options.canCallTool;
            return {
                async *[Symbol.asyncIterator]() {
                    yield {
                        type: 'system',
                        subtype: 'task_notification',
                        task_id: 'task-1',
                        status: 'completed',
                        summary: 'Background command completed (exit code 0)',
                        session_id: 's-1'
                    } as unknown as SDKMessage;

                    await continueStream.promise;
                    yield {
                        type: 'result',
                        subtype: 'success',
                        num_turns: 1,
                        total_cost_usd: 0,
                        duration_ms: 1,
                        duration_api_ms: 1,
                        is_error: false,
                        session_id: 's-1',
                        origin: { kind: 'task-notification' }
                    } as unknown as SDKMessage;
                }
            };
        });

        let nextCallCount = 0;
        const runPromise = claudeRemote({
            sessionId: 'session-1',
            path: process.cwd(),
            mcpServers: {},
            claudeEnvVars: {},
            claudeArgs: [],
            allowedTools: ['Read'],
            hookSettingsPath: '/tmp/hook.json',
            canCallTool: downstreamCanCallTool,
            nextMessage: async () => {
                nextCallCount += 1;
                if (nextCallCount === 1) {
                    return { message: 'initial real user message', mode: { permissionMode: 'default' } };
                }
                return null;
            },
            onReady: () => {},
            isAborted: () => false,
            onSessionFound: () => {},
            onMessage: (message) => {
                if (message.type === 'system') notificationProcessed.resolve();
            },
            onCompletionEvent: () => {},
            onSessionReset: () => {}
        });

        try {
            await notificationProcessed.promise;
            const canCallTool = capturedCanCallTool.current;
            if (!canCallTool) throw new Error('Expected canCallTool to be captured');

            await expect(canCallTool('Read', { file_path: '/tmp/output' }, { signal: new AbortController().signal })).resolves.toMatchObject({
                behavior: 'deny',
                message: expect.stringContaining('background task notification')
            });
            expect(downstreamCanCallTool).not.toHaveBeenCalled();

            continueStream.resolve();
            await runPromise;
        } finally {
            continueStream.resolve();
            await runPromise.catch(() => undefined);
            queryMock.mockReset();
            querySpy.mockRestore();
        }
    }, 10_000);

    it('ends the autonomous Claude SDK task_notification turn before assistant tools or text run', async () => {
        const querySpy = vi.spyOn(claudeSdk, 'query').mockImplementation(queryMock as typeof claudeSdk.query);
        const { claudeRemote } = await import('./claudeRemote');
        const received: SDKMessage[] = [];
        const durations: number[] = [];
        const abortCurrentTurn = vi.fn();
        let readyCount = 0;

        queryMock.mockReturnValueOnce(createAsyncStream([
            {
                type: 'system',
                subtype: 'task_notification',
                task_id: 'task-1',
                status: 'completed',
                summary: 'Background command completed (exit code 0)',
                session_id: 's-1'
            } as unknown as SDKMessage,
            {
                type: 'assistant',
                message: {
                    role: 'assistant',
                    content: [{ type: 'tool_use', id: 'tool-1', name: 'Read', input: { file_path: '/tmp/output' } }]
                }
            } as unknown as SDKMessage,
            {
                type: 'assistant',
                message: {
                    role: 'assistant',
                    content: [{ type: 'text', text: '后台任务完成后我会继续扩展任务。' }]
                }
            } as unknown as SDKMessage,
            {
                type: 'result',
                subtype: 'success',
                num_turns: 1,
                total_cost_usd: 0,
                duration_ms: 77,
                duration_api_ms: 77,
                is_error: false,
                session_id: 's-1',
                origin: { kind: 'task-notification' }
            } as unknown as SDKMessage
        ]));

        let nextCallCount = 0;
        try {
            const reason = await claudeRemote({
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
                        return { message: 'initial real user message', mode: { permissionMode: 'default' } };
                    }
                    return null;
                },
                onReady: () => {
                    readyCount += 1;
                },
                onTurnDuration: (durationMs) => {
                    durations.push(durationMs);
                },
                isAborted: () => false,
                onSessionFound: () => {},
                onMessage: (message) => {
                    received.push(message);
                },
                onCompletionEvent: () => {},
                onSessionReset: () => {},
                abortCurrentTurn
            });

            expect(reason).toBe('background-notification');
            expect(abortCurrentTurn).toHaveBeenCalledOnce();
            expect(received.map((message) => message.type)).toEqual(['system']);
            expect(readyCount).toBe(1);
            expect(durations).toEqual([]);
        } finally {
            queryMock.mockReset();
            querySpy.mockRestore();
        }
    });

    it('does not abort a system task_notification when a real queued user message is already pending SDK echo', async () => {
        const querySpy = vi.spyOn(claudeSdk, 'query').mockImplementation(queryMock as typeof claudeSdk.query);
        const { claudeRemote } = await import('./claudeRemote');
        const promptMessages: unknown[] = [];
        const secondPromptReceived = deferred<void>();
        const received: SDKMessage[] = [];
        const abortCurrentTurn = vi.fn();

        queryMock.mockImplementationOnce(({ prompt }: { prompt: AsyncIterable<unknown> }) => ({
            async *[Symbol.asyncIterator]() {
                const promptIterator = prompt[Symbol.asyncIterator]();
                const first = await promptIterator.next();
                promptMessages.push(first.value);

                yield {
                    type: 'result',
                    subtype: 'success',
                    num_turns: 1,
                    total_cost_usd: 0,
                    duration_ms: 1,
                    duration_api_ms: 1,
                    is_error: false,
                    session_id: 's-1'
                } as unknown as SDKMessage;

                const second = await promptIterator.next();
                promptMessages.push(second.value);
                secondPromptReceived.resolve();

                yield {
                    type: 'system',
                    subtype: 'task_notification',
                    task_id: 'task-1',
                    status: 'completed',
                    summary: 'Background command completed (exit code 0)',
                    session_id: 's-1'
                } as unknown as SDKMessage;

                yield {
                    type: 'assistant',
                    message: {
                        role: 'assistant',
                        content: [{ type: 'text', text: '真实用户消息已经排进当前 turn，所以不能被 task notification abort 丢掉。' }]
                    }
                } as unknown as SDKMessage;

                yield {
                    type: 'result',
                    subtype: 'success',
                    num_turns: 1,
                    total_cost_usd: 0,
                    duration_ms: 2,
                    duration_api_ms: 2,
                    is_error: false,
                    session_id: 's-1'
                } as unknown as SDKMessage;
            }
        }));

        let nextCallCount = 0;
        try {
            const reason = await claudeRemote({
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
                        return { message: 'initial real user message', mode: { permissionMode: 'default' } };
                    }
                    if (nextCallCount === 2) {
                        return { message: 'real user follow-up', mode: { permissionMode: 'default' } };
                    }
                    return null;
                },
                onReady: () => {},
                isAborted: () => false,
                onSessionFound: () => {},
                onMessage: (message) => {
                    received.push(message);
                },
                onCompletionEvent: () => {},
                onSessionReset: () => {},
                abortCurrentTurn
            });

            await secondPromptReceived.promise;
            expect(reason).toBeUndefined();
            expect(abortCurrentTurn).not.toHaveBeenCalled();
            expect(promptMessages).toEqual([
                { type: 'user', message: { role: 'user', content: 'initial real user message' } },
                { type: 'user', message: { role: 'user', content: 'real user follow-up' } }
            ]);

            const assistantTexts = received
                .filter((message): message is SDKAssistantMessage => message.type === 'assistant')
                .flatMap((message) => message.message.content
                    .filter((block): block is { type: 'text'; text: string } => block.type === 'text')
                    .map((block) => block.text));
            expect(assistantTexts).toEqual(['真实用户消息已经排进当前 turn，所以不能被 task notification abort 丢掉。']);
        } finally {
            queryMock.mockReset();
            querySpy.mockRestore();
        }
    });

    it('keeps the background guard armed until a pending real user message is echoed', async () => {
        const querySpy = vi.spyOn(claudeSdk, 'query').mockImplementation(queryMock as typeof claudeSdk.query);
        const { claudeRemote } = await import('./claudeRemote');
        const realUserQueued = deferred<void>();
        const appendMessageRef: { current: ClaudeLiveAppend | null } = { current: null };
        const received: SDKMessage[] = [];
        const abortCurrentTurn = vi.fn();

        queryMock.mockImplementationOnce(() => ({
            async *[Symbol.asyncIterator]() {
                yield {
                    type: 'user',
                    message: {
                        role: 'user',
                        content: '<task-notification><summary>Background command completed</summary></task-notification>'
                    }
                } as unknown as SDKMessage;

                await realUserQueued.promise;

                yield {
                    type: 'system',
                    subtype: 'task_notification',
                    task_id: 'task-1',
                    status: 'completed',
                    summary: 'Background command completed (exit code 0)',
                    session_id: 's-1'
                } as unknown as SDKMessage;

                yield {
                    type: 'assistant',
                    message: {
                        role: 'assistant',
                        content: [{ type: 'text', text: '这条 notification 自言自语必须等真实用户 echo 前被压住。' }]
                    }
                } as unknown as SDKMessage;

                yield {
                    type: 'user',
                    message: {
                        role: 'user',
                        content: 'real user follow-up'
                    }
                } as unknown as SDKMessage;

                yield {
                    type: 'assistant',
                    message: {
                        role: 'assistant',
                        content: [{ type: 'text', text: '真实用户 echo 后可以回复。' }]
                    }
                } as unknown as SDKMessage;

                yield {
                    type: 'result',
                    subtype: 'success',
                    num_turns: 1,
                    total_cost_usd: 0,
                    duration_ms: 1,
                    duration_api_ms: 1,
                    is_error: false,
                    session_id: 's-1'
                } as unknown as SDKMessage;
            }
        }));

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
                    return {
                        message: '<task-notification><summary>Background command completed</summary></task-notification>',
                        mode: { permissionMode: 'default' }
                    };
                }
                return null;
            },
            registerLiveAppend: (append) => {
                appendMessageRef.current = append;
            },
            onReady: () => {},
            isAborted: () => false,
            onSessionFound: () => {},
            onMessage: (message) => {
                received.push(message);
            },
            onCompletionEvent: () => {},
            onSessionReset: () => {},
            abortCurrentTurn
        });

        try {
            await waitFor(() => appendMessageRef.current !== null, 1_000);
            expect(appendMessageRef.current?.({ message: 'real user follow-up', mode: { permissionMode: 'default' } })).toBe(true);
            realUserQueued.resolve();
            const reason = await runPromise;

            expect(reason).toBeUndefined();
            expect(abortCurrentTurn).not.toHaveBeenCalled();
            const assistantTexts = received
                .filter((message): message is SDKAssistantMessage => message.type === 'assistant')
                .flatMap((message) => message.message.content
                    .filter((block): block is { type: 'text'; text: string } => block.type === 'text')
                    .map((block) => block.text));
            expect(assistantTexts).toEqual(['真实用户 echo 后可以回复。']);
        } finally {
            realUserQueued.resolve();
            await runPromise.catch(() => undefined);
            queryMock.mockReset();
            querySpy.mockRestore();
        }
    }, 10_000);

    it('counts multiple pending real user messages before allowing system task_notification aborts', async () => {
        const querySpy = vi.spyOn(claudeSdk, 'query').mockImplementation(queryMock as typeof claudeSdk.query);
        const { claudeRemote } = await import('./claudeRemote');
        const appendMessageRef: { current: ClaudeLiveAppend | null } = { current: null };
        const secondPromptReceived = deferred<void>();
        const thirdPromptReceived = deferred<void>();
        const received: SDKMessage[] = [];
        const abortCurrentTurn = vi.fn();

        queryMock.mockImplementationOnce(({ prompt }: { prompt: AsyncIterable<unknown> }) => ({
            async *[Symbol.asyncIterator]() {
                const promptIterator = prompt[Symbol.asyncIterator]();
                await promptIterator.next();

                const second = await promptIterator.next();
                expect(second.value).toEqual({ type: 'user', message: { role: 'user', content: 'real user follow-up B' } });
                secondPromptReceived.resolve();

                const third = await promptIterator.next();
                expect(third.value).toEqual({ type: 'user', message: { role: 'user', content: 'real user follow-up C' } });
                thirdPromptReceived.resolve();

                yield {
                    type: 'user',
                    message: {
                        role: 'user',
                        content: 'real user follow-up B'
                    }
                } as unknown as SDKMessage;

                yield {
                    type: 'system',
                    subtype: 'task_notification',
                    task_id: 'task-1',
                    status: 'completed',
                    summary: 'Background command completed (exit code 0)',
                    session_id: 's-1'
                } as unknown as SDKMessage;

                yield {
                    type: 'assistant',
                    message: {
                        role: 'assistant',
                        content: [{ type: 'text', text: 'C 仍在 pending echo，不能被 task notification abort 丢掉。' }]
                    }
                } as unknown as SDKMessage;

                yield {
                    type: 'user',
                    message: {
                        role: 'user',
                        content: 'real user follow-up C'
                    }
                } as unknown as SDKMessage;

                yield {
                    type: 'result',
                    subtype: 'success',
                    num_turns: 1,
                    total_cost_usd: 0,
                    duration_ms: 1,
                    duration_api_ms: 1,
                    is_error: false,
                    session_id: 's-1'
                } as unknown as SDKMessage;
            }
        }));

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
                    return { message: 'initial real user message', mode: { permissionMode: 'default' } };
                }
                return null;
            },
            registerLiveAppend: (append) => {
                appendMessageRef.current = append;
            },
            onReady: () => {},
            isAborted: () => false,
            onSessionFound: () => {},
            onMessage: (message) => {
                received.push(message);
            },
            onCompletionEvent: () => {},
            onSessionReset: () => {},
            abortCurrentTurn
        });

        try {
            await waitFor(() => appendMessageRef.current !== null, 1_000);
            expect(appendMessageRef.current?.({ message: 'real user follow-up B', mode: { permissionMode: 'default' } })).toBe(true);
            expect(appendMessageRef.current?.({ message: 'real user follow-up C', mode: { permissionMode: 'default' } })).toBe(true);
            await secondPromptReceived.promise;
            await thirdPromptReceived.promise;
            const reason = await runPromise;

            expect(reason).toBeUndefined();
            expect(abortCurrentTurn).not.toHaveBeenCalled();
            const assistantTexts = received
                .filter((message): message is SDKAssistantMessage => message.type === 'assistant')
                .flatMap((message) => message.message.content
                    .filter((block): block is { type: 'text'; text: string } => block.type === 'text')
                    .map((block) => block.text));
            expect(assistantTexts).toEqual(['C 仍在 pending echo，不能被 task notification abort 丢掉。']);
        } finally {
            await runPromise.catch(() => undefined);
            queryMock.mockReset();
            querySpy.mockRestore();
        }
    }, 10_000);

    it('keeps suppressing notification-turn assistant text until the SDK echoes a real user message', async () => {
        const querySpy = vi.spyOn(claudeSdk, 'query').mockImplementation(queryMock as typeof claudeSdk.query);
        const { claudeRemote } = await import('./claudeRemote');
        const notificationProcessed = deferred<void>();
        const realUserQueued = deferred<void>();
        const appendMessageRef: { current: ClaudeLiveAppend | null } = { current: null };
        const received: SDKMessage[] = [];

        queryMock.mockImplementationOnce(() => ({
            async *[Symbol.asyncIterator]() {
                yield {
                    type: 'user',
                    message: {
                        role: 'user',
                        content: '<task-notification><summary>Background command completed</summary></task-notification>'
                    }
                } as unknown as SDKMessage;
                notificationProcessed.resolve();

                await realUserQueued.promise;

                yield {
                    type: 'assistant',
                    message: {
                        role: 'assistant',
                        content: [{ type: 'text', text: '旧 notification turn 的自言自语不应出现。' }]
                    }
                } as unknown as SDKMessage;

                yield {
                    type: 'user',
                    message: {
                        role: 'user',
                        content: 'real user follow-up'
                    }
                } as unknown as SDKMessage;

                yield {
                    type: 'assistant',
                    message: {
                        role: 'assistant',
                        content: [{ type: 'text', text: '真实用户消息之后的回复可以出现。' }]
                    }
                } as unknown as SDKMessage;

                yield {
                    type: 'result',
                    subtype: 'success',
                    num_turns: 1,
                    total_cost_usd: 0,
                    duration_ms: 1,
                    duration_api_ms: 1,
                    is_error: false,
                    session_id: 's-1'
                } as unknown as SDKMessage;
            }
        }));

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
                    return { message: 'initial real user message', mode: { permissionMode: 'default' } };
                }
                return null;
            },
            registerLiveAppend: (append) => {
                appendMessageRef.current = append;
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
            await notificationProcessed.promise;
            expect(appendMessageRef.current?.({
                message: 'real user follow-up',
                mode: { permissionMode: 'default' }
            })).toBe(true);
            realUserQueued.resolve();
            await runPromise;

            const assistantTexts = received
                .filter((message): message is SDKAssistantMessage => message.type === 'assistant')
                .flatMap((message) => {
                    const content = message.message.content;
                    return Array.isArray(content)
                        ? content
                            .filter((block): block is { type: 'text'; text: string } => block.type === 'text')
                            .map((block) => block.text)
                        : [];
                });

            expect(assistantTexts).toEqual(['真实用户消息之后的回复可以出现。']);
        } finally {
            realUserQueued.resolve();
            await runPromise.catch(() => undefined);
            queryMock.mockReset();
            querySpy.mockRestore();
        }
    }, 10_000);

    it('reports Claude result duration for HAPI turn-duration display', async () => {
        const querySpy = vi.spyOn(claudeSdk, 'query').mockImplementation(queryMock as typeof claudeSdk.query);
        const { claudeRemote } = await import('./claudeRemote');
        const durations: number[] = [];

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
                duration_ms: 12_345,
                duration_api_ms: 10_000,
                is_error: false,
                session_id: 's-1'
            } as unknown as SDKMessage
        ];

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
                        return { message: 'A', mode: { permissionMode: 'default' } };
                    }
                    return null;
                },
                onReady: () => {},
                onTurnDuration: (durationMs) => {
                    durations.push(durationMs);
                },
                isAborted: () => false,
                onSessionFound: () => {},
                onMessage: () => {},
                onCompletionEvent: () => {},
                onSessionReset: () => {}
            });

            expect(durations).toEqual([12_345]);
        } finally {
            queryMock.mockReset();
            querySpy.mockRestore();
        }
    });
});
