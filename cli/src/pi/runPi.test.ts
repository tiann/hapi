import { beforeEach, describe, expect, it, vi } from 'vitest';

type TransportOptions = { command: string; args: string[]; cwd: string };
type LifecycleOptions = { stopKeepAlive: () => void };

const harness = vi.hoisted(() => ({
    transportOptions: null as TransportOptions | null,
    sent: [] as unknown[],
    throwOnGetCommands: true,
    onError: null as ((error: Error) => void) | null,
    onEvent: null as ((event: Record<string, unknown>) => void) | null,
    rpcHandlers: new Map<string, (payload: unknown) => Promise<unknown>>(),
    killCount: 0,
    cleanupCount: 0,
    session: {
        keepAlive: vi.fn(),
        onUserMessage: vi.fn(),
        onCancelQueuedMessage: vi.fn(),
        emitMessagesConsumed: vi.fn(),
        sendSessionEvent: vi.fn(),
        updateMetadata: vi.fn(),
        getMetadata: vi.fn(() => null),
        emitSessionReady: vi.fn(),
        rpcHandlerManager: { registerHandler: vi.fn() },
    },
}));

vi.mock('@/agent/sessionFactory', () => ({
    bootstrapSession: vi.fn(async () => ({ api: {}, session: harness.session })),
    bootstrapExistingSession: vi.fn(async () => ({ api: {}, session: harness.session })),
}));

vi.mock('@/agent/runnerLifecycle', () => ({
    createRunnerLifecycle: vi.fn((options: LifecycleOptions) => {
        return {
            registerProcessHandlers: vi.fn(),
            cleanupAndExit: vi.fn(async () => {
                harness.cleanupCount += 1;
                options.stopKeepAlive();
            }),
            markCrash: vi.fn(),
            setExitCode: vi.fn(),
            setArchiveReason: vi.fn(),
            setSessionEndReason: vi.fn(),
            hasExplicitSessionEndReason: vi.fn(() => true),
        };
    }),
    createModeChangeHandler: vi.fn(() => vi.fn()),
    setControlledByUser: vi.fn(),
}));

vi.mock('@/ui/logger', () => ({
    logger: {
        debug: vi.fn(),
        getLogPath: vi.fn(() => '/tmp/hapi.log'),
    },
}));

vi.mock('./piTransport', () => ({
    PiTransport: class {
        constructor(options: TransportOptions) {
            harness.transportOptions = options;
        }

        onError(callback: (error: Error) => void): void {
            harness.onError = callback;
        }

        onClose(): void {}

        onEvent(callback: (event: Record<string, unknown>) => void): void {
            harness.onEvent = callback;
        }

        start(): void {}

        send(command: unknown): void {
            harness.sent.push(command);
            if (harness.throwOnGetCommands && (command as { type?: string }).type === 'get_commands') {
                throw new Error('stop test transport');
            }
        }

        kill(): void {
            harness.killCount += 1;
        }
    },
}));

import { buildPiCommandInventory, formatPiUserMessage, rewritePiSkillPrompt, runPi } from './runPi';
import { bootstrapExistingSession } from '@/agent/sessionFactory';
import { PiSession } from './session';
import { RPC_METHODS } from '@hapi/protocol/rpcMethods';

describe('Pi command namespaces', () => {
    const commands = [
        { name: 'session-name', description: 'Rename session', source: 'extension' as const },
        { name: 'fix-tests', description: 'Fix tests', source: 'prompt' as const },
        { name: 'skill:brave-search', description: 'Search the web', source: 'skill' as const },
    ];

    it('exposes native skills through $ and keeps them out of slash completion', () => {
        expect(buildPiCommandInventory(commands)).toEqual({
            skills: [
                { name: 'brave-search', description: 'Search the web' },
            ],
            slashCommands: [
                { name: 'session-name', description: 'Rename session', source: 'plugin' },
                { name: 'fix-tests', description: 'Fix tests', source: 'user' },
            ],
        });
    });

    it('rewrites HAPI $ skills to Pi native skill commands', () => {
        expect(rewritePiSkillPrompt('$brave-search latest news', commands))
            .toBe('/skill:brave-search latest news');
        expect(rewritePiSkillPrompt('$new-skill now', [])).toBe('/skill:new-skill now');
        expect(rewritePiSkillPrompt('$PATH', commands)).toBe('$PATH');
    });

    it('keeps the native skill command first when the message has attachments', () => {
        expect(formatPiUserMessage('$brave-search', [{
            id: 'attachment-1',
            filename: 'query.txt',
            mimeType: 'text/plain',
            size: 5,
            path: '/tmp/query.txt',
        }], commands)).toBe('/skill:brave-search\n\nAttached file: \"/tmp/query.txt\"');
    });
});

