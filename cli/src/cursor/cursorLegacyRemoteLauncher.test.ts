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
    convertAgentMessage: () => null
}));

vi.mock('@/ui/ink/OpencodeDisplay', () => ({
    OpencodeDisplay: () => null
}));

vi.mock('@/utils/process', () => ({
    killProcessByChildProcess: vi.fn(async () => {})
}));

import { MessageQueue2 } from '@/utils/MessageQueue2';
import { CursorSession } from './session';
import type { EnhancedMode } from './loop';

type ChildOptions = {
    exitCode?: number | null;
    stderr?: string;
};

function makeChild(opts: ChildOptions = {}) {
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const child = {
        stdout,
        stderr,
        on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
            if (event === 'close') {
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
        emitStdout(line: string) {
            stdout.write(`${line}\n`);
        }
    };
    return child;
}

function makeClient() {
    return {
        rpcHandlerManager: { registerHandler: vi.fn() },
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
        const messages = client.sendSessionEvent.mock.calls
            .map((c) => c[0])
            .filter((e: any) => e.type === 'message');
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

        const messages = client.sendSessionEvent.mock.calls
            .map((c) => c[0])
            .filter((e: any) => e.type === 'message');
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
        const messageEvents = client.sendSessionEvent.mock.calls
            .map((c) => c[0])
            .filter((e: any) => e.type === 'message');
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
        const messageEvents = client.sendSessionEvent.mock.calls
            .map((c) => c[0])
            .filter((e: any) => e.type === 'message');
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

        const messageEvents = client.sendSessionEvent.mock.calls
            .map((c) => c[0])
            .filter((e: any) => e.type === 'message');
        // 4 transient retry banners + 1 drop banner = 5
        expect(messageEvents).toHaveLength(5);
        const banners = messageEvents.map((e: any) => e.message);
        expect(banners.filter((m: string) => m.includes('queued and will retry'))).toHaveLength(4);
        const drop = banners.find((m: string) => m.includes('5 times in a row'));
        expect(drop).toBeDefined();
        expect(drop).toContain('Dropping the queued message');
    });
});
