import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { PassThrough } from 'node:stream';

const spawnMock = vi.hoisted(() => vi.fn());

vi.mock('node:child_process', () => ({
    spawn: spawnMock
}));

vi.mock('@/ui/logger', () => ({
    logger: { debug: vi.fn(), warn: vi.fn() }
}));

vi.mock('@/agent/messageConverter', () => ({
    convertAgentMessage: (message: {
        type: string
        message?: string
        id?: string
        stopReason?: string
        settledCallIds?: string[]
    }) => {
        if (message.type === 'error' && typeof message.message === 'string') {
            return { type: 'error', message: message.message };
        }
        if (message.type === 'tool_call') {
            return { type: 'tool-call', callId: message.id, name: 'tool', status: 'in_progress' };
        }
        if (message.type === 'tool_result') {
            return { type: 'tool-call-result', callId: message.id, output: {} };
        }
        if (message.type === 'turn_complete') {
            return {
                type: 'turn-complete',
                stopReason: message.stopReason ?? 'cancelled',
                ...(message.settledCallIds ? { settledCallIds: message.settledCallIds } : {}),
            };
        }
        return null;
    }
}));

vi.mock('@/ui/ink/OpencodeDisplay', () => ({
    OpencodeDisplay: () => null
}));

vi.mock('@/utils/process', () => ({
    killProcessByChildProcess: vi.fn(async () => true),
    snapshotProcessTreeIdentities: vi.fn((pid: number) => [{
        pid,
        startMarker: `marker-${pid}`,
        bootId: 'boot',
        tgid: pid,
        pgid: pid,
    }]),
    killRetainedProcessTree: vi.fn(async () => true),
    getProcessStartMarker: vi.fn((pid: number) => `marker-${pid}`),
    getSystemBootId: vi.fn(() => 'boot'),
    getProcessThreadGroupId: vi.fn((pid: number) => pid),
    getProcessGroupId: vi.fn((pid: number) => pid),
    classifyRetainedIdentity: vi.fn(() => 'match'),
    isAgentOwnedProcessGroup: vi.fn(() => true),
    verifyAgentOwnedProcessGroupExited: vi.fn(async () => true),
}));

import {
    isAgentOwnedProcessGroup,
    killProcessByChildProcess,
    killRetainedProcessTree,
    snapshotProcessTreeIdentities,
    verifyAgentOwnedProcessGroupExited,
} from '@/utils/process';
import { MessageQueue2 } from '@/utils/MessageQueue2';
import { CursorSession } from './session';
import type { EnhancedMode } from './loop';

type ChildOptions = {
    exitCode?: number | null;
    stderr?: string;
    /** Hold the close event; the test closes the child via closeChild(). */
    hold?: boolean;
    pid?: number;
};

function makeChild(opts: ChildOptions = {}) {
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const child = {
        pid: opts.pid ?? 4242,
        stdout,
        stderr,
        on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
            if (event === 'error') {
                child.failChild = (error: Error) => handler(error);
                return;
            }
            if (event === 'close') {
                if (opts.hold) {
                    child.closeChild = (code: number | null, stderrText?: string) => {
                        if (stderrText) {
                            stderr.emit('data', Buffer.from(stderrText));
                        }
                        handler(code, null);
                    };
                    return;
                }
                setImmediate(() => {
                    if (opts.stderr) {
                        // emit synchronously so runAgentProcess captures it before
                        // the close handler resolves.
                        stderr.emit('data', Buffer.from(opts.stderr));
                    }
                    handler(opts.exitCode ?? 0, null);
                });
            }
        }),
        closeChild: undefined as ((code: number | null, stderrText?: string) => void) | undefined,
        failChild: undefined as ((error: Error) => void) | undefined,
        emitStdout(line: string) {
            stdout.write(`${line}\n`);
        }
    };
    return child;
}

function makeClient() {
    const handlers = new Map<string, (payload?: unknown) => Promise<unknown>>();
    return {
        rpcHandlerManager: {
            handlers,
            registerHandler: vi.fn((method: string, handler: (payload?: unknown) => Promise<unknown>) => {
                handlers.set(method, handler);
            })
        },
        updateMetadata: vi.fn((handler: (m: Record<string, unknown>) => Record<string, unknown>) => {
            handler({ path: '/tmp', host: 'h', flavor: 'cursor' });
        }),
        sendSessionEvent: vi.fn(),
        sendAgentMessage: vi.fn(),
        keepAlive: vi.fn(),
        emitMessagesConsumed: vi.fn()
    };
}