describe('runPi startup', () => {
    beforeEach(() => {
        harness.transportOptions = null;
        harness.sent.length = 0;
        harness.throwOnGetCommands = true;
        harness.onError = null;
        harness.onEvent = null;
        harness.rpcHandlers.clear();
        harness.session.rpcHandlerManager.registerHandler.mockReset();
        harness.session.rpcHandlerManager.registerHandler.mockImplementation((method: string, handler: (payload: unknown) => Promise<unknown>) => {
            harness.rpcHandlers.set(method, handler);
        });
        harness.session.onUserMessage.mockReset();
        harness.session.onCancelQueuedMessage.mockReset();
        harness.session.emitMessagesConsumed.mockReset();
        harness.session.sendSessionEvent.mockReset();
        harness.killCount = 0;
        harness.cleanupCount = 0;
        vi.useRealTimers();
    });

    it('lets Pi create a fresh session when no resume ID is provided', async () => {
        await runPi({ workingDirectory: '/work' });

        expect(harness.transportOptions).toMatchObject({
            command: 'pi',
            args: ['--mode', 'rpc'],
            cwd: '/work',
            env: { PI_RPC_EMIT_TITLE: '1' },
        });
        expect(harness.sent).toEqual([
            { type: 'get_state' },
            { type: 'get_available_models' },
            { type: 'get_commands' },
        ]);
    });

    it('resumes with --session and keeps the session selected by Pi', async () => {
        await runPi({
            workingDirectory: '/work',
            resumeSessionId: 'pi-session-123',
        });

        expect(harness.transportOptions).toMatchObject({
            command: 'pi',
            args: ['--mode', 'rpc', '--session', 'pi-session-123'],
            cwd: '/work',
            env: { PI_RPC_EMIT_TITLE: '1' },
        });
        expect(harness.sent).toEqual([
            { type: 'get_state' },
            { type: 'get_available_models' },
            { type: 'get_commands' },
        ]);
    });

    it('bootstraps the existing HAPI row for runner native resume', async () => {
        await runPi({
            workingDirectory: '/work',
            existingSessionId: 'hapi-session-pi-1',
            resumeSessionId: 'pi-session-1',
            startedBy: 'runner',
        });

        expect(bootstrapExistingSession).toHaveBeenCalledWith({
            sessionId: 'hapi-session-pi-1',
            flavor: 'pi',
            startedBy: 'runner',
            workingDirectory: '/work',
        });
    });

    it.each([
        ['fresh', undefined, 1, 0],
        ['resume', 'pi-session-1', 0, 1],
    ] as const)('applies the startup fallback only to %s sessions', async (_label, resumeSessionId, expectedCalls, expectedKills) => {
        vi.useFakeTimers();
        harness.throwOnGetCommands = false;
        const markReady = vi.spyOn(PiSession.prototype, 'markReady');
        const running = runPi({ workingDirectory: '/work', resumeSessionId });

        await vi.advanceTimersByTimeAsync(31_000);
        expect(markReady).toHaveBeenCalledTimes(expectedCalls);
        expect(harness.cleanupCount).toBe(expectedKills);

        harness.onError?.(new Error('stop test transport'));
        await running;
        markReady.mockRestore();
    });

    it('drains the local prompt queue when a fresh-session ready fallback fires', async () => {
        vi.useFakeTimers();
        harness.throwOnGetCommands = false;
        const running = runPi({ workingDirectory: '/work' });
        await Promise.resolve();
        const onUserMessage = harness.session.onUserMessage.mock.calls.at(-1)![0] as (
            message: { role: 'user'; content: { type: 'text'; text: string } },
            localId: string
        ) => void;
        onUserMessage({ role: 'user', content: { type: 'text', text: 'queued before ready' } }, 'fallback-id');
        await Promise.resolve();
        expect(harness.sent).not.toContainEqual(expect.objectContaining({ type: 'prompt', message: 'queued before ready' }));

        await vi.advanceTimersByTimeAsync(31_000);
        expect(harness.sent).toContainEqual(expect.objectContaining({ type: 'prompt', message: 'queued before ready' }));

        harness.onError?.(new Error('stop test transport'));
        await running;
    });
});


