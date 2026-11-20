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

    it('marks every follow-up turn as thinking until its result', async () => {
        const querySpy = vi.spyOn(claudeSdk, 'query').mockImplementation(queryMock as typeof claudeSdk.query);
        const { claudeRemote } = await import('./claudeRemote');
        const result = { type: 'result', subtype: 'success' } as unknown as SDKMessage;
        queryMock.mockImplementationOnce(({ prompt }: { prompt: AsyncIterable<unknown> }) => ({
            async *[Symbol.asyncIterator]() {
                const promptIterator = prompt[Symbol.asyncIterator]();
                await promptIterator.next();
                yield result;
                await promptIterator.next();
                yield result;
            }
        }));

        const thinking: boolean[] = [];
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
                nextMessage: async () => nextCallCount++ < 2
                    ? { message: `turn ${nextCallCount}`, mode: { permissionMode: 'default' } }
                    : null,
                onReady: () => {},
                isAborted: () => false,
                onSessionFound: () => {},
                onMessage: () => {},
                onThinkingChange: (value) => thinking.push(value)
            });

            expect(thinking).toEqual([true, false, true, false]);
        } finally {
            queryMock.mockReset();
            querySpy.mockRestore();
        }
    });

    it('resets thinking when query() throws synchronously after initial turn delivery', async () => {
        const querySpy = vi.spyOn(claudeSdk, 'query').mockImplementation(queryMock as typeof claudeSdk.query);
        const { claudeRemote } = await import('./claudeRemote');
        queryMock.mockImplementationOnce(() => {
            throw new Error('Fallback model cannot be the same as main model');
        });

        const thinking: boolean[] = [];
        try {
            await expect(claudeRemote({
                sessionId: 'session-1',
                path: process.cwd(),
                mcpServers: {},
                claudeEnvVars: {},
                claudeArgs: [],
                allowedTools: [],
                hookSettingsPath: '/tmp/hook.json',
                canCallTool: async () => ({ behavior: 'allow', updatedInput: {} }),
                nextMessage: async () => ({
                    message: 'Review this project',
                    mode: { permissionMode: 'default', model: 'sonnet', fallbackModel: 'sonnet' }
                }),
                onReady: () => {},
                isAborted: () => false,
                onSessionFound: () => {},
                onMessage: () => {},
                onThinkingChange: (value) => thinking.push(value)
            })).rejects.toThrow('Fallback model cannot be the same as main model');

            expect(thinking).toEqual([true, false]);
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
            // A normal round result carries no compaction marker.
            expect(received[1]).not.toHaveProperty('hapi_compact_turn');
            expect(unhandled).toEqual([]);
        } finally {
            queryMock.mockReset();
            querySpy.mockRestore();
            process.off('unhandledRejection', onUnhandled);
        }
    });
});