function makeSession(queue: MessageQueue2<EnhancedMode>, client: ReturnType<typeof makeClient>): CursorSession {
    return new CursorSession({
        api: {} as never,
        client: client as never,
        path: '/tmp/project',
        logPath: '/tmp/log',
        sessionId: 'legacy-id',
        messageQueue: queue,
        onModeChange: vi.fn(),
        mode: 'remote',
        startedBy: 'runner',
        startingMode: 'remote'
    });
}

describe('cursorLegacyRemoteLauncher', () => {
    beforeEach(() => {
        spawnMock.mockReset();
        vi.mocked(killProcessByChildProcess).mockReset();
        vi.mocked(killProcessByChildProcess).mockResolvedValue(true);
        vi.mocked(killRetainedProcessTree).mockReset();
        vi.mocked(killRetainedProcessTree).mockResolvedValue(true);
        vi.mocked(snapshotProcessTreeIdentities).mockClear();
        process.stdin.isTTY = false;
        process.stdout.isTTY = false;
        process.env.CURSOR_LEGACY_TRANSIENT_BACKOFF_MS = '0';
    });

    afterEach(() => {
        delete process.env.CURSOR_LEGACY_TRANSIENT_BACKOFF_MS;
    });

    it('spawns agent with stream-json and trust, not acp', async () => {
        const child = makeChild();
        spawnMock.mockReturnValue(child);

        const queue = new MessageQueue2<EnhancedMode>(() => 'm');
        queue.push('hello', { permissionMode: 'default' });
        queue.close();

        const client = makeClient();
        const session = makeSession(queue, client);

        const { cursorLegacyRemoteLauncher } = await import('./cursorLegacyRemoteLauncher');
        await cursorLegacyRemoteLauncher(session);

        expect(spawnMock).toHaveBeenCalledTimes(1);
        const args = spawnMock.mock.calls[0]?.[1] as string[];
        expect(args).toContain('-p');
        expect(args).toContain('stream-json');
        expect(args).toContain('--trust');
        expect(args).toContain('--resume');
        expect(args).toContain('legacy-id');
        expect(args).not.toContain('acp');
    });

    it('requeues the user message and surfaces an auth banner when agent exits with auth-required stderr', async () => {
        const queue = new MessageQueue2<EnhancedMode>(() => 'm');
        queue.push('do thing', { permissionMode: 'default' });

        let call = 0;
        spawnMock.mockImplementation(() => {
            call += 1;
            if (call === 1) {
                return makeChild({
                    exitCode: 1,
                    stderr: "Error: Authentication required. Please run 'agent login' first\n"
                });
            }
            queue.close();
            return makeChild({ exitCode: 0 });
        });

        const client = makeClient();
        const session = makeSession(queue, client);

        const { cursorLegacyRemoteLauncher } = await import('./cursorLegacyRemoteLauncher');
        await cursorLegacyRemoteLauncher(session);

        expect(spawnMock).toHaveBeenCalledTimes(2);
        const messages = client.sendAgentMessage.mock.calls
            .map((c) => c[0])
            .filter((e: any) => e.type === 'error');
        expect(messages).toHaveLength(1);
        expect(messages[0].message).toContain('Cursor authentication expired');
        expect(messages[0].message).toContain("'agent login'");
        expect(messages[0].message).toContain('queued and will retry');

        const firstPrompt = spawnMock.mock.calls[0]?.[1] as string[];
        const secondPrompt = spawnMock.mock.calls[1]?.[1] as string[];
        const pIndex1 = firstPrompt.indexOf('-p');
        const pIndex2 = secondPrompt.indexOf('-p');
        expect(firstPrompt[pIndex1 + 1]).toBe('do thing');
        expect(secondPrompt[pIndex2 + 1]).toBe('do thing');
    });

    it('uses a rate-limit-specific banner for rate limit stderr', async () => {
        const queue = new MessageQueue2<EnhancedMode>(() => 'm');
        queue.push('do thing', { permissionMode: 'default' });

        let call = 0;
        spawnMock.mockImplementation(() => {
            call += 1;
            if (call === 1) {
                return makeChild({
                    exitCode: 1,
                    stderr: 'Error: rate limit exceeded, please retry later\n'
                });
            }
            queue.close();
            return makeChild({ exitCode: 0 });
        });

        const client = makeClient();
        const session = makeSession(queue, client);

        const { cursorLegacyRemoteLauncher } = await import('./cursorLegacyRemoteLauncher');
        await cursorLegacyRemoteLauncher(session);

        const messages = client.sendAgentMessage.mock.calls
            .map((c) => c[0])
            .filter((e: any) => e.type === 'error');
        expect(messages).toHaveLength(1);
        expect(messages[0].message).toContain('rate limit');
        expect(messages[0].message).toContain('queued and will retry');
    });

    it('does not requeue when stderr is non-transient (real crash); surfaces error and emits ready', async () => {
        const queue = new MessageQueue2<EnhancedMode>(() => 'm');
        queue.push('do thing', { permissionMode: 'default' });
        queue.close();

        spawnMock.mockReturnValue(makeChild({
            exitCode: 134,
            stderr: 'fatal: Segmentation fault\n'
        }));

        const client = makeClient();
        const session = makeSession(queue, client);

        const { cursorLegacyRemoteLauncher } = await import('./cursorLegacyRemoteLauncher');
        await cursorLegacyRemoteLauncher(session);

        expect(spawnMock).toHaveBeenCalledTimes(1);
        const messageEvents = client.sendAgentMessage.mock.calls
            .map((c) => c[0])
            .filter((e: any) => e.type === 'error');
        expect(messageEvents).toHaveLength(1);
        expect(messageEvents[0].message).toContain('Agent exited (134)');
        expect(messageEvents[0].message).toContain('Segmentation fault');
        expect(messageEvents[0].message).not.toContain('queued and will retry');

        const readyEvents = client.sendSessionEvent.mock.calls
            .map((c) => c[0])
            .filter((e: any) => e.type === 'ready');
        expect(readyEvents).toHaveLength(1);
    });

    it('does not retry signal-killed processes even if stderr contains a transient keyword', async () => {
        // SIGTERM → exit 143; stderr happens to mention rate limit. Should NOT be
        // classified transient because the documented contract is exit-1-only.
        const queue = new MessageQueue2<EnhancedMode>(() => 'm');
        queue.push('do thing', { permissionMode: 'default' });
        queue.close();

        spawnMock.mockReturnValue(makeChild({
            exitCode: 143,
            stderr: 'rate limit hit; aborting due to SIGTERM\n'
        }));

        const client = makeClient();
        const session = makeSession(queue, client);

        const { cursorLegacyRemoteLauncher } = await import('./cursorLegacyRemoteLauncher');
        await cursorLegacyRemoteLauncher(session);

        expect(spawnMock).toHaveBeenCalledTimes(1);
        const messageEvents = client.sendAgentMessage.mock.calls
            .map((c) => c[0])
            .filter((e: any) => e.type === 'error');
        expect(messageEvents).toHaveLength(1);
        expect(messageEvents[0].message).toContain('Agent exited (143)');
        expect(messageEvents[0].message).not.toContain('queued and will retry');
    });

    it('preserves isolation when requeueing a slash command after a transient failure', async () => {
        const queue = new MessageQueue2<EnhancedMode>(() => 'm');
        // /compress is a pass-through slash command; enqueueCursorUserMessage uses
        // pushIsolated for these so they never batch with sibling prompts.
        queue.pushIsolated('/compress', { permissionMode: 'default' });

        let call = 0;
        spawnMock.mockImplementation(() => {
            call += 1;
            if (call === 1) {
                return makeChild({
                    exitCode: 1,
                    stderr: "Error: Authentication required. Please run 'agent login' first\n"
                });
            }
            queue.close();
            return makeChild({ exitCode: 0 });
        });

        const client = makeClient();
        const session = makeSession(queue, client);

        const { cursorLegacyRemoteLauncher } = await import('./cursorLegacyRemoteLauncher');
        await cursorLegacyRemoteLauncher(session);

        expect(spawnMock).toHaveBeenCalledTimes(2);
        // Confirm the queue still flagged the requeued item as isolated
        // (the second collectBatch saw it alone with isolate=true).
        const secondPrompt = spawnMock.mock.calls[1]?.[1] as string[];
        const pIdx = secondPrompt.indexOf('-p');
        expect(secondPrompt[pIdx + 1]).toBe('/compress');
    });

    it('drops the message after MAX_CONSECUTIVE_TRANSIENT_FAILURES consecutive transient failures', async () => {
        const queue = new MessageQueue2<EnhancedMode>(() => 'm');
        queue.push('do thing', { permissionMode: 'default' });

        let call = 0;
        spawnMock.mockImplementation(() => {
            call += 1;
            if (call >= 5) {
                queue.close();
            }
            return makeChild({
                exitCode: 1,
                stderr: "Error: Authentication required. Please run 'agent login' first\n"
            });
        });

        const client = makeClient();
        const session = makeSession(queue, client);

        const { cursorLegacyRemoteLauncher } = await import('./cursorLegacyRemoteLauncher');
        await cursorLegacyRemoteLauncher(session);

        expect(spawnMock).toHaveBeenCalledTimes(5);

        const messageEvents = client.sendAgentMessage.mock.calls
            .map((c) => c[0])
            .filter((e: any) => e.type === 'error');
        // 4 transient retry banners + 1 drop banner = 5
        expect(messageEvents).toHaveLength(5);
        const banners = messageEvents.map((e: any) => e.message);
        expect(banners.filter((m: string) => m.includes('queued and will retry'))).toHaveLength(4);
        const drop = banners.find((m: string) => m.includes('5 times in a row'));
        expect(drop).toBeDefined();
        expect(drop).toContain('Dropping the queued message');
    });

    it('keeps the queued row and the loop alive when a plain Stop lands mid-turn', async () => {
        const child1 = makeChild({ hold: true });
        spawnMock.mockReturnValueOnce(child1);
        const queue = new MessageQueue2<EnhancedMode>(() => 'm');
        queue.push('first', { permissionMode: 'default' }, 'first');

        const client = makeClient();
        const session = makeSession(queue, client);
        const reset = vi.spyOn(queue, 'reset');

        const { cursorLegacyRemoteLauncher } = await import('./cursorLegacyRemoteLauncher');
        const launchPromise = cursorLegacyRemoteLauncher(session);
        await vi.waitFor(() => expect(spawnMock).toHaveBeenCalledTimes(1));

        // A second row queues behind the in-flight turn, then a plain Stop
        // lands: abort kills the child; close drains stdout and resolves the
        // run (exitCode null) without touching the queue.
        queue.push('pending', { permissionMode: 'default' }, 'pending');
        const abort = client.rpcHandlerManager.handlers.get('abort')! as () => Promise<void>;
        await abort();
        child1.closeChild?.(null);

        // Plain Stop preserves the pending queue: no reset, row intact.
        expect(reset).not.toHaveBeenCalled();
        expect(queue.pendingLocalIds()).toEqual(['pending']);

        // The loop drains the preserved row once the Stop settles.
        await vi.waitFor(() => expect(spawnMock).toHaveBeenCalledTimes(2));
        const secondArgs = spawnMock.mock.calls[1]?.[1] as string[];
        const pIdx = secondArgs.indexOf('-p');
        expect(secondArgs[pIdx + 1]).toBe('pending');

        queue.close();
        await launchPromise;
        expect(queue.pendingLocalIds()).toEqual([]);
    });

    it('publishes turn-complete settlement after Stop drains, including late tool starts (#2021)', async () => {
        const child1 = makeChild({ hold: true });
        spawnMock.mockReturnValueOnce(child1);
        const queue = new MessageQueue2<EnhancedMode>(() => 'm');
        queue.push('first', { permissionMode: 'default' }, 'first');

        const client = makeClient();
        const session = makeSession(queue, client);

        const { cursorLegacyRemoteLauncher } = await import('./cursorLegacyRemoteLauncher');
        const launchPromise = cursorLegacyRemoteLauncher(session);
        await vi.waitFor(() => expect(spawnMock).toHaveBeenCalledTimes(1));
        // Let runAgentProcess attach readline before writing NDJSON.
        await new Promise((resolve) => setTimeout(resolve, 30));

        child1.emitStdout(JSON.stringify({
            type: 'tool_call',
            subtype: 'started',
            call_id: 'legacy-tool-1',
            tool_call: { name: 'Shell', arguments: { command: 'sleep 60' } },
            session_id: 'legacy-id',
        }));
        await vi.waitFor(() =>
            expect(client.sendAgentMessage.mock.calls.some(
                ([msg]) => (msg as { type?: string; callId?: string }).type === 'tool-call'
                    && (msg as { callId?: string }).callId === 'legacy-tool-1'
            )).toBe(true)
        );

        const abort = client.rpcHandlerManager.handlers.get('abort')! as () => Promise<void>;
        await abort();

        // Buffered start can arrive after abort and before close — must be
        // settled with the earlier open call once stdout drains.
        child1.emitStdout(JSON.stringify({
            type: 'tool_call',
            subtype: 'started',
            call_id: 'legacy-tool-late',
            tool_call: { name: 'Shell', arguments: { command: 'echo late' } },
            session_id: 'legacy-id',
        }));
        await vi.waitFor(() =>
            expect(client.sendAgentMessage.mock.calls.some(
                ([msg]) => (msg as { type?: string; callId?: string }).type === 'tool-call'
                    && (msg as { callId?: string }).callId === 'legacy-tool-late'
            )).toBe(true)
        );

        // Settlement is deferred until close/drain — not published on abort alone.
        expect(client.sendAgentMessage.mock.calls.some(
            ([message]) => (message as { type?: string }).type === 'turn-complete'
        )).toBe(false);

        child1.closeChild?.(null);

        await vi.waitFor(() =>
            expect(client.sendAgentMessage.mock.calls.some(
                ([message]) => (message as { type?: string }).type === 'turn-complete'
            )).toBe(true)
        );

        const settlements = client.sendAgentMessage.mock.calls
            .map(([message]) => message as { type?: string; settledCallIds?: string[]; stopReason?: string })
            .filter((message) => message?.type === 'turn-complete');
        expect(settlements).toEqual([
            expect.objectContaining({
                type: 'turn-complete',
                stopReason: 'cancelled',
                settledCallIds: expect.arrayContaining(['legacy-tool-1', 'legacy-tool-late']),
            }),
        ]);
        expect(settlements[0]?.settledCallIds).toHaveLength(2);

        queue.close();
        await launchPromise;
    });

    it('settles unmatched legacy tool calls after a final result without tool_result (#2021)', async () => {
        const child1 = makeChild({ hold: true });
        spawnMock.mockReturnValueOnce(child1);
        const queue = new MessageQueue2<EnhancedMode>(() => 'm');
        queue.push('first', { permissionMode: 'default' }, 'first');

        const client = makeClient();
        const session = makeSession(queue, client);

        const { cursorLegacyRemoteLauncher } = await import('./cursorLegacyRemoteLauncher');
        const launchPromise = cursorLegacyRemoteLauncher(session);
        await vi.waitFor(() => expect(spawnMock).toHaveBeenCalledTimes(1));
        await new Promise((resolve) => setTimeout(resolve, 30));

        child1.emitStdout(JSON.stringify({
            type: 'tool_call',
            subtype: 'started',
            call_id: 'legacy-unmatched',
            tool_call: { name: 'Shell', arguments: { command: 'echo hi' } },
            session_id: 'legacy-id',
        }));
        await vi.waitFor(() =>
            expect(client.sendAgentMessage.mock.calls.some(
                ([msg]) => (msg as { callId?: string }).callId === 'legacy-unmatched'
            )).toBe(true)
        );

        // Final result → turn_complete with no settlement ids. Must NOT clear
        // the unmatched set — close still publishes it.
        child1.emitStdout(JSON.stringify({
            type: 'result',
            subtype: 'success',
            result: 'done',
            session_id: 'legacy-id',
        }));
        child1.closeChild?.(0);

        await vi.waitFor(() =>
            expect(client.sendAgentMessage.mock.calls.some(
                ([message]) => (message as { type?: string }).type === 'turn-complete'
                    && Array.isArray((message as { settledCallIds?: string[] }).settledCallIds)
                    && (message as { settledCallIds: string[] }).settledCallIds.includes('legacy-unmatched')
            )).toBe(true)
        );

        queue.close();
        await launchPromise;
    });

    it('retries Stop against the retained tree when the first kill is unconfirmed (#2021)', async () => {
        const killMock = vi.mocked(killRetainedProcessTree);
        killMock.mockReset();
        killMock.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
        const snapMock = vi.mocked(snapshotProcessTreeIdentities);
        snapMock.mockClear();

        const child1 = makeChild({ hold: true, pid: 7777 });
        spawnMock.mockReturnValueOnce(child1);
        const queue = new MessageQueue2<EnhancedMode>(() => 'm');
        queue.push('first', { permissionMode: 'default' }, 'first');

        const client = makeClient();
        const session = makeSession(queue, client);
        const thinking = vi.spyOn(session, 'onThinkingChange');

        const { cursorLegacyRemoteLauncher } = await import('./cursorLegacyRemoteLauncher');
        const launchPromise = cursorLegacyRemoteLauncher(session);
        await vi.waitFor(() => expect(spawnMock).toHaveBeenCalledTimes(1));
        await new Promise((resolve) => setTimeout(resolve, 30));

        const abort = client.rpcHandlerManager.handlers.get('abort')! as () => Promise<void>;
        await abort();
        // Spawn capture + first-Stop refresh while root still matches.
        expect(snapMock.mock.calls.length).toBeGreaterThanOrEqual(2);
        expect(snapMock).toHaveBeenCalledWith(7777);
        expect(killMock.mock.calls.length).toBeGreaterThanOrEqual(1);
        expect(killMock.mock.calls[0]?.[1]).toBe(false);
        // Unconfirmed kill must leave thinking true so web Stop stays enabled.
        expect(thinking).not.toHaveBeenCalledWith(false);

        const killsAfterFirst = killMock.mock.calls.length;
        await abort();
        // Second Stop escalates force against the refreshed retained tree.
        expect(killMock.mock.calls.length).toBeGreaterThan(killsAfterFirst);
        expect(killMock.mock.calls[killsAfterFirst]?.[1]).toBe(true);
        expect(thinking).toHaveBeenCalledWith(false);

        child1.closeChild?.(null);
        queue.close();
        await launchPromise;
        thinking.mockRestore();
        killMock.mockResolvedValue(true);
    });

    it('keeps Stop unresolved when spawn tree and agent-owned group are both unavailable (#2021)', async () => {
        const snapMock = vi.mocked(snapshotProcessTreeIdentities);
        const killRetained = vi.mocked(killRetainedProcessTree);
        const killChild = vi.mocked(killProcessByChildProcess);
        const ownedGroup = vi.mocked(isAgentOwnedProcessGroup);
        const verifyGroup = vi.mocked(verifyAgentOwnedProcessGroupExited);
        // Every snapshot fails — spawn and Stop refresh both miss.
        snapMock.mockReturnValue(null);
        ownedGroup.mockReturnValue(false);
        killRetained.mockClear();
        killChild.mockClear();
        verifyGroup.mockClear();

        const child1 = makeChild({ hold: true, pid: 9999 });
        spawnMock.mockReturnValueOnce(child1);
        const queue = new MessageQueue2<EnhancedMode>(() => 'm');
        queue.push('first', { permissionMode: 'default' }, 'first');

        const client = makeClient();
        const session = makeSession(queue, client);
        const thinking = vi.spyOn(session, 'onThinkingChange');

        const { cursorLegacyRemoteLauncher } = await import('./cursorLegacyRemoteLauncher');
        const launchPromise = cursorLegacyRemoteLauncher(session);
        await vi.waitFor(() => expect(spawnMock).toHaveBeenCalledTimes(1));
        await new Promise((resolve) => setTimeout(resolve, 30));

        const abort = client.rpcHandlerManager.handlers.get('abort')! as () => Promise<void>;
        await abort();
        expect(snapMock.mock.calls.length).toBeGreaterThanOrEqual(1);
        // Must not signal by live ChildProcess PID when the original tree is unknown.
        expect(killChild).not.toHaveBeenCalled();
        expect(killRetained).not.toHaveBeenCalled();
        expect(verifyGroup).not.toHaveBeenCalled();
        expect(thinking).not.toHaveBeenCalledWith(false);

        // Second Stop may refresh again while root matches, but still refuses
        // to signal without a verified tree or agent-owned group.
        const snapCount = snapMock.mock.calls.length;
        await abort();
        expect(snapMock.mock.calls.length).toBeGreaterThanOrEqual(snapCount);
        expect(killChild).not.toHaveBeenCalled();
        expect(killRetained).not.toHaveBeenCalled();
        expect(verifyGroup).not.toHaveBeenCalled();
        expect(thinking).not.toHaveBeenCalledWith(false);

        thinking.mockRestore();
        ownedGroup.mockReturnValue(true);
        snapMock.mockImplementation((pid: number) => [{
            pid,
            startMarker: `marker-${pid}`,
            bootId: 'boot',
            tgid: pid,
            pgid: pid,
        }]);
        // Force the runAgentProcess promise to reject so the suite does not
        // leave a hanging Vitest worker (incomplete snapshot never verifies).
        child1.failChild?.(new Error('test teardown after incomplete snapshot'));
        queue.close();
        await launchPromise.catch(() => undefined);
    });

    it('recovers Stop via spawn-time process group after the root exits (#2021)', async () => {
        const { classifyRetainedIdentity } = await import('@/utils/process');
        const snapMock = vi.mocked(snapshotProcessTreeIdentities);
        const killRetained = vi.mocked(killRetainedProcessTree);
        const verifyGroup = vi.mocked(verifyAgentOwnedProcessGroupExited);
        const ownedGroup = vi.mocked(isAgentOwnedProcessGroup);
        const classify = vi.mocked(classifyRetainedIdentity);
        // Spawn captures a tree; later the root generation is gone while a
        // descendant still holds stdout — recover via agent-owned pgid.
        snapMock.mockReturnValueOnce(null);
        ownedGroup.mockReturnValue(true);
        verifyGroup.mockResolvedValue(true);
        classify.mockReturnValue('gone');
        killRetained.mockClear();
        verifyGroup.mockClear();

        const child1 = makeChild({ hold: true, pid: 5555 });
        spawnMock.mockReturnValueOnce(child1);
        const queue = new MessageQueue2<EnhancedMode>(() => 'm');
        queue.push('first', { permissionMode: 'default' }, 'first');

        const client = makeClient();
        const session = makeSession(queue, client);
        const thinking = vi.spyOn(session, 'onThinkingChange');

        const { cursorLegacyRemoteLauncher } = await import('./cursorLegacyRemoteLauncher');
        const launchPromise = cursorLegacyRemoteLauncher(session);
        await vi.waitFor(() => expect(spawnMock).toHaveBeenCalledTimes(1));
        expect(spawnMock.mock.calls[0]?.[2]).toMatchObject({ detached: true });
        await new Promise((resolve) => setTimeout(resolve, 30));

        const abort = client.rpcHandlerManager.handlers.get('abort')! as () => Promise<void>;
        await abort();
        expect(killRetained).not.toHaveBeenCalled();
        expect(verifyGroup).toHaveBeenCalled();
        expect(thinking).toHaveBeenCalledWith(false);

        child1.closeChild?.(null);
        queue.close();
        await launchPromise;
        thinking.mockRestore();
        classify.mockReturnValue('match');
        ownedGroup.mockReturnValue(true);
        snapMock.mockImplementation((pid: number) => [{
            pid,
            startMarker: `marker-${pid}`,
            bootId: 'boot',
            tgid: pid,
            pgid: pid,
        }]);
    });

    it('blocks Switch when tree kill stays unconfirmed (#2021)', async () => {
        const killMock = vi.mocked(killRetainedProcessTree);
        killMock.mockReset();
        killMock.mockResolvedValue(false);

        const child1 = makeChild({ hold: true, pid: 8888 });
        spawnMock.mockReturnValueOnce(child1);
        const queue = new MessageQueue2<EnhancedMode>(() => 'm');
        queue.push('first', { permissionMode: 'default' }, 'first');

        const client = makeClient();
        const session = makeSession(queue, client);

        const { cursorLegacyRemoteLauncher } = await import('./cursorLegacyRemoteLauncher');
        const launchPromise = cursorLegacyRemoteLauncher(session);
        await vi.waitFor(() => expect(spawnMock).toHaveBeenCalledTimes(1));
        await new Promise((resolve) => setTimeout(resolve, 30));

        // Unconfirmed kill must not hand off to local Cursor — and must not
        // commit shouldExit before the throw (confirm-then-requestExit).
        await expect(
            (client.rpcHandlerManager.handlers.get('switch')! as () => Promise<void>)()
        ).rejects.toThrow(/still open after force kill/);
        expect(killMock.mock.calls.some((call) => call[1] === true)).toBe(true);

        // Late close after a rejected Switch must not complete the handoff —
        // tree verify is still false, so settlement waits for Stop retry.
        child1.closeChild?.(null);
        await new Promise((resolve) => setTimeout(resolve, 50));
        expect(await Promise.race([
            launchPromise.then((reason) => reason),
            new Promise<'pending'>((resolve) => setTimeout(() => resolve('pending'), 100)),
        ])).toBe('pending');

        // Recover: confirm kill on a fresh Stop, then close the queue.
        killMock.mockResolvedValue(true);
        const abort = client.rpcHandlerManager.handlers.get('abort')! as () => Promise<void>;
        await abort();
        queue.close();
        await launchPromise;
        killMock.mockResolvedValue(true);
    });

    it.each(['switch', 'exit'] as const)('resets the queue exactly once on terminal %s', async (reason) => {
        const child1 = makeChild({ hold: true });
        spawnMock.mockReturnValueOnce(child1);
        const queue = new MessageQueue2<EnhancedMode>(() => 'm');
        queue.push('first', { permissionMode: 'default' }, 'first');

        const client = makeClient();
        const session = makeSession(queue, client);
        const reset = vi.spyOn(queue, 'reset');

        const { RemoteLauncherBase } = await import('@/modules/common/remote/RemoteLauncherBase');
        let terminalHandlers!: import('@/modules/common/remote/RemoteLauncherBase').RemoteLauncherTerminalHandlers;
        const setupSpy = vi.spyOn(RemoteLauncherBase.prototype as unknown as {
            setupTerminal: (handlers: import('@/modules/common/remote/RemoteLauncherBase').RemoteLauncherTerminalHandlers) => void;
        }, 'setupTerminal').mockImplementation(handlers => { terminalHandlers = handlers; });

        const { cursorLegacyRemoteLauncher } = await import('./cursorLegacyRemoteLauncher');
        const launchPromise = cursorLegacyRemoteLauncher(session);
        await vi.waitFor(() => expect(spawnMock).toHaveBeenCalledTimes(1));

        queue.push('pending', { permissionMode: 'default' }, 'pending');
        if (reason === 'switch') {
            await (client.rpcHandlerManager.handlers.get('switch')! as () => Promise<void>)();
        } else {
            await terminalHandlers.onExit();
        }
        // Abort waits for subprocess close before the main loop can exit.
        child1.closeChild?.(null);

        // Terminal cleanup resets the queued rows exactly once; no further
        // dispatch happens after it.
        expect(reset).toHaveBeenCalledTimes(1);
        expect(reset).toHaveBeenCalledWith();
        expect(queue.pendingLocalIds()).toEqual([]);
        expect(spawnMock).toHaveBeenCalledTimes(1);
        expect(await launchPromise).toBe(reason);
        setupSpy.mockRestore();
    });

    it('preserves a not-yet-dequeued row when a plain Stop lands during the dequeue wait', async () => {
        const queue = new MessageQueue2<EnhancedMode>(() => 'm');
        const client = makeClient();
        const session = makeSession(queue, client);
        const reset = vi.spyOn(queue, 'reset');

        // Park only the loop's FIRST dequeue wait so the Stop lands while the row
        // is still queued (never dequeued, never hub-ACKed); later waits pass
        // straight through.
        let releaseWait!: () => void;
        let parkEntered: (() => void) | undefined;
        const parkGate = new Promise<void>(resolve => { parkEntered = resolve; });
        let waitCalls = 0;
        const waitSpy = vi.spyOn(queue, 'waitForMessagesAndGetAsString')
            .mockImplementation(async (signal?: AbortSignal) => {
                waitCalls += 1;
                if (waitCalls === 1) {
                    parkEntered?.();
                    parkEntered = undefined;
                    await new Promise<void>(resolve => { releaseWait = resolve; });
                }
                return MessageQueue2.prototype.waitForMessagesAndGetAsString.call(queue, signal);
            });

        const { cursorLegacyRemoteLauncher } = await import('./cursorLegacyRemoteLauncher');
        try {
            const launchPromise = cursorLegacyRemoteLauncher(session);
            await parkGate;

            const abort = client.rpcHandlerManager.handlers.get('abort')! as () => Promise<void>;
            const stopped = abort();
            releaseWait();
            await stopped;

            // Plain Stop: no reset; the row survives and dispatches after the
            // Stop settles.
            expect(reset).not.toHaveBeenCalled();
            queue.push('first', { permissionMode: 'default' }, 'first');
            await vi.waitFor(() => expect(spawnMock).toHaveBeenCalledTimes(1));
            const args = spawnMock.mock.calls[0]?.[1] as string[];
            const pIdx = args.indexOf('-p');
            expect(args[pIdx + 1]).toBe('first');

            queue.close();
            expect(await launchPromise).toBeDefined();
            expect(queue.pendingLocalIds()).toEqual([]);
        } finally {
            waitSpy.mockRestore();
        }
    });
});