describe('Pi abort queue boundary', () => {
    beforeEach(() => {
        harness.sent.length = 0;
        harness.throwOnGetCommands = false;
        harness.onEvent = null;
        harness.rpcHandlers.clear();
        harness.session.onUserMessage.mockReset();
        harness.session.onCancelQueuedMessage.mockReset();
        harness.session.emitMessagesConsumed.mockReset();
        harness.session.sendSessionEvent.mockReset();
        harness.session.rpcHandlerManager.registerHandler.mockReset();
        harness.session.rpcHandlerManager.registerHandler.mockImplementation((method: string, handler: (payload: unknown) => Promise<unknown>) => {
            harness.rpcHandlers.set(method, handler);
        });
    });

    it('does not send an empty prompt when every image attachment fails', async () => {
        const running = runPi({ workingDirectory: '/work' });
        await vi.waitFor(() => expect(harness.onEvent).not.toBeNull());
        harness.onEvent!({ type: 'response', command: 'get_state', success: true, data: {} });
        const onUserMessage = harness.session.onUserMessage.mock.calls.at(-1)![0] as (message: {
            role: 'user'; content: { type: 'text'; text: string; attachments: Array<{ id: string; filename: string; mimeType: string; size: number; path: string }> };
        }, localId: string) => void;
        onUserMessage({
            role: 'user',
            content: { type: 'text', text: '', attachments: [{ id: 'bad', filename: 'missing.png', mimeType: 'image/png', size: 1, path: '/missing/image.png' }] },
        }, 'missing-image-id');
        await vi.waitFor(() => expect(harness.session.sendSessionEvent).toHaveBeenCalledWith(expect.objectContaining({
            type: 'message', message: expect.stringContaining('Could not attach image missing.png'),
        })));
        expect(harness.session.emitMessagesConsumed).toHaveBeenCalledWith(['missing-image-id'], { clearQueuedThinkingGrace: true });
        expect(harness.sent).not.toContainEqual(expect.objectContaining({ type: 'prompt' }));
        harness.onError?.(new Error('finish test'));
        await running;
    });

    it('confirms abort, consumes a pre-turn prompt exactly once, then starts the next FIFO item', async () => {
        const running = runPi({ workingDirectory: '/work' });
        await vi.waitFor(() => expect(harness.onEvent).not.toBeNull());
        harness.onEvent!({ type: 'response', command: 'get_state', success: true, data: {} });

        const userMessage = (text: string) => ({ role: 'user', content: { type: 'text', text } });
        const onUserMessage = harness.session.onUserMessage.mock.calls.at(-1)![0] as (message: ReturnType<typeof userMessage>, localId: string) => void;
        onUserMessage(userMessage('first'), 'first-id');
        onUserMessage(userMessage('second'), 'second-id');
        await vi.waitFor(() => expect(harness.sent).toContainEqual(expect.objectContaining({ type: 'prompt', message: 'first' })));

        const abort = harness.rpcHandlers.get(RPC_METHODS.Abort);
        expect(abort).toBeDefined();
        const abortPromise = abort!({});
        await vi.waitFor(() => expect(harness.sent.at(-1)).toMatchObject({ type: 'abort' }));
        const command = harness.sent.at(-1) as { id: string };
        // Pi emits agent_end while session.abort() is waiting for idle, before the
        // RPC response. The next queued prompt must remain blocked until that
        // response commits the aborted prompt boundary.
        harness.onEvent!({ type: 'agent_end', messages: [], willRetry: false });
        expect(harness.sent).not.toContainEqual(expect.objectContaining({ type: 'prompt', message: 'second' }));
        harness.onEvent!({ type: 'response', id: command.id, command: 'abort', success: true });
        await expect(abortPromise).resolves.toEqual({ success: true });

        expect(harness.session.emitMessagesConsumed).toHaveBeenCalledWith(['first-id'], { clearQueuedThinkingGrace: true });
        await vi.waitFor(() => expect(harness.sent).toContainEqual(expect.objectContaining({ type: 'prompt', message: 'second' })));
        harness.onError?.(new Error('finish test'));
        await running;
    });
});

describe('Pi prompt preparation', () => {
    it('reads image attachments into Pi RPC image content while retaining safe text references', async () => {
        const { writeFile, rm } = await import('node:fs/promises');
        const { join } = await import('node:path');
        const imagePath = join(process.env.TMPDIR ?? '/tmp', `pi-image-${Date.now()}.png`);
        await writeFile(imagePath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
        try {
            const { preparePiUserMessage } = await import('./runPi');
            const prepared = await preparePiUserMessage('$brave-search explain', [
                { id: 'image', filename: 'plot.png', mimeType: 'image/png', size: 4, path: imagePath },
                { id: 'text', filename: 'notes file.txt', mimeType: 'text/plain', size: 1, path: '/tmp/notes file.txt' },
            ], [{ name: 'skill:brave-search', source: 'skill' }]);
            expect(prepared.message).toBe('/skill:brave-search explain\n\nAttached file: \"/tmp/notes file.txt\"');
            expect(prepared.images).toEqual([{ type: 'image', mimeType: 'image/png', data: 'iVBORw==' }]);
            expect(prepared.imageReadErrors).toEqual([]);
            expect(formatPiUserMessage('', [{ id: 'newline', filename: 'x', mimeType: 'text/plain', size: 1, path: '/tmp/a\nb' }], [])).toBe('Attached file: \"/tmp/a\\nb\"');
            const failed = await preparePiUserMessage('', [{ id: 'missing', filename: 'missing.png', mimeType: 'image/png', size: 1, path: '/missing/image.png' }], []);
            expect(failed).toMatchObject({ message: '', images: [] });
            expect(failed.imageReadErrors[0]).toContain('Could not attach image missing.png');
        } finally {
            await rm(imagePath, { force: true });
        }
    });
});
