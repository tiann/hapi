import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { appendFile, mkdir, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const harness = {
    launches: [] as Array<Record<string, unknown>>,
    sessionHookHandlers: [] as Array<(sessionId: string, data: Record<string, unknown>) => void>,
    runBarrier: null as Promise<void> | null
};

vi.mock('./codexLocal', () => ({
    codexLocal: async (opts: Record<string, unknown>) => {
        harness.launches.push(opts);
    }
}));

vi.mock('./utils/buildHapiMcpBridge', () => ({
    buildHapiMcpBridge: async () => ({
        server: {
            url: 'http://localhost:0',
            stop: () => {}
        },
        mcpServers: {}
    })
}));

vi.mock('@/claude/utils/startHookServer', () => ({
    startHookServer: async (opts: { onSessionHook: (sessionId: string, data: Record<string, unknown>) => void }) => {
        harness.sessionHookHandlers.push(opts.onSessionHook);
        return {
            port: 4242,
            token: 'hook-token',
            stop: () => {}
        };
    }
}));

vi.mock('@/modules/common/launcher/BaseLocalLauncher', () => ({
    BaseLocalLauncher: class {
        readonly control = {
            requestExit: () => {}
        };

        constructor(private readonly opts: { launch: (signal: AbortSignal) => Promise<void> }) {}

        async run(): Promise<'exit'> {
            await this.opts.launch(new AbortController().signal);
            if (harness.runBarrier) {
                await harness.runBarrier;
            }
            return 'exit';
        }
    }
}));

import { codexLocalLauncher } from './codexLocalLauncher';

function createQueueStub() {
    return {
        size: () => 0,
        reset: () => {},
        setOnMessage: () => {}
    };
}

function createSessionStub(
    permissionMode: 'default' | 'read-only' | 'safe-yolo' | 'yolo',
    codexArgs?: string[],
    path = '/tmp/worktree',
    initialTranscriptPath: string | null = null,
    replayTranscriptHistoryOnStart = false,
    pendingClient = false
) {
    const sessionEvents: Array<{ type: string; message?: string }> = [];
    const userMessages: string[] = [];
    const agentMessages: unknown[] = [];
    let userActivityCount = 0;
    let localLaunchFailure: { message: string; exitReason: 'switch' | 'exit' } | null = null;
    let sessionId: string | null = null;
    let transcriptPath: string | null = initialTranscriptPath;
    const transcriptPathCallbacks: Array<(path: string) => void> = [];

    return {
        session: {
            get sessionId() {
                return sessionId;
            },
            get transcriptPath() {
                return transcriptPath;
            },
            path,
            startedBy: 'terminal' as const,
            startingMode: 'local' as const,
            codexArgs,
            replayTranscriptHistoryOnStart,
            client: {
                isPending: () => pendingClient,
                rpcHandlerManager: {
                    registerHandler: () => {}
                }
            },
            getPermissionMode: () => permissionMode,
            getModelReasoningEffort: () => null,
            onSessionFound: (value: string) => {
                sessionId = value;
            },
            onTranscriptPathFound: (pathValue: string) => {
                transcriptPath = pathValue;
                for (const callback of transcriptPathCallbacks) {
                    callback(pathValue);
                }
            },
            addTranscriptPathCallback: (callback: (path: string) => void) => {
                transcriptPathCallbacks.push(callback);
            },
            removeTranscriptPathCallback: (callback: (path: string) => void) => {
                const index = transcriptPathCallbacks.indexOf(callback);
                if (index !== -1) {
                    transcriptPathCallbacks.splice(index, 1);
                }
            },
            resetTranscriptPath: () => {
                transcriptPath = null;
            },
            sendSessionEvent: (event: { type: string; message?: string }) => {
                sessionEvents.push(event);
            },
            recordLocalLaunchFailure: (message: string, exitReason: 'switch' | 'exit') => {
                localLaunchFailure = { message, exitReason };
            },
            sendUserMessage: (message: string) => {
                userMessages.push(message);
            },
            notifyUserActivity: () => {
                userActivityCount += 1;
            },
            sendAgentMessage: (message: unknown) => {
                agentMessages.push(message);
            },
            queue: createQueueStub()
        },
        sessionEvents,
        userMessages,
        agentMessages,
        getUserActivityCount: () => userActivityCount,
        getLocalLaunchFailure: () => localLaunchFailure
    };
}

describe('codexLocalLauncher', () => {
    let tempDir = '';

    const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
    const writeTranscriptMeta = async (fileName: string, sessionId: string): Promise<string> => {
        const transcriptPath = join(tempDir, fileName);
        await writeFile(
            transcriptPath,
            JSON.stringify({
                type: 'session_meta',
                payload: {
                    id: sessionId
                }
            }) + '\n'
        );
        return transcriptPath;
    };

    beforeEach(async () => {
        tempDir = join(tmpdir(), `codex-local-launcher-${Date.now()}`);
        await mkdir(tempDir, { recursive: true });
    });

    afterEach(() => {
        vi.useRealTimers();
        harness.launches = [];
        harness.sessionHookHandlers = [];
        harness.runBarrier = null;
    });

    afterEach(async () => {
        if (existsSync(tempDir)) {
            await rm(tempDir, { recursive: true, force: true });
        }
    });

    it('rebuilds approval and sandbox args from yolo mode', async () => {
        const { session } = createSessionStub('yolo', [
            '--sandbox',
            'read-only',
            '--ask-for-approval',
            'untrusted',
            '--model',
            'o3',
            '--full-auto'
        ]);

        await codexLocalLauncher(session as never);

        expect(harness.launches).toHaveLength(1);
        expect(harness.launches[0]?.codexArgs).toEqual([
            '--ask-for-approval',
            'never',
            '--sandbox',
            'danger-full-access',
            '--model',
            'o3'
        ]);
    });

    it('preserves raw Codex approval flags in default mode', async () => {
        const { session } = createSessionStub('default', [
            '--ask-for-approval',
            'on-request',
            '--sandbox',
            'workspace-write',
            '--model',
            'o3'
        ]);

        await codexLocalLauncher(session as never);

        expect(harness.launches).toHaveLength(1);
        expect(harness.launches[0]?.codexArgs).toEqual([
            '--ask-for-approval',
            'on-request',
            '--sandbox',
            'workspace-write',
            '--model',
            'o3'
        ]);
    });

    it('keeps sandbox escalation available in safe-yolo mode', async () => {
        const { session } = createSessionStub('safe-yolo', [
            '--ask-for-approval',
            'never',
            '--sandbox',
            'danger-full-access',
            '--model',
            'o3'
        ]);

        await codexLocalLauncher(session as never);

        expect(harness.launches).toHaveLength(1);
        expect(harness.launches[0]?.codexArgs).toEqual([
            '--ask-for-approval',
            'on-request',
            '--sandbox',
            'workspace-write',
            '--model',
            'o3'
        ]);
    });

    it('does not emit a session warning while waiting for the first transcript path', async () => {
        const { session, sessionEvents, getLocalLaunchFailure } = createSessionStub('default', undefined, 'c:\\workspace\\project');
        let releaseRunBarrier: (() => void) | undefined;
        harness.runBarrier = new Promise((resolve) => {
            releaseRunBarrier = resolve;
        });

        vi.useFakeTimers();
        const launcherPromise = codexLocalLauncher(session as never);
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();
        vi.advanceTimersByTime(10_000);
        await Promise.resolve();
        expect(sessionEvents).toEqual([]);

        if (releaseRunBarrier) {
            releaseRunBarrier();
        }
        await launcherPromise;

        expect(harness.launches.length).toBeGreaterThan(0);
        expect(getLocalLaunchFailure()).toBeNull();
        expect(sessionEvents).toEqual([]);
    });

    it('does not reuse a stale transcript path from a previous launch', async () => {
        const staleTranscriptPath = join(tempDir, 'stale-transcript.jsonl');
        const { session, sessionEvents } = createSessionStub('default', undefined, '/tmp/worktree', staleTranscriptPath);
        let releaseRunBarrier: (() => void) | undefined;
        harness.runBarrier = new Promise((resolve) => {
            releaseRunBarrier = resolve;
        });

        vi.useFakeTimers();
        const launcherPromise = codexLocalLauncher(session as never);
        await Promise.resolve();
        await Promise.resolve();
        expect(session.transcriptPath).toBeNull();

        vi.advanceTimersByTime(10_000);
        await Promise.resolve();
        expect(sessionEvents).toEqual([]);

        if (releaseRunBarrier) {
            releaseRunBarrier();
        }
        await launcherPromise;

        expect(sessionEvents).toEqual([]);
    });

    it('passes SessionStart hook config into local Codex launch', async () => {
        const { session } = createSessionStub('default');

        await codexLocalLauncher(session as never);

        expect(harness.launches).toHaveLength(1);
        expect(harness.launches[0]?.sessionHook).toEqual({
            port: 4242,
            token: 'hook-token'
        });
    });

    it('creates scanner only after transcript path arrives from SessionStart hook', async () => {
        const transcriptPath = join(tempDir, 'codex-transcript.jsonl');
        const { session, agentMessages } = createSessionStub('default');
        let releaseRunBarrier: (() => void) | undefined;
        harness.runBarrier = new Promise((resolve) => {
            releaseRunBarrier = resolve;
        });

        await writeFile(
            transcriptPath,
            JSON.stringify({ type: 'session_meta', payload: { id: 'codex-thread-1' } }) + '\n'
        );

        const launcherPromise = codexLocalLauncher(session as never);
        await wait(50);
        expect(session.transcriptPath).toBeNull();
        expect(agentMessages).toHaveLength(0);

        harness.sessionHookHandlers[0]?.('codex-thread-1', {
            transcript_path: transcriptPath
        });
        await wait(100);

        await appendFile(
            transcriptPath,
            JSON.stringify({ type: 'event_msg', payload: { type: 'agent_message', message: 'hello from transcript' } }) + '\n'
        );

        await wait(700);
        if (releaseRunBarrier) {
            releaseRunBarrier();
        }
        await launcherPromise;

        expect(session.transcriptPath).toBe(transcriptPath);
        expect(agentMessages).toContainEqual({
            type: 'message',
            message: 'hello from transcript',
            id: expect.any(String)
        });
    });

    it('falls back to fresh transcript activity when SessionStart does not arrive', async () => {
        const originalCodexHome = process.env.CODEX_HOME;
        process.env.CODEX_HOME = tempDir;
        const now = new Date();
        const sessionDirectory = join(
            tempDir,
            'sessions',
            String(now.getUTCFullYear()),
            String(now.getUTCMonth() + 1).padStart(2, '0'),
            String(now.getUTCDate()).padStart(2, '0')
        );
        await mkdir(sessionDirectory, { recursive: true });
        const transcriptPath = join(sessionDirectory, 'rollout-fallback-thread.jsonl');
        const { session, userMessages } = createSessionStub(
            'default',
            ['--cd', '/tmp/effective-codex-cwd'],
            '/tmp/worktree',
            null,
            true,
            true
        );
        let releaseRunBarrier: (() => void) | undefined;
        harness.runBarrier = new Promise((resolve) => {
            releaseRunBarrier = resolve;
        });

        try {
            const launcherPromise = codexLocalLauncher(session as never);
            await vi.waitFor(() => expect(harness.launches).toHaveLength(1));
            expect(session.sessionId).toBeNull();

            await writeFile(transcriptPath, [
                JSON.stringify({
                    type: 'session_meta',
                    payload: { id: 'fallback-thread', cwd: '/tmp/effective-codex-cwd' }
                }),
                JSON.stringify({
                    timestamp: new Date().toISOString(),
                    type: 'event_msg',
                    payload: { type: 'user_message', message: 'fallback prompt' }
                })
            ].join('\n') + '\n');

            await vi.waitFor(
                () => expect(session.sessionId).toBe('fallback-thread'),
                { timeout: 3_000, interval: 50 }
            );
            if (releaseRunBarrier) releaseRunBarrier();
            await launcherPromise;

            expect(session.transcriptPath).toBe(transcriptPath);
            expect(userMessages).toContain('fallback prompt');
        } finally {
            if (releaseRunBarrier) releaseRunBarrier();
            if (originalCodexHome === undefined) {
                delete process.env.CODEX_HOME;
            } else {
                process.env.CODEX_HOME = originalCodexHome;
            }
        }
    });

    it('replays existing transcript messages when importing a Codex thread into a new Hapi session', async () => {
        const transcriptPath = join(tempDir, 'codex-import-transcript.jsonl');
        const { session, agentMessages } = createSessionStub('default', undefined, '/tmp/worktree', null, true);
        let releaseRunBarrier: (() => void) | undefined;
        harness.runBarrier = new Promise((resolve) => {
            releaseRunBarrier = resolve;
        });

        await writeFile(
            transcriptPath,
            [
                JSON.stringify({ type: 'session_meta', payload: { id: 'codex-thread-import' } }),
                JSON.stringify({ type: 'event_msg', payload: { type: 'agent_message', message: 'old imported message' } })
            ].join('\n') + '\n'
        );

        const launcherPromise = codexLocalLauncher(session as never);
        await wait(50);

        harness.sessionHookHandlers[0]?.('codex-thread-import', {
            transcript_path: transcriptPath
        });
        await wait(300);

        if (releaseRunBarrier) {
            releaseRunBarrier();
        }
        await launcherPromise;

        expect(agentMessages).toContainEqual({
            type: 'message',
            message: 'old imported message',
            id: expect.any(String)
        });
    });

    it('replays semantic chat events once and keeps a same-turn preface before its plan', async () => {
        const transcriptPath = join(tempDir, 'codex-import-response-item-transcript.jsonl');
        const { session, userMessages, agentMessages, getUserActivityCount } = createSessionStub('default', undefined, '/tmp/worktree', null, true);
        let releaseRunBarrier: (() => void) | undefined;
        harness.runBarrier = new Promise((resolve) => {
            releaseRunBarrier = resolve;
        });

        await writeFile(
            transcriptPath,
            [
                JSON.stringify({ type: 'session_meta', payload: { id: 'codex-thread-import-response-item' } }),
                JSON.stringify({
                    type: 'response_item',
                    payload: {
                        type: 'message',
                        role: 'user',
                        content: [{ type: 'input_text', text: 'visible user message' }]
                    }
                }),
                JSON.stringify({
                    type: 'event_msg',
                    payload: { type: 'user_message', message: 'visible user message' }
                }),
                JSON.stringify({
                    type: 'event_msg',
                    payload: {
                        type: 'item_completed',
                        turn_id: 'turn-with-preface',
                        item: {
                            type: 'Plan',
                            id: 'plan-1',
                            text: '## Proposed plan\n\n1. Inspect\n2. Implement'
                        }
                    }
                }),
                JSON.stringify({
                    type: 'response_item',
                    payload: {
                        type: 'message',
                        role: 'assistant',
                        content: [{
                            type: 'output_text',
                            text: 'visible assistant preface\n\n<proposed_plan>## Proposed plan\n\n1. Inspect\n2. Implement</proposed_plan>'
                        }],
                        internal_chat_message_metadata_passthrough: { turn_id: 'turn-with-preface' }
                    }
                }),
                JSON.stringify({
                    type: 'event_msg',
                    payload: {
                        type: 'agent_message',
                        message: 'visible assistant preface',
                        phase: 'final_answer'
                    }
                }),
                JSON.stringify({
                    type: 'event_msg',
                    payload: { type: 'task_complete', turn_id: 'turn-with-preface' }
                }),
                JSON.stringify({
                    type: 'response_item',
                    payload: {
                        type: 'message',
                        role: 'user',
                        content: [{ type: 'input_text', text: '<environment_context>hidden context</environment_context>' }]
                    }
                })
            ].join('\n') + '\n'
        );

        const launcherPromise = codexLocalLauncher(session as never);
        await wait(50);

        harness.sessionHookHandlers[0]?.('codex-thread-import-response-item', {
            transcript_path: transcriptPath
        });
        await wait(300);

        if (releaseRunBarrier) {
            releaseRunBarrier();
        }
        await launcherPromise;

        expect(userMessages).toEqual(['visible user message']);
        expect(getUserActivityCount()).toBe(0);
        expect(agentMessages).toEqual([{
            type: 'message',
            message: 'visible assistant preface',
            id: expect.any(String)
        }, {
            type: 'tool-call',
            name: 'ExitPlanMode',
            callId: 'codex-proposed-plan:plan-1',
            input: { plan: '## Proposed plan\n\n1. Inspect\n2. Implement' },
            id: 'plan-1'
        }, {
            type: 'tool-call-result',
            callId: 'codex-proposed-plan:plan-1',
            output: null,
            id: 'plan-1:result'
        }]);
    });

    it('replays a plan-only turn when the turn completes', async () => {
        const transcriptPath = join(tempDir, 'codex-import-plan-only-transcript.jsonl');
        const { session, agentMessages } = createSessionStub('default', undefined, '/tmp/worktree', null, true);
        let releaseRunBarrier: (() => void) | undefined;
        harness.runBarrier = new Promise((resolve) => {
            releaseRunBarrier = resolve;
        });

        await writeFile(
            transcriptPath,
            [
                JSON.stringify({ type: 'session_meta', payload: { id: 'codex-thread-plan-only' } }),
                JSON.stringify({
                    type: 'event_msg',
                    payload: {
                        type: 'item_completed',
                        turn_id: 'turn-plan-only',
                        item: { type: 'Plan', id: 'plan-only', text: '## Plan only' }
                    }
                }),
                JSON.stringify({
                    type: 'response_item',
                    payload: {
                        type: 'message',
                        role: 'assistant',
                        content: [{ type: 'output_text', text: '<proposed_plan>## Plan only</proposed_plan>' }],
                        internal_chat_message_metadata_passthrough: { turn_id: 'turn-plan-only' }
                    }
                }),
                JSON.stringify({
                    type: 'event_msg',
                    payload: { type: 'task_complete', turn_id: 'turn-plan-only' }
                })
            ].join('\n') + '\n'
        );

        const launcherPromise = codexLocalLauncher(session as never);
        await wait(50);

        harness.sessionHookHandlers[0]?.('codex-thread-plan-only', {
            transcript_path: transcriptPath
        });
        await wait(300);

        if (releaseRunBarrier) {
            releaseRunBarrier();
        }
        await launcherPromise;

        expect(agentMessages).toEqual([{
            type: 'tool-call',
            name: 'ExitPlanMode',
            callId: 'codex-proposed-plan:plan-only',
            input: { plan: '## Plan only' },
            id: 'plan-only'
        }, {
            type: 'tool-call-result',
            callId: 'codex-proposed-plan:plan-only',
            output: null,
            id: 'plan-only:result'
        }]);
    });

    it('does not let a later non-clear hook replace the primary session', async () => {
        const primaryTranscriptPath = await writeTranscriptMeta('primary-later-hook.jsonl', 'primary-thread');
        const otherTranscriptPath = await writeTranscriptMeta('later-other-transcript.jsonl', 'other-thread');
        const { session } = createSessionStub('default');
        let releaseRunBarrier: (() => void) | undefined;
        harness.runBarrier = new Promise((resolve) => {
            releaseRunBarrier = resolve;
        });

        const launcherPromise = codexLocalLauncher(session as never);
        await wait(50);

        harness.sessionHookHandlers[0]?.('primary-thread', {
            transcript_path: primaryTranscriptPath,
            source: 'startup'
        });
        await wait(100);

        harness.sessionHookHandlers[0]?.('other-thread', {
            transcript_path: otherTranscriptPath,
            source: 'startup'
        });
        await wait(100);

        if (releaseRunBarrier) {
            releaseRunBarrier();
        }
        await launcherPromise;

        expect(session.sessionId).toBe('primary-thread');
        expect(session.transcriptPath).toBe(primaryTranscriptPath);
    });

    it('does not let a later hook without source replace the primary session', async () => {
        const primaryTranscriptPath = await writeTranscriptMeta('primary-no-source.jsonl', 'primary-thread');
        const otherTranscriptPath = await writeTranscriptMeta('other-no-source.jsonl', 'other-thread');
        const { session } = createSessionStub('default');
        let releaseRunBarrier: (() => void) | undefined;
        harness.runBarrier = new Promise((resolve) => {
            releaseRunBarrier = resolve;
        });

        const launcherPromise = codexLocalLauncher(session as never);
        await wait(50);

        harness.sessionHookHandlers[0]?.('primary-thread', {
            transcript_path: primaryTranscriptPath
        });
        await wait(100);

        harness.sessionHookHandlers[0]?.('other-thread', {
            transcript_path: otherTranscriptPath
        });
        await wait(100);

        if (releaseRunBarrier) {
            releaseRunBarrier();
        }
        await launcherPromise;

        expect(session.sessionId).toBe('primary-thread');
        expect(session.transcriptPath).toBe(primaryTranscriptPath);
    });

    it('allows a clear hook to replace the primary session', async () => {
        const primaryTranscriptPath = await writeTranscriptMeta('primary-before-clear.jsonl', 'primary-thread');
        const clearTranscriptPath = await writeTranscriptMeta('clear-transcript.jsonl', 'clear-thread');
        const { session } = createSessionStub('default');
        let releaseRunBarrier: (() => void) | undefined;
        harness.runBarrier = new Promise((resolve) => {
            releaseRunBarrier = resolve;
        });

        const launcherPromise = codexLocalLauncher(session as never);
        await wait(50);

        harness.sessionHookHandlers[0]?.('primary-thread', {
            transcript_path: primaryTranscriptPath,
            source: 'startup'
        });
        await wait(100);

        harness.sessionHookHandlers[0]?.('clear-thread', {
            transcript_path: clearTranscriptPath,
            source: 'clear'
        });
        await wait(100);

        if (releaseRunBarrier) {
            releaseRunBarrier();
        }
        await launcherPromise;

        expect(session.sessionId).toBe('clear-thread');
        expect(session.transcriptPath).toBe(clearTranscriptPath);
    });

    it('ignores mismatched session metadata from the active transcript scanner', async () => {
        const transcriptPath = await writeTranscriptMeta('mismatched-scanner.jsonl', 'primary-thread');
        const { session } = createSessionStub('default');
        let releaseRunBarrier: (() => void) | undefined;
        harness.runBarrier = new Promise((resolve) => {
            releaseRunBarrier = resolve;
        });

        const launcherPromise = codexLocalLauncher(session as never);
        await wait(50);

        harness.sessionHookHandlers[0]?.('primary-thread', {
            transcript_path: transcriptPath
        });
        await wait(100);

        await appendFile(
            transcriptPath,
            JSON.stringify({ type: 'session_meta', payload: { id: 'unexpected-thread' } }) + '\n'
        );

        await wait(2300);

        if (releaseRunBarrier) {
            releaseRunBarrier();
        }
        await launcherPromise;

        expect(session.sessionId).toBe('primary-thread');
        expect(session.transcriptPath).toBe(transcriptPath);
    });

    it('does not leave transcript scanning alive after launcher teardown', async () => {
        const transcriptPath = join(tempDir, 'teardown-race-transcript.jsonl');
        const { session, agentMessages } = createSessionStub('default');
        let releaseRunBarrier: (() => void) | undefined;
        harness.runBarrier = new Promise((resolve) => {
            releaseRunBarrier = resolve;
        });

        const oldLines = Array.from({ length: 20_000 }, (_, index) =>
            JSON.stringify({ type: 'event_msg', payload: { type: 'agent_message', message: `old-${index}` } })
        ).join('\n');
        await writeFile(transcriptPath, oldLines + '\n');

        const launcherPromise = codexLocalLauncher(session as never);
        await wait(50);

        harness.sessionHookHandlers[0]?.('codex-thread-race', {
            transcript_path: transcriptPath
        });
        if (releaseRunBarrier) {
            releaseRunBarrier();
        }
        await launcherPromise;

        await appendFile(
            transcriptPath,
            JSON.stringify({ type: 'event_msg', payload: { type: 'agent_message', message: 'post-teardown' } }) + '\n'
        );
        await wait(2300);

        expect(agentMessages).toHaveLength(0);
    });

    it('ignores late SessionStart hooks after shutdown begins', async () => {
        const staleTranscriptPath = join(tempDir, 'late-hook-transcript.jsonl');
        const { session } = createSessionStub('default');
        let releaseRunBarrier: (() => void) | undefined;
        harness.runBarrier = new Promise((resolve) => {
            releaseRunBarrier = resolve;
        });

        const launcherPromise = codexLocalLauncher(session as never);
        await wait(50);

        if (releaseRunBarrier) {
            releaseRunBarrier();
        }
        await launcherPromise;

        harness.sessionHookHandlers[0]?.('late-local-thread', {
            transcript_path: staleTranscriptPath
        });

        expect(session.sessionId).toBeNull();
        expect(session.transcriptPath).toBeNull();
    });
});
