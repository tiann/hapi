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
    initialTranscriptPath: string | null = null
) {
    const sessionEvents: Array<{ type: string; message?: string }> = [];
    const agentMessages: unknown[] = [];
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
            client: {
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
            sendUserMessage: () => {},
            sendAgentMessage: (message: unknown) => {
                agentMessages.push(message);
            },
            queue: createQueueStub()
        },
        sessionEvents,
        agentMessages,
        getLocalLaunchFailure: () => localLaunchFailure
    };
}

describe('codexLocalLauncher', () => {
    let tempDir = '';

    const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

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
            'on-failure',
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