describe('claudeRemote in-process /clear', () => {
    it.each([
        'success', 'failure', 'untagged-failure', 'eof', 'no-result',
        'autonomous-eof', 'acknowledged', 'hook', 'late-result', 'late-init',
        'late-stale-result', 'late-hook', 'tagged-timeout', 'silent-timeout', 'result-eof',
        'unacknowledged-input-eof', 'acknowledged-input-eof', 'failed-clear-input-eof',
        'follow-up-result', 'legacy-follow-up-result', 'follow-up-after-compact', 'later-follow-up-result', 'idle-background-output'
    ] as const)('settles an in-process clear on %s', async (outcome) => {
        const querySpy = vi.spyOn(claudeSdk, 'query').mockImplementation(queryMock as typeof claudeSdk.query);
        const { claudeRemote } = await import('./claudeRemote');
        const order: string[] = [];
        const forwarded: SDKMessage[] = [];
        const priorId = 'previous-native-session';
        const lateRotation = outcome === 'late-result' || outcome === 'late-init' || outcome === 'late-stale-result' || outcome === 'late-hook';
        const timesOut = lateRotation || outcome === 'untagged-failure' || outcome === 'tagged-timeout' || outcome === 'silent-timeout';
        const exitsAfterFollowUp = outcome === 'unacknowledged-input-eof' || outcome === 'acknowledged-input-eof';
        const legacyFollowUp = outcome === 'legacy-follow-up-result';
        const interveningCompact = outcome === 'follow-up-after-compact';
        const hasLaterFollowUp = outcome === 'later-follow-up-result';
        const idleBackgroundOutput = outcome === 'idle-background-output';
        const hasFollowUpResult = outcome === 'follow-up-result' || legacyFollowUp || interveningCompact || hasLaterFollowUp;
        const success = outcome === 'success' || outcome === 'eof' || outcome === 'hook'
            || outcome === 'result-eof' || exitsAfterFollowUp || hasFollowUpResult || idleBackgroundOutput;
        const resultId = success || lateRotation ? 'fresh-native-session' : priorId;
        const timeoutNotice = 'Claude did not identify the /clear result. Waiting for Claude to exit so background tasks can finish.';
        const completion = success ? 'Context was reset'
            : timesOut ? timeoutNotice : 'Could not reset context';
        let hookSessionId: string | undefined;
        let awaitingLateClearHook = false;
        const dequeuedFollowUp = deferred<void>();
        const finishFollowUp = deferred<void>();
        const clearContextTokens: Array<number | undefined> = [];
        const thinking: boolean[] = [];
        const result: SDKMessage = {
            type: 'result', subtype: 'success', is_error: false, session_id: priorId, user_message_uuid: 'first-input'
        };
        const unmatchedResult = { ...result, is_error: true, user_message_uuid: outcome === 'tagged-timeout' ? 'autonomous-input' : undefined };
        const autonomousResult = { ...result, user_message_uuid: undefined };
        const firstResult = legacyFollowUp ? { ...autonomousResult, local_command: 'compact' } : result;
        const foreignResults = [result, autonomousResult].map((message) => ({
            ...message, session_id: legacyFollowUp ? priorId : resultId
        }));
        let followUpResult: SDKMessage | undefined;
        let laterFollowUpResult: SDKMessage | undefined;
        let compactResult: SDKMessage | undefined;

        queryMock.mockImplementationOnce(({ prompt }: { prompt: AsyncIterable<{ uuid: string; message: { content: string } }> }) => ({
            async *[Symbol.asyncIterator]() {
                const input = prompt[Symbol.asyncIterator]();
                await input.next();
                yield { type: 'system', subtype: 'init', session_id: priorId };
                yield firstResult;
                const clear = await input.next();
                expect(clear.value?.message.content).toBe('/clear');
                yield result;
                if (outcome === 'hook') {
                    hookSessionId = resultId;
                } else if (success) {
                    yield { type: 'system', subtype: 'init', session_id: resultId };
                }
                await Promise.resolve();
                expect(order).toEqual([`session:${priorId}`, 'ready', '/clear']);
                if (outcome === 'eof' || outcome === 'no-result') return;
                if (outcome === 'autonomous-eof') {
                    yield { ...result, user_message_uuid: undefined };
                    return;
                }
                if (outcome === 'acknowledged') {
                    yield { type: 'user', isReplay: true, uuid: clear.value?.uuid };
                    return;
                }
                if (timesOut) {
                    if (outcome !== 'silent-timeout') yield unmatchedResult;
                } else {
                    yield {
                        ...result,
                        is_error: !success,
                        ...(outcome === 'success' ? { local_command: 'clear' } : {}),
                        session_id: resultId,
                        user_message_uuid: outcome === 'hook' ? undefined : clear.value?.uuid
                    };
                }
                if (timesOut) {
                    expect(order).not.toContain('accepted');
                    await vi.advanceTimersByTimeAsync(31_000);
                    expect(order).toContain(timeoutNotice);
                }
                if (outcome === 'result-eof') {
                    await dequeuedFollowUp.promise;
                    return;
                }
                if (idleBackgroundOutput) {
                    yield { type: 'assistant', session_id: priorId, message: { role: 'assistant', content: [] } };
                    yield autonomousResult;
                    expect(thinking.at(-1)).toBe(false);
                    return;
                }
                if (interveningCompact) {
                    const compact = await input.next();
                    expect(compact.value?.message.content).toBe('/compact');
                    yield { type: 'system', subtype: 'status', session_id: priorId, compact_result: 'failed' };
                    yield { type: 'system', subtype: 'status', status: 'compacting' };
                    compactResult = { ...result, session_id: resultId, user_message_uuid: compact.value?.uuid };
                    yield compactResult;
                }
                const followUp = await input.next();
                if (timesOut) {
                    expect(followUp.done).toBe(true);
                    await vi.advanceTimersByTimeAsync(120_000);
                    if (lateRotation) {
                        yield { ...result, session_id: 'unrelated-session', local_command: 'clear', user_message_uuid: undefined };
                        expect(order).not.toContain('reset');
                        if (outcome === 'late-result') {
                            yield { ...result, session_id: resultId, user_message_uuid: clear.value?.uuid };
                        } else if (outcome === 'late-hook') {
                            expect(awaitingLateClearHook).toBe(true);
                            hookSessionId = resultId;
                        } else {
                            yield { type: 'system', subtype: 'init', session_id: resultId };
                            if (outcome === 'late-stale-result') {
                                yield { ...result, is_error: true, user_message_uuid: clear.value?.uuid };
                            }
                        }
                    }
                } else {
                    expect(order).toContain(completion);
                    expect(followUp.value?.message.content).toBe('follow-up');
                    if (outcome === 'unacknowledged-input-eof') yield result;
                    if (outcome === 'acknowledged-input-eof' || hasFollowUpResult) {
                        yield { type: 'user', isReplay: true, uuid: followUp.value?.uuid };
                    }
                    if (hasFollowUpResult) {
                        yield* foreignResults;
                        expect(order.at(-1)).toBe('follow-up');
                        followUpResult = { ...result, session_id: resultId, user_message_uuid: legacyFollowUp ? undefined : followUp.value?.uuid };
                        yield followUpResult;
                    }
                    if (hasLaterFollowUp) {
                        const laterFollowUp = await input.next();
                        expect(laterFollowUp.value?.message.content).toBe('later follow-up');
                        yield { type: 'system', subtype: 'init', session_id: priorId };
                        yield autonomousResult;
                        expect(order.at(-1)).toBe('later follow-up');
                        laterFollowUpResult = { ...result, session_id: resultId, user_message_uuid: laterFollowUp.value?.uuid };
                        yield laterFollowUpResult;
                    }
                }
            }
        }));

        const inputs = ['first', '/clear', ...(interveningCompact ? ['/compact'] : []),
            ...(idleBackgroundOutput ? [] : ['follow-up']),
            ...(hasLaterFollowUp ? ['later follow-up'] : [])];
        if (timesOut) vi.useFakeTimers();
        try {
            const execution = claudeRemote({
                sessionId: priorId,
                path: process.cwd(),
                allowedTools: [],
                hookSettingsPath: '/tmp/hook.json',
                canCallTool: async () => ({ behavior: 'allow', updatedInput: {} }),
                nextMessage: async (correlatesResults, signal) => {
                    const message = inputs.shift();
                    if (message === '/clear') expect(correlatesResults).toBe(true);
                    if (message && message !== 'first') order.push(message);
                    if (message === 'follow-up' && outcome === 'result-eof') {
                        signal?.addEventListener('abort', () => finishFollowUp.resolve(undefined), { once: true });
                        dequeuedFollowUp.resolve(undefined);
                        await finishFollowUp.promise;
                    }
                    return message ? { message, mode: { permissionMode: 'default' } } : null;
                },
                onInputUndelivered: () => { inputs.unshift('follow-up'); },
                onReady: (event, _summary, contextTokens) => {
                    if (event === 'Context was reset') clearContextTokens.push(contextTokens);
                    order.push(event ?? 'ready');
                },
                onResultAccepted: (keepClearHookPending) => {
                    awaitingLateClearHook = keepClearHookPending === true;
                    order.push('accepted');
                },
                isAborted: () => false,
                onSessionFound: (id) => { order.push(`session:${id}`); },
                onThinkingChange: (value) => { thinking.push(value); },
                onMessage: (message) => { forwarded.push(message); },
                onCompletionEvent: outcome === 'acknowledged' || lateRotation ? (event) => { order.push(event); } : undefined,
                getClearHookSessionId: () => hookSessionId,
                onSessionReset: () => order.push('reset')
            });
            if (outcome === 'no-result' || outcome === 'autonomous-eof') {
                await expect(execution).rejects.toThrow('Claude exited before acknowledging /clear');
                expect(order).toEqual([`session:${priorId}`, 'ready', '/clear']);
                return;
            }
            await execution;
            if (outcome === 'eof') {
                expect(order).toEqual([`session:${priorId}`, 'ready', '/clear', 'accepted', 'reset', `session:${resultId}`, 'Context was reset']);
            } else if (outcome === 'acknowledged') {
                expect(order).toEqual([`session:${priorId}`, 'ready', '/clear', 'accepted', 'Claude did not identify the /clear result']);
            } else if (lateRotation) {
                expect(order).toContain('Context was reset');
                expect(order).toEqual([
                    `session:${priorId}`, 'ready', '/clear', 'accepted', timeoutNotice,
                    'accepted', 'reset', `session:${resultId}`, 'Context was reset'
                ]);
                expect(inputs).toEqual(['follow-up']);
            } else if (timesOut) {
                expect(order).toEqual([`session:${priorId}`, 'ready', '/clear', 'accepted', completion]);
            } else if (idleBackgroundOutput) {
                expect(order).toEqual([`session:${priorId}`, 'ready', '/clear', 'accepted', 'reset', `session:${resultId}`, 'Context was reset']);
                expect(forwarded).toContainEqual(expect.objectContaining({ type: 'assistant', session_id: priorId }));
            } else {
                expect(order).toEqual(success
                    ? [`session:${priorId}`, 'ready', '/clear', 'accepted', 'reset', `session:${resultId}`, 'Context was reset',
                        ...(interveningCompact ? ['/compact', 'accepted', '📦 Compacted'] : []),
                        'follow-up', ...(hasFollowUpResult ? ['ready'] : []),
                        ...(hasLaterFollowUp ? ['later follow-up', 'ready'] : [])]
                    : [`session:${priorId}`, 'ready', '/clear', 'accepted', completion, 'follow-up']);
            }
            expect(clearContextTokens).toEqual(success || lateRotation ? [0] : []);
            if (outcome === 'result-eof' || outcome === 'unacknowledged-input-eof' || outcome === 'failed-clear-input-eof') {
                expect(inputs).toEqual(['follow-up']);
            }
            if (outcome === 'acknowledged-input-eof') expect(inputs).toEqual([]);
            const forwardedResults = forwarded.filter((message) => message.type === 'result');
            const expectedResults = [firstResult, result];
            if (timesOut && outcome !== 'silent-timeout') expectedResults.push(unmatchedResult);
            if (compactResult) expectedResults.push({ ...compactResult, hapi_compact_turn: true });
            if (followUpResult) expectedResults.push(...(legacyFollowUp ? [] : foreignResults), followUpResult);
            if (laterFollowUpResult) expectedResults.push(laterFollowUpResult);
            expect(forwardedResults).toEqual(expectedResults);
        } finally {
            finishFollowUp.resolve(undefined);
            if (timesOut) vi.useRealTimers();
            queryMock.mockReset();
            querySpy.mockRestore();
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
    let lastCompactSummary: { summary: string; tokensBefore?: number; tokensAfter?: number } | undefined;
    async function runCompact(sdkMessages: SDKMessage[]): Promise<string[]> {
        const querySpy = vi.spyOn(claudeSdk, 'query').mockImplementation(queryMock as typeof claudeSdk.query);
        const { claudeRemote } = await import('./claudeRemote');
        const completionEvents: string[] = [];
        lastCompactSummary = undefined;
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
                onReady: (completionEvent, compactSummary) => {
                    lastCompactSummary = compactSummary;
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

    it('settles an identified compact failure without a preceding status', async () => {
        const completionEvents = await runCompact([{
            ...resultMessage,
            local_command: 'compact',
            result: 'Not enough messages to compact.'
        }]);

        expect(completionEvents).toEqual([
            '📦 Compaction started',
            '📦 Compaction failed: Not enough messages to compact.'
        ]);
    });

    it('does not settle a manual compact on an autonomous result after an auto compact', async () => {
        await runCompact([
            { type: 'system', subtype: 'status', status: 'compacting' },
            {
                type: 'system',
                subtype: 'compact_boundary',
                compact_metadata: { trigger: 'auto' },
            },
            { ...resultMessage, user_message_uuid: 'autonomous-input' },
            {
                type: 'system',
                subtype: 'compact_boundary',
                compact_metadata: { trigger: 'manual', pre_tokens: 100, post_tokens: 10 },
            },
            { ...resultMessage, local_command: 'compact' }
        ]);

        expect(lastCompactSummary).toEqual({ summary: '', tokensBefore: 100, tokensAfter: 10 });
        const [autonomousResult, compactResult] = lastForwarded.filter((message) => message.type === 'result');
        expect(autonomousResult).not.toHaveProperty('hapi_compact_turn');
        expect(compactResult).toHaveProperty('hapi_compact_turn', true);
    });

    it.each([
        { identity: 'uuid', next: 'follow-up' },
        { identity: 'name', next: 'follow-up' },
        { identity: 'untagged', next: 'follow-up' },
        { identity: 'absent', next: '/compact' }
    ])('recovers from an unidentified compact with $identity and next $next', async ({ identity, next }) => {
        vi.useFakeTimers();
        const querySpy = vi.spyOn(claudeSdk, 'query').mockImplementation(queryMock as typeof claudeSdk.query);
        const { claudeRemote } = await import('./claudeRemote');
        const events: string[] = [];
        const timeoutNotice = '📦 Claude did not identify the /compact result. Waiting for Claude to exit so background tasks can finish.';
        let accepted = 0;
        queryMock.mockImplementationOnce(({ prompt }: { prompt: AsyncIterable<{ uuid: string; message: { content: string } }> }) => ({
            async *[Symbol.asyncIterator]() {
                const input = prompt[Symbol.asyncIterator]();
                const first = await input.next();
                yield { ...resultMessage, user_message_uuid: first.value?.uuid };
                const compact = await input.next();
                expect(compact.value?.message.content).toBe('/compact');
                yield { type: 'system', subtype: 'status', status: 'compacting' };
                yield resultMessage;
                expect(events).toEqual(['ready']);
                await vi.advanceTimersByTimeAsync(5 * 60_000 + 1);
                expect(events).toEqual(['ready', timeoutNotice]);
                expect((await input.next()).done).toBe(true);
                if (identity !== 'absent') {
                    yield {
                        ...resultMessage,
                        local_command: identity === 'name' ? 'compact' : undefined,
                        user_message_uuid: identity === 'uuid' ? compact.value?.uuid : undefined
                    };
                }
                expect(events).toEqual(['ready', timeoutNotice]);
                expect(accepted).toBe(1);
            }
        }));
        const inputs = ['first', '/compact', next];
        try {
            const options: Parameters<typeof claudeRemote>[0] = {
                sessionId: 'session-1',
                path: process.cwd(),
                allowedTools: [],
                hookSettingsPath: '/tmp/hook.json',
                canCallTool: async () => ({ behavior: 'allow', updatedInput: {} }),
                nextMessage: async (correlatesResults) => {
                    const message = inputs.shift();
                    if (message === '/compact' && accepted === 0) expect(correlatesResults).toBe(true);
                    return message ? { message, mode: { permissionMode: 'default' } } : null;
                },
                onReady: (event) => { events.push(event ?? 'ready'); },
                onResultAccepted: () => { accepted += 1; },
                isAborted: () => false,
                onSessionFound: () => {},
                onMessage: () => {}
            };
            await claudeRemote(options);
            expect(inputs).toEqual([next]);
            queryMock.mockReturnValueOnce(createAsyncStream(next === '/compact'
                ? [{ type: 'system', subtype: 'status', status: 'compacting' }, { ...resultMessage, local_command: 'compact' }]
                : [resultMessage]));
            await claudeRemote(options);
            expect(events).toEqual(['ready', timeoutNotice, next === '/compact' ? '📦 Compacted' : 'ready']);
        } finally {
            vi.useRealTimers();
            queryMock.mockReset();
            querySpy.mockRestore();
        }
    });

    it.each(['none', 'before-progress', 'after-boundary', 'auto-compaction', 'auto-compaction-timeout'])('settles a live compact only on its result with autonomous output %s', async (autonomous) => {
        const querySpy = vi.spyOn(claudeSdk, 'query').mockImplementation(queryMock as typeof claudeSdk.query);
        const { claudeRemote } = await import('./claudeRemote');
        const events: string[] = [];
        const timeoutNotice = '📦 Claude did not identify the /compact result. Waiting for Claude to exit so background tasks can finish.';
        queryMock.mockImplementationOnce(({ prompt }: { prompt: AsyncIterable<{ uuid: string }> }) => ({
            async *[Symbol.asyncIterator]() {
                const input = prompt[Symbol.asyncIterator]();
                const first = await input.next();
                yield { ...resultMessage, user_message_uuid: first.value?.uuid };
                const compact = await input.next();
                if (autonomous === 'auto-compaction-timeout') await vi.advanceTimersByTimeAsync(10_000);
                if (autonomous === 'before-progress') yield resultMessage;
                yield { type: 'system', subtype: 'status', status: 'compacting' };
                if (autonomous === 'before-progress') {
                    await vi.advanceTimersByTimeAsync(31_000);
                    expect(events).toEqual(['ready']);
                }
                if (autonomous === 'after-boundary') {
                    yield { type: 'system', subtype: 'compact_boundary', compact_metadata: { trigger: 'manual' } };
                    yield { ...resultMessage, is_error: true, subtype: 'error_during_execution' };
                    await vi.advanceTimersByTimeAsync(1);
                    expect(events).toEqual(['ready']);
                }
                if (autonomous === 'auto-compaction-timeout') {
                    await vi.advanceTimersByTimeAsync(10_000);
                    yield { type: 'system', subtype: 'compact_boundary', compact_metadata: { trigger: 'auto' } };
                    await vi.advanceTimersByTimeAsync(10_001);
                    expect(events).toEqual(['ready', timeoutNotice]);
                    expect((await input.next()).done).toBe(true);
                } else if (autonomous === 'auto-compaction') {
                    yield { type: 'system', subtype: 'compact_boundary', compact_metadata: { trigger: 'auto' } };
                    yield { ...resultMessage, user_message_uuid: compact.value?.uuid, result: 'Not enough messages to compact.' };
                } else {
                    yield { ...resultMessage, user_message_uuid: compact.value?.uuid };
                }
            }
        }));
        const inputs = ['first', '/compact'];
        if (autonomous !== 'none') vi.useFakeTimers();
        try {
            await claudeRemote({
                sessionId: 'session-1',
                path: process.cwd(),
                allowedTools: [],
                hookSettingsPath: '/tmp/hook.json',
                canCallTool: async () => ({ behavior: 'allow', updatedInput: {} }),
                nextMessage: async () => {
                    const message = inputs.shift();
                    return message ? { message, mode: { permissionMode: 'default' } } : null;
                },
                onReady: (event) => { events.push(event ?? 'ready'); },
                isAborted: () => false,
                onSessionFound: () => {},
                onMessage: () => {}
            });
            const outcome = autonomous === 'auto-compaction-timeout' ? timeoutNotice
                : autonomous === 'auto-compaction' ? '📦 Compaction failed: Not enough messages to compact.' : '📦 Compacted';
            expect(events).toEqual(['ready', outcome]);
        } finally {
            if (autonomous !== 'none') vi.useRealTimers();
            queryMock.mockReset();
            querySpy.mockRestore();
        }
    });

    it.each([false, true])('uses compact input acknowledgment on EOF with provisional progress: %s', async (acknowledged) => {
        const querySpy = vi.spyOn(claudeSdk, 'query').mockImplementation(queryMock as typeof claudeSdk.query);
        const { claudeRemote } = await import('./claudeRemote');
        queryMock.mockImplementationOnce(({ prompt }: { prompt: AsyncIterable<{ uuid: string }> }) => ({
            async *[Symbol.asyncIterator]() {
                const input = prompt[Symbol.asyncIterator]();
                const first = await input.next();
                yield { ...resultMessage, user_message_uuid: first.value?.uuid };
                const compact = await input.next();
                yield { type: 'system', subtype: 'status', status: 'compacting' };
                if (acknowledged) yield { type: 'user', uuid: compact.value?.uuid, isReplay: true };
            }
        }));
        const inputs = ['first', '/compact'];
        const onResultAccepted = vi.fn();
        try {
            const execution = claudeRemote({
                sessionId: 'session-1',
                path: process.cwd(),
                allowedTools: [],
                hookSettingsPath: '/tmp/hook.json',
                canCallTool: async () => ({ behavior: 'allow', updatedInput: {} }),
                nextMessage: async () => {
                    const message = inputs.shift();
                    return message ? { message, mode: { permissionMode: 'default' } } : null;
                },
                onReady: () => {},
                onResultAccepted,
                isAborted: () => false,
                onSessionFound: () => {},
                onMessage: () => {}
            });
            if (acknowledged) {
                await execution;
                expect(onResultAccepted).toHaveBeenCalledTimes(1);
            } else {
                await expect(execution).rejects.toThrow('Claude exited before acknowledging /compact');
                expect(onResultAccepted).not.toHaveBeenCalled();
            }
        } finally {
            queryMock.mockReset();
            querySpy.mockRestore();
        }
    });

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

        expect(completionEvents).toEqual(['📦 Compaction started']);
        expect(lastCompactSummary).toEqual({ summary: '', tokensBefore: 34492, tokensAfter: 2082 });
    }, 15_000);

    it('marks the compact turn result so the converter skips its tok/s fields', async () => {
        await runCompact([
            {
                type: 'system',
                subtype: 'status',
                status: 'compacting',
                session_id: 's-1',
                uuid: 'u-1'
            } as unknown as SDKMessage,
            resultMessage
        ]);

        const forwardedResult = lastForwarded.find((message) => message.type === 'result');
        expect(forwardedResult).toBeTruthy();
        // The compaction call is not an assistant round: no tok/s from it.
        expect(forwardedResult).toHaveProperty('hapi_compact_turn', true);
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

        expect(completionEvents).toEqual(['📦 Compaction started']);
        expect(lastCompactSummary).toEqual({ summary: '', tokensBefore: 100, tokensAfter: 10 });
        const forwardedResults = lastForwarded.filter((message) => message.type === 'result');
        expect(forwardedResults).toHaveLength(2);
        // The autonomous round that completed before the compaction signal is
        // a real assistant round: its result must stay unmarked so the
        // converter keeps its tok/s fields.
        expect(forwardedResults[0]).not.toHaveProperty('hapi_compact_turn');
        // Only the actual compact turn result is marked.
        expect(forwardedResults[1]).toHaveProperty('hapi_compact_turn', true);
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

    it('does not relay a compact stdout echo carrying hook output during a manual /compact', async () => {
        // PostCompact hooks append their stdout to the same echo
        // (production: `Compacted PostCompact [script]`), so the echo starts
        // with the compact result but is no longer the bare token.
        const hookEcho = '<local-command-stdout>Compacted PostCompact [if [ -z "${HOME-}" ]; then case "${OSTYPE-}" in msys*) printf \'{}\\n\' ;; esac; fi</local-command-stdout>';
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
                message: { role: 'user', content: hookEcho }
            } as unknown as SDKMessage,
            resultMessage
        ]);

        expect(
            lastForwarded.some((m) =>
                m.type === 'user' &&
                (m as { message?: { content?: unknown } }).message?.content === hookEcho
            )
        ).toBe(false);
    }, 15_000);

    it('keeps non-compact stdout output visible during a manual /compact', async () => {
        // Only the compact's own echo (opening with "Compacted") is
        // bookkeeping; other command output in the same turn stays visible.
        const other = '<local-command-stdout>context window usage</local-command-stdout>';
        await runCompact([
            {
                type: 'user',
                message: { role: 'user', content: other }
            } as unknown as SDKMessage,
            resultMessage
        ]);

        expect(
            lastForwarded.some((m) =>
                m.type === 'user' &&
                (m as { message?: { content?: unknown } }).message?.content === other
            )
        ).toBe(true);
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
        queryMock.mockImplementationOnce(({ prompt }: { prompt: AsyncIterable<{ uuid: string }> }) => ({
            async *[Symbol.asyncIterator]() {
                const promptIterator = prompt[Symbol.asyncIterator]();
                const first = await promptIterator.next();
                yield { ...resultMessage, user_message_uuid: first.value?.uuid };
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
                yield { ...resultMessage, local_command: 'compact' };
            }
        }));

        let nextCallCount = 0;
        try {
            await claudeRemote({
                sessionId: 'session-1', path: process.cwd(), mcpServers: {}, claudeEnvVars: {},
                claudeArgs: [], allowedTools: [], hookSettingsPath: '/tmp/hook.json',
                canCallTool: async () => ({ behavior: 'allow', updatedInput: {} }),
                nextMessage: async (correlatesResults) => {
                    nextCallCount += 1;
                    if (nextCallCount === 1) return { message: 'hi', mode: { permissionMode: 'default' } };
                    if (nextCallCount === 2) {
                        expect(correlatesResults).toBe(true);
                        return { message: '/compact', mode: { permissionMode: 'default' } };
                    }
                    return null;
                },
                onReady: (completionEvent, compactSummary) => {
                    if (completionEvent) completionEvents.push(completionEvent);
                    if (compactSummary) completionEvents.push('structured compact');
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
        expect(completionEvents).toContain('structured compact');
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
            onResultAccepted: () => {
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
        expect(readyEvents).toEqual([undefined]);
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

        expect(readyEvents).toEqual([undefined]);
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

    it('preserves exact token facts for a static header when the transcript has no summary', async () => {
        const { completionEvents, compactSummaries, contextTokens } = await runCompactWithSummary(null);

        expect(compactSummaries).toEqual([{ summary: '', tokensBefore: 34492, tokensAfter: 2082 }]);
        expect(contextTokens).toEqual([2082]);
        expect(completionEvents).toEqual(['📦 Compaction started']);
    }, 15_000);
});

describe('claudeRemote native permission mode', () => {
    // A process launched natively in acceptEdits/bypassPermissions never calls
    // canCallTool, so switching the session back to Default mid-session would
    // silently keep auto-approving tools.
    it.each([
        ['default', 'default'],
        ['acceptEdits', 'default'],
        ['bypassPermissions', 'default'],
        ['plan', 'plan'],
        ['auto', 'auto'],
    ] as const)('launches Claude for %s with --permission-mode %s', async (sessionMode, nativeMode) => {
        const querySpy = vi.spyOn(claudeSdk, 'query').mockImplementation(queryMock as typeof claudeSdk.query);
        const { claudeRemote } = await import('./claudeRemote');
        queryMock.mockReturnValueOnce(createAsyncStream([
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
                    ? { message: 'A', mode: { permissionMode: sessionMode } }
                    : null,
                onReady: () => {},
                isAborted: () => false,
                onSessionFound: () => {},
                onMessage: () => {}
            });

            expect(queryMock.mock.calls[0][0].options.permissionMode).toBe(nativeMode);
        } finally {
            queryMock.mockReset();
            querySpy.mockRestore();
        }
    });
});

describe('claudeRemote live permission mode', () => {
    it('forwards native mode changes to the running process', async () => {
        const querySpy = vi.spyOn(claudeSdk, 'query').mockImplementation(queryMock as typeof claudeSdk.query);
        const { claudeRemote } = await import('./claudeRemote');
        const setPermissionMode = vi.fn(async () => {});
        let listener: ((mode: 'default' | 'auto' | 'acceptEdits' | 'bypassPermissions') => void) | null = null;
        const setPermissionModeListener = vi.fn((next: typeof listener) => {
            listener = next;
        });

        queryMock.mockReturnValueOnce({
            setPermissionMode,
            async *[Symbol.asyncIterator]() {
                listener?.('auto');
                listener?.('auto');
                listener?.('bypassPermissions');
                listener?.('acceptEdits');
                yield { type: 'result', subtype: 'success' } as unknown as SDKMessage;
            }
        });

        let nextCallCount = 0;
        try {
            await claudeRemote({
                sessionId: 'session-1',
                path: process.cwd(),
                allowedTools: [],
                hookSettingsPath: '/tmp/hook.json',
                canCallTool: async () => ({ behavior: 'allow', updatedInput: {} }),
                setPermissionModeListener,
                nextMessage: async () => nextCallCount++ === 0
                    ? { message: 'A', mode: { permissionMode: 'default' } }
                    : null,
                onReady: () => {},
                isAborted: () => false,
                onSessionFound: () => {},
                onMessage: () => {}
            });

            expect(setPermissionMode.mock.calls).toEqual([['auto'], ['default']]);
            expect(setPermissionModeListener).toHaveBeenLastCalledWith(null);
        } finally {
            queryMock.mockReset();
            querySpy.mockRestore();
        }
    });
});

describe('claudeRemote rejected permission mode', () => {
    async function run(stream: (listener: (mode: 'default' | 'auto' | 'bypassPermissions') => void) => SDKMessage[], startMode: 'default' | 'auto', setPermissionMode: (mode: string) => Promise<void>) {
        const querySpy = vi.spyOn(claudeSdk, 'query').mockImplementation(queryMock as typeof claudeSdk.query);
        const { claudeRemote } = await import('./claudeRemote');
        let listener: ((mode: 'default' | 'auto' | 'bypassPermissions') => void) | null = null;
        const onPermissionModeRejected = vi.fn();
        queryMock.mockReturnValueOnce({
            setPermissionMode,
            async *[Symbol.asyncIterator]() {
                for (const message of stream((mode) => listener?.(mode))) {
                    await new Promise((resolve) => setTimeout(resolve, 0));
                    yield message;
                }
            }
        });
        let nextCallCount = 0;
        try {
            await claudeRemote({
                sessionId: null,
                path: process.cwd(),
                allowedTools: [],
                hookSettingsPath: '/tmp/hook.json',
                canCallTool: async () => ({ behavior: 'allow', updatedInput: {} }),
                setPermissionModeListener: (next) => { listener = next; },
                onPermissionModeRejected,
                nextMessage: async () => nextCallCount++ === 0
                    ? { message: 'A', mode: { permissionMode: startMode } }
                    : null,
                onReady: () => {},
                isAborted: () => false,
                onSessionFound: () => {},
                onMessage: () => {}
            });
        } finally {
            queryMock.mockReset();
            querySpy.mockRestore();
        }
        return onPermissionModeRejected;
    }

    it('reverts to the previous mode when Claude refuses a live switch', async () => {
        const rejected = await run((set) => {
            set('bypassPermissions');
            set('auto');
            return [{ type: 'result', subtype: 'success' } as unknown as SDKMessage];
        }, 'default', async () => {
            throw new Error('Cannot set permission mode to auto: auto mode disabled by settings');
        });
        expect(rejected.mock.calls).toEqual([['bypassPermissions', 'Cannot set permission mode to auto: auto mode disabled by settings']]);
    });

    it('ignores a rejection superseded by a later switch back to the same mode', async () => {
        const rejected = await run((set) => {
            set('auto');
            set('bypassPermissions');
            set('auto');
            return [{ type: 'result', subtype: 'success' } as unknown as SDKMessage];
        }, 'default', async (mode) => {
            if (mode === 'auto') {
                throw new Error('auto unavailable');
            }
        });
        expect(rejected.mock.calls).toEqual([['bypassPermissions', 'auto unavailable']]);
    });

    it('reports when Claude starts in default instead of auto', async () => {
        const rejected = await run(() => [
            { type: 'system', subtype: 'init', permissionMode: 'default' } as unknown as SDKMessage,
            { type: 'result', subtype: 'success' } as unknown as SDKMessage
        ], 'auto', async () => {});
        expect(rejected).toHaveBeenCalledWith('default', expect.stringContaining('auto'));
    });
});

describe('claudeRemote live effort', () => {
    async function run(
        setEffort: (effort: string | null) => Promise<void>,
        exercise: (apply: (effort: string | null) => Promise<boolean>) => Promise<void>
    ) {
        const querySpy = vi.spyOn(claudeSdk, 'query').mockImplementation(queryMock as typeof claudeSdk.query);
        const { claudeRemote } = await import('./claudeRemote');
        let applier: ((effort: string | null) => Promise<boolean>) | null = null;
        const setEffortApplier = vi.fn((next: typeof applier) => {
            applier = next;
        });
        queryMock.mockReturnValueOnce({
            setPermissionMode: async () => {},
            setEffort,
            async *[Symbol.asyncIterator]() {
                await exercise((effort) => applier!(effort));
                yield { type: 'result', subtype: 'success' } as unknown as SDKMessage;
            }
        });
        let nextCallCount = 0;
        try {
            await claudeRemote({
                sessionId: 'session-1',
                path: process.cwd(),
                allowedTools: [],
                hookSettingsPath: '/tmp/hook.json',
                canCallTool: async () => ({ behavior: 'allow', updatedInput: {} }),
                setEffortApplier,
                nextMessage: async () => nextCallCount++ === 0
                    ? { message: 'A', mode: { permissionMode: 'default', effort: 'high' } }
                    : null,
                onReady: () => {},
                isAborted: () => false,
                onSessionFound: () => {},
                onMessage: () => {}
            });
        } finally {
            queryMock.mockReset();
            querySpy.mockRestore();
        }
        expect(setEffortApplier).toHaveBeenLastCalledWith(null);
    }

    it('changes effort in the running process and skips unchanged levels', async () => {
        const setEffort = vi.fn(async () => {});
        const results: boolean[] = [];
        await run(setEffort, async (apply) => {
            results.push(await apply('high'));
            results.push(await apply('low'));
            results.push(await apply('low'));
            results.push(await apply(null));
        });
        expect(setEffort.mock.calls).toEqual([['low'], [null]]);
        expect(results).toEqual([true, true, true, true]);
    });

    it('asks for a restart when Claude rejects or never answers the change', async () => {
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
        try {
            const results: boolean[] = [];
            await run(async (effort) => {
                if (effort === 'low') throw new Error('Unsupported control request subtype: apply_flag_settings');
                await new Promise(() => {});
            }, async (apply) => {
                results.push(await apply('low'));
                const pending = apply('max');
                await vi.advanceTimersByTimeAsync(5_000);
                results.push(await pending);
            });
            expect(results).toEqual([false, false]);
        } finally {
            vi.useRealTimers();
        }
    });
});
