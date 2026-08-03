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
        sessionId: 'hapi-session-test',
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

import { buildPiCommandInventory, failPiHistoryOnRestoreError, formatPiUserMessage, rewritePiSkillPrompt, runPi } from './runPi';
import { bootstrapExistingSession } from '@/agent/sessionFactory';
import { PiSession } from './session';
import { PiHistoryRestoreError } from './conversationHistory';
import { RPC_METHODS } from '@hapi/protocol/rpcMethods';

async function replyToHistoryCommand(type: 'get_entries' | 'get_fork_messages', occurrence: number, data: unknown): Promise<void> {
    await vi.waitFor(() => {
        expect(harness.sent.filter((item) => (item as { type?: string }).type === type)).toHaveLength(occurrence);
    });
    const command = harness.sent.filter((item) => (item as { type?: string }).type === type)[occurrence - 1] as { id: string };
    harness.onEvent!({ type: 'response', id: command.id, command: type, success: true, data });
}

async function completeHistoryBaseline(
    initialEntries: unknown[] = [],
    initialLeafId: string | null = null,
): Promise<void> {
    await replyToHistoryCommand('get_entries', 1, { entries: initialEntries, leafId: initialLeafId });
}

async function completeHistoryProbe(initialLeafId: string | null = null): Promise<void> {
    await replyToHistoryCommand('get_fork_messages', 1, { messages: [] });
    await replyToHistoryCommand('get_entries', 2, { entries: [], leafId: initialLeafId });
}

async function completeHistoryInitialization(): Promise<void> {
    await completeHistoryBaseline();
    await completeHistoryProbe();
}

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
        harness.session.updateMetadata.mockReset();
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

    it('registers native conversation fork and rewind RPC handlers', async () => {
        await runPi({ workingDirectory: '/work' });

        expect(harness.rpcHandlers.has(RPC_METHODS.ForkConversation)).toBe(true);
        expect(harness.rpcHandlers.has(RPC_METHODS.RewindConversation)).toBe(true);
    });

    it('escalates only failed source restoration to lifecycle cleanup', () => {
        const failNativeStartup = vi.fn();
        failPiHistoryOnRestoreError(new PiHistoryRestoreError('restore failed'), failNativeStartup);
        failPiHistoryOnRestoreError(new Error('ordinary fork failure'), failNativeStartup);

        expect(failNativeStartup).toHaveBeenCalledTimes(1);
        expect(failNativeStartup).toHaveBeenCalledWith(expect.any(PiHistoryRestoreError));
    });

    it.each([
        ['fresh', undefined],
        ['resume', 'pi-session-1'],
    ] as const)('applies the startup fallback only to %s sessions', async (_label, resumeSessionId) => {
        vi.useFakeTimers();
        harness.throwOnGetCommands = false;
        const markReady = vi.spyOn(PiSession.prototype, 'markReady');
        const running = runPi({ workingDirectory: '/work', resumeSessionId });

        await vi.advanceTimersByTimeAsync(31_000);
        if (resumeSessionId) {
            expect(markReady).not.toHaveBeenCalled();
            expect(harness.cleanupCount).toBe(1);
        } else {
            expect(markReady).not.toHaveBeenCalled();
            await completeHistoryBaseline();
            await vi.advanceTimersByTimeAsync(0);
            expect(markReady).toHaveBeenCalledTimes(1);
            expect(harness.cleanupCount).toBe(0);
        }

        harness.onError?.(new Error('stop test transport'));
        await running;
        markReady.mockRestore();
    });

    it('establishes the history baseline before a fresh-session fallback drains prompts', async () => {
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
        expect(harness.sent).not.toContainEqual(expect.objectContaining({ type: 'prompt', message: 'queued before ready' }));
        await completeHistoryBaseline([
            { id: 'old-native-user', type: 'message', message: { role: 'user' } },
        ], 'old-native-user');
        await vi.advanceTimersByTimeAsync(0);
        expect(harness.sent).toContainEqual(expect.objectContaining({ type: 'prompt', message: 'queued before ready' }));
        let preNativeMetadata: Record<string, unknown> = {};
        for (const [updater] of harness.session.updateMetadata.mock.calls) {
            if (typeof updater === 'function') preNativeMetadata = updater(preNativeMetadata);
        }
        expect(preNativeMetadata).not.toMatchObject({ capabilities: { conversationHistory: expect.anything() } });

        const prompt = harness.sent.find((item) => (item as { type?: string }).type === 'prompt') as { id: string };
        harness.onEvent!({
            type: 'response', command: 'get_state', success: true,
            data: { sessionId: 'late-session', sessionFile: '/tmp/late-session.jsonl' },
        });
        await completeHistoryProbe('old-native-user');
        harness.onEvent!({ type: 'response', id: prompt.id, command: 'prompt', success: true });
        harness.onEvent!({ type: 'turn_start' });
        await vi.waitFor(() => expect(harness.sent.filter((item) => (item as { type?: string }).type === 'get_entries')).toHaveLength(3));
        const incremental = harness.sent.filter((item) => (item as { type?: string }).type === 'get_entries')[2] as { id: string };
        harness.onEvent!({
            type: 'response', id: incremental.id, command: 'get_entries', success: true,
            data: { entries: [{ id: 'new-native-user', type: 'message', message: { role: 'user' } }], leafId: 'new-native-user' },
        });
        await vi.advanceTimersByTimeAsync(0);
        let metadata: Record<string, unknown> = {};
        for (const [updater] of harness.session.updateMetadata.mock.calls) {
            if (typeof updater === 'function') metadata = updater(metadata);
        }
        expect(metadata).toMatchObject({
            capabilities: { conversationHistory: expect.anything() },
            conversationHistoryEntryIds: { 'fallback-id': 'new-native-user' },
        });

        harness.onError?.(new Error('stop test transport'));
        await running;
    });

    it('does not drain a fallback prompt when cleanup races a late native-ready preparation', async () => {
        vi.useFakeTimers();
        harness.throwOnGetCommands = false;
        const markReady = vi.spyOn(PiSession.prototype, 'markReady');
        const running = runPi({ workingDirectory: '/work' });
        await vi.advanceTimersByTimeAsync(0);
        const onUserMessage = harness.session.onUserMessage.mock.calls.at(-1)![0] as (
            message: { role: 'user'; content: { type: 'text'; text: string } },
            localId: string
        ) => void;
        onUserMessage({ role: 'user', content: { type: 'text', text: 'must not drain' } }, 'cleanup-race-id');
        await vi.advanceTimersByTimeAsync(31_000);
        expect(harness.sent).toContainEqual(expect.objectContaining({ type: 'get_entries' }));

        harness.onEvent!({
            type: 'response', command: 'get_state', success: true,
            data: { sessionId: 'late-session', sessionFile: '/tmp/late-session.jsonl' },
        });
        harness.onError?.(new Error('transport failed during history baseline'));
        await Promise.resolve();
        await Promise.resolve();
        await running;

        expect(markReady).not.toHaveBeenCalled();
        expect(harness.sent).not.toContainEqual(expect.objectContaining({ type: 'prompt', message: 'must not drain' }));
        markReady.mockRestore();
    });
});


describe('Pi abort queue boundary', () => {
    beforeEach(() => {
        vi.useRealTimers();
        harness.sent.length = 0;
        harness.throwOnGetCommands = false;
        harness.onEvent = null;
        harness.rpcHandlers.clear();
        harness.session.onUserMessage.mockReset();
        harness.session.onCancelQueuedMessage.mockReset();
        harness.session.emitMessagesConsumed.mockReset();
        harness.session.sendSessionEvent.mockReset();
        harness.session.updateMetadata.mockReset();
        harness.cleanupCount = 0;
        harness.killCount = 0;
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

    it('short-circuits a canceled queued preparation before attachment I/O', async () => {
        const running = runPi({ workingDirectory: '/work' });
        await vi.waitFor(() => expect(harness.onEvent).not.toBeNull());
        harness.onEvent!({ type: 'response', command: 'get_state', success: true, data: {} });
        await completeHistoryInitialization();
        let pathReads = 0;
        const attachment = {
            id: 'cancel-image', filename: 'cancel.png', mimeType: 'image/png', size: 4,
            get path() { pathReads += 1; return '/etc/hosts'; },
        };
        const onUserMessage = harness.session.onUserMessage.mock.calls.at(-1)![0] as (message: any, localId: string) => void;
        const cancelQueued = harness.session.onCancelQueuedMessage.mock.calls.at(-1)![0] as (localId: string) => boolean;

        onUserMessage({ role: 'user', content: { type: 'text', text: '', attachments: [attachment] } }, 'cancel-id');
        expect(cancelQueued('cancel-id')).toBe(true);
        onUserMessage({ role: 'user', content: { type: 'text', text: 'next valid prompt' } }, 'next-id');
        await vi.waitFor(() => expect(harness.sent).toContainEqual(expect.objectContaining({ type: 'prompt', message: 'next valid prompt' })));

        expect(pathReads).toBe(0);
        expect(harness.sent).not.toContainEqual(expect.objectContaining({ type: 'prompt', message: '' }));
        harness.onError?.(new Error('finish test'));
        await running;
    });

    it('does not pump the next prompt when cleanup rejects a pending settlement sync', async () => {
        const running = runPi({ workingDirectory: '/work' });
        await vi.waitFor(() => expect(harness.onEvent).not.toBeNull());
        harness.onEvent!({ type: 'response', command: 'get_state', success: true, data: {} });
        await completeHistoryInitialization();

        const userMessage = (text: string) => ({ role: 'user', content: { type: 'text', text } });
        const onUserMessage = harness.session.onUserMessage.mock.calls.at(-1)![0] as (message: ReturnType<typeof userMessage>, localId: string) => void;
        onUserMessage(userMessage('first'), 'first-id');
        onUserMessage(userMessage('second'), 'second-id');
        await vi.waitFor(() => expect(harness.sent).toContainEqual(expect.objectContaining({ type: 'prompt', message: 'first' })));
        const firstPrompt = harness.sent.find((item) => (item as { type?: string; message?: string }).type === 'prompt') as { id: string };
        harness.onEvent!({ type: 'response', id: firstPrompt.id, command: 'prompt', success: true });
        harness.onEvent!({ type: 'agent_start' });
        harness.onEvent!({ type: 'agent_settled' });
        await vi.waitFor(() => expect(harness.sent.filter((item) => (item as { type?: string }).type === 'get_entries')).toHaveLength(3));

        harness.onError?.(new Error('transport failed during settlement sync'));
        await Promise.resolve();
        await Promise.resolve();
        await running;

        expect(harness.sent).not.toContainEqual(expect.objectContaining({ type: 'prompt', message: 'second' }));
    });

    it('compensates a preflight abort when the prompt starts late, then releases the FIFO once settled', async () => {
        const running = runPi({ workingDirectory: '/work' });
        await vi.waitFor(() => expect(harness.onEvent).not.toBeNull());
        harness.onEvent!({ type: 'response', command: 'get_state', success: true, data: {} });
        await completeHistoryInitialization();

        const userMessage = (text: string) => ({ role: 'user', content: { type: 'text', text } });
        const onUserMessage = harness.session.onUserMessage.mock.calls.at(-1)![0] as (message: ReturnType<typeof userMessage>, localId: string) => void;
        onUserMessage(userMessage('first'), 'first-id');
        onUserMessage(userMessage('second'), 'second-id');
        await vi.waitFor(() => expect(harness.sent).toContainEqual(expect.objectContaining({ type: 'prompt', message: 'first' })));
        const promptCommand = harness.sent.find((item) => (item as { type?: string; message?: string }).type === 'prompt') as { id: string };

        const abort = harness.rpcHandlers.get(RPC_METHODS.Abort);
        expect(abort).toBeDefined();
        const abortPromise = abort!({});
        await vi.waitFor(() => expect(harness.sent.filter((item) => (item as { type?: string }).type === 'abort')).toHaveLength(1));
        const firstAbort = harness.sent.filter((item) => (item as { type?: string }).type === 'abort')[0] as { id: string };
        harness.onEvent!({ type: 'response', id: firstAbort.id, command: 'abort', success: true });

        // Pi 0.83 may acknowledge abort while prompt preflight is still running.
        // A later agent_start must issue one compensating abort and keep the next
        // FIFO item blocked until both the real settlement and compensation ack.
        harness.onEvent!({ type: 'response', id: promptCommand.id, command: 'prompt', success: true });
        let abortResolved = false;
        void abortPromise.then(() => { abortResolved = true; });
        await new Promise((resolve) => setTimeout(resolve, 1_100));
        expect(abortResolved).toBe(false);
        expect(harness.sent).not.toContainEqual(expect.objectContaining({ type: 'prompt', message: 'second' }));
        harness.onEvent!({ type: 'agent_start' });
        await vi.waitFor(() => expect(harness.sent.filter((item) => (item as { type?: string }).type === 'abort')).toHaveLength(2));
        const compensatingAbort = harness.sent.filter((item) => (item as { type?: string }).type === 'abort')[1] as { id: string };
        expect(harness.sent).not.toContainEqual(expect.objectContaining({ type: 'prompt', message: 'second' }));

        harness.onEvent!({ type: 'agent_end', messages: [], willRetry: false });
        harness.onEvent!({ type: 'agent_settled' });
        await vi.waitFor(() => expect(harness.sent.filter((item) => (item as { type?: string }).type === 'get_entries')).toHaveLength(3));
        const settlementSync = harness.sent.filter((item) => (item as { type?: string }).type === 'get_entries')[2] as { id: string };
        harness.onEvent!({ type: 'response', id: settlementSync.id, command: 'get_entries', success: true, data: { entries: [], leafId: null } });
        // agent_settled requested another read while the command-only fallback
        // sync was in flight, so the history layer serializes one follow-up.
        await vi.waitFor(() => expect(harness.sent.filter((item) => (item as { type?: string }).type === 'get_entries')).toHaveLength(4));
        const followUpSync = harness.sent.filter((item) => (item as { type?: string }).type === 'get_entries')[3] as { id: string };
        harness.onEvent!({ type: 'response', id: followUpSync.id, command: 'get_entries', success: true, data: { entries: [], leafId: null } });
        harness.onEvent!({ type: 'response', id: compensatingAbort.id, command: 'abort', success: true });
        await expect(abortPromise).resolves.toEqual({ success: true });

        expect(harness.session.emitMessagesConsumed).toHaveBeenCalledWith(['first-id'], { clearQueuedThinkingGrace: true });
        await vi.waitFor(() => expect(harness.sent).toContainEqual(expect.objectContaining({ type: 'prompt', message: 'second' })));
        harness.onError?.(new Error('finish test'));
        await running;
    });

    it('keeps the preflight guard when no-active abort rejection arrives before lifecycle fallback', async () => {
        const running = runPi({ workingDirectory: '/work' });
        await vi.waitFor(() => expect(harness.onEvent).not.toBeNull());
        harness.onEvent!({ type: 'response', command: 'get_state', success: true, data: {} });
        await completeHistoryInitialization();

        const userMessage = (text: string) => ({ role: 'user', content: { type: 'text', text } });
        const onUserMessage = harness.session.onUserMessage.mock.calls.at(-1)![0] as (message: ReturnType<typeof userMessage> & {
            meta?: { deliveryMode?: 'queue' | 'steer' };
        }, localId: string) => void;
        onUserMessage(userMessage('late preflight'), 'late-id');
        await vi.waitFor(() => expect(harness.sent).toContainEqual(expect.objectContaining({ type: 'prompt', message: 'late preflight' })));
        const promptCommand = harness.sent.find((item) => (item as { type?: string; message?: string }).type === 'prompt') as { id: string };
        // Preserve the preflight/no-lifecycle shape while making the native
        // streaming generation observable to a steer queued behind abort.
        harness.onEvent!({ type: 'response', command: 'get_state', success: true, data: { isStreaming: true } });

        const abort = harness.rpcHandlers.get(RPC_METHODS.Abort)!;
        const abortPromise = abort({});
        await vi.waitFor(() => expect(harness.sent.filter((item) => (item as { type?: string }).type === 'abort')).toHaveLength(1));
        const firstAbort = harness.sent.filter((item) => (item as { type?: string }).type === 'abort')[0] as { id: string };
        onUserMessage({
            ...userMessage('after abort'),
            meta: { deliveryMode: 'steer' },
        }, 'post-abort-steer');

        // Pi rejects before the 1s lifecycle-missing fallback observes that the
        // prompt is still in preflight. The guard must remain installed so a
        // later agent_start can still trigger the compensating abort.
        harness.onEvent!({ type: 'response', id: firstAbort.id, command: 'abort', success: false, error: 'No active agent to abort' });
        let abortResolved = false;
        void abortPromise.then(() => { abortResolved = true; });
        await Promise.resolve();
        await Promise.resolve();
        expect(abortResolved).toBe(false);
        expect(harness.sent).not.toContainEqual(expect.objectContaining({ type: 'prompt', message: 'after abort' }));
        expect(harness.sent.some((item) => (item as { type?: string }).type === 'steer')).toBe(false);

        harness.onEvent!({ type: 'response', id: promptCommand.id, command: 'prompt', success: true });
        harness.onEvent!({ type: 'agent_start' });
        await vi.waitFor(() => expect(harness.sent.filter((item) => (item as { type?: string }).type === 'abort')).toHaveLength(2));
        const compensatingAbort = harness.sent.filter((item) => (item as { type?: string }).type === 'abort')[1] as { id: string };

        harness.onEvent!({ type: 'agent_end', messages: [], willRetry: false });
        harness.onEvent!({ type: 'agent_settled' });
        await vi.waitFor(() => expect(harness.sent.filter((item) => (item as { type?: string }).type === 'get_entries')).toHaveLength(3));
        const settlementSync = harness.sent.filter((item) => (item as { type?: string }).type === 'get_entries')[2] as { id: string };
        harness.onEvent!({ type: 'response', id: settlementSync.id, command: 'get_entries', success: true, data: { entries: [], leafId: null } });
        harness.onEvent!({ type: 'response', id: compensatingAbort.id, command: 'abort', success: true });

        await expect(abortPromise).resolves.toEqual({ success: true });
        await vi.waitFor(() => expect(harness.sent).toContainEqual(expect.objectContaining({ type: 'prompt', message: 'after abort' })));
        expect(harness.sent.some((item) => (item as { type?: string }).type === 'steer')).toBe(false);

        harness.onError?.(new Error('finish test'));
        await running;
    });

    it('installs the abort barrier before waiting for a config mutation and never aborts the next prompt', async () => {
        const running = runPi({ workingDirectory: '/work' });
        await vi.waitFor(() => expect(harness.onEvent).not.toBeNull());
        harness.onEvent!({ type: 'response', command: 'get_state', success: true, data: {} });
        await completeHistoryInitialization();

        const userMessage = (text: string) => ({ role: 'user', content: { type: 'text', text } });
        const onUserMessage = harness.session.onUserMessage.mock.calls.at(-1)![0] as (message: ReturnType<typeof userMessage>, localId: string) => void;
        onUserMessage(userMessage('first'), 'first-id');
        onUserMessage(userMessage('second'), 'second-id');
        await vi.waitFor(() => expect(harness.sent).toContainEqual(expect.objectContaining({ type: 'prompt', message: 'first' })));
        const promptCommand = harness.sent.find((item) => (item as { type?: string; message?: string }).type === 'prompt') as { id: string };
        harness.onEvent!({ type: 'response', id: promptCommand.id, command: 'prompt', success: true });
        harness.onEvent!({ type: 'agent_start' });

        const setConfig = harness.rpcHandlers.get(RPC_METHODS.SetSessionConfig)!;
        const configPromise = setConfig({ model: { provider: 'provider', modelId: 'model' } });
        await vi.waitFor(() => expect(harness.sent).toContainEqual(expect.objectContaining({ type: 'set_model' })));
        const setModelCommand = harness.sent.find((item) => (item as { type?: string }).type === 'set_model') as { id: string };

        const abort = harness.rpcHandlers.get(RPC_METHODS.Abort)!;
        const abortPromise = abort({});
        harness.onEvent!({ type: 'agent_end', messages: [], willRetry: false });
        harness.onEvent!({ type: 'agent_settled' });
        await vi.waitFor(() => expect(harness.sent.filter((item) => (item as { type?: string }).type === 'get_entries')).toHaveLength(3));
        const settlementSync = harness.sent.filter((item) => (item as { type?: string }).type === 'get_entries')[2] as { id: string };
        harness.onEvent!({ type: 'response', id: settlementSync.id, command: 'get_entries', success: true, data: { entries: [], leafId: null } });
        await new Promise((resolve) => setTimeout(resolve, 0));

        expect(harness.sent.filter((item) => (item as { type?: string }).type === 'abort')).toHaveLength(0);
        expect(harness.sent).not.toContainEqual(expect.objectContaining({ type: 'prompt', message: 'second' }));

        harness.onEvent!({
            type: 'response', id: setModelCommand.id, command: 'set_model', success: true,
            data: { id: 'model', provider: 'provider' },
        });
        await expect(configPromise).resolves.toMatchObject({ applied: { model: { provider: 'provider', modelId: 'model' } } });
        await expect(abortPromise).resolves.toEqual({ success: true });
        expect(harness.sent.filter((item) => (item as { type?: string }).type === 'abort')).toHaveLength(0);
        await vi.waitFor(() => expect(harness.sent).toContainEqual(expect.objectContaining({ type: 'prompt', message: 'second' })));

        harness.onError?.(new Error('finish test'));
        await running;
    });

    it('keeps a command-only abort guard after an ordinary abort error until the stability deadline', async () => {
        const running = runPi({ workingDirectory: '/work' });
        await vi.waitFor(() => expect(harness.onEvent).not.toBeNull());
        harness.onEvent!({ type: 'response', command: 'get_state', success: true, data: {} });
        await completeHistoryInitialization();

        const userMessage = (text: string) => ({ role: 'user', content: { type: 'text', text } });
        const onUserMessage = harness.session.onUserMessage.mock.calls.at(-1)![0] as (message: ReturnType<typeof userMessage>, localId: string) => void;
        onUserMessage(userMessage('command-only'), 'command-id');
        onUserMessage(userMessage('next'), 'next-id');
        await vi.waitFor(() => expect(harness.sent).toContainEqual(expect.objectContaining({ type: 'prompt', message: 'command-only' })));
        const promptCommand = harness.sent.find((item) => (item as { type?: string; message?: string }).type === 'prompt') as { id: string };

        vi.useFakeTimers();
        const abort = harness.rpcHandlers.get(RPC_METHODS.Abort)!;
        const abortPromise = abort({});
        await Promise.resolve();
        await Promise.resolve();
        await vi.advanceTimersByTimeAsync(0);
        const abortCommand = harness.sent.find((item) => (item as { type?: string }).type === 'abort') as { id: string };
        expect(abortCommand).toBeDefined();
        harness.onEvent!({ type: 'response', id: promptCommand.id, command: 'prompt', success: true });
        await vi.advanceTimersByTimeAsync(1_000);
        const fallbackSync = harness.sent.filter((item) => (item as { type?: string }).type === 'get_entries')[2] as { id: string };
        expect(fallbackSync).toBeDefined();
        harness.onEvent!({ type: 'response', id: fallbackSync.id, command: 'get_entries', success: true, data: { entries: [], leafId: null } });
        await vi.advanceTimersByTimeAsync(0);
        harness.onEvent!({ type: 'response', id: abortCommand.id, command: 'abort', success: false, error: 'No active agent to abort' });
        await Promise.resolve();
        expect(harness.sent).not.toContainEqual(expect.objectContaining({ type: 'prompt', message: 'next' }));

        await vi.advanceTimersByTimeAsync(24_000);
        await expect(abortPromise).resolves.toEqual({ success: true });
        expect(harness.sent).toContainEqual(expect.objectContaining({ type: 'prompt', message: 'next' }));
        vi.useRealTimers();

        harness.onError?.(new Error('finish test'));
        await running;
    });

    it('still sends native abort when Pi is streaming without a local prompt boundary', async () => {
        const running = runPi({ workingDirectory: '/work' });
        await vi.waitFor(() => expect(harness.onEvent).not.toBeNull());
        harness.onEvent!({ type: 'response', command: 'get_state', success: true, data: { isStreaming: true } });
        await completeHistoryInitialization();

        const abort = harness.rpcHandlers.get(RPC_METHODS.Abort)!;
        const abortPromise = abort({});
        await vi.waitFor(() => expect(harness.sent.filter((item) => (item as { type?: string }).type === 'abort')).toHaveLength(1));
        const abortCommand = harness.sent.find((item) => (item as { type?: string }).type === 'abort') as { id: string };

        // A steer arriving behind the abort mutation targets the generation
        // being aborted. Abort success must invalidate it before releasing the
        // mutex so the message becomes an ordinary prompt instead of entering
        // Pi's now-idle native steer queue.
        const onUserMessage = harness.session.onUserMessage.mock.calls.at(-1)![0] as (message: {
            role: 'user';
            content: { type: 'text'; text: string };
            meta?: { deliveryMode?: 'queue' | 'steer' };
        }, localId: string) => void;
        onUserMessage({
            role: 'user',
            content: { type: 'text', text: 'after abort' },
            meta: { deliveryMode: 'steer' },
        }, 'post-abort-steer');

        harness.onEvent!({ type: 'response', id: abortCommand.id, command: 'abort', success: true });

        await expect(abortPromise).resolves.toEqual({ success: true });
        expect(harness.session.keepAlive).toHaveBeenLastCalledWith(false, 'remote', undefined);
        await vi.waitFor(() => expect(harness.sent).toContainEqual(expect.objectContaining({
            type: 'prompt', message: 'after abort',
        })));
        expect(harness.sent.some((item) => (item as { type?: string }).type === 'steer')).toBe(false);

        harness.onError?.(new Error('finish test'));
        await running;
    });

    it('fails closed and poisons the mutation lease when configuration times out', async () => {
        const running = runPi({ workingDirectory: '/work' });
        await vi.waitFor(() => expect(harness.onEvent).not.toBeNull());
        harness.onEvent!({ type: 'response', command: 'get_state', success: true, data: {} });
        await completeHistoryInitialization();

        vi.useFakeTimers();
        const setConfig = harness.rpcHandlers.get(RPC_METHODS.SetSessionConfig)!;
        const configPromise = setConfig({ model: { provider: 'provider', modelId: 'model' } });
        const configRejection = expect(configPromise).rejects.toThrow('timed out');
        await vi.advanceTimersByTimeAsync(0);
        expect(harness.sent).toContainEqual(expect.objectContaining({ type: 'set_model', provider: 'provider', modelId: 'model' }));

        await vi.advanceTimersByTimeAsync(10_000);
        await configRejection;
        await Promise.resolve();
        expect(harness.cleanupCount).toBe(1);
        vi.useRealTimers();

        await running;
    });

    it('fails closed when the detached startup effort mutation times out', async () => {
        vi.useFakeTimers();
        const running = runPi({ workingDirectory: '/work', effort: 'high' });
        await vi.advanceTimersByTimeAsync(0);
        await Promise.resolve();
        expect(harness.sent).toContainEqual(expect.objectContaining({ type: 'set_thinking_level', level: 'high' }));

        await vi.advanceTimersByTimeAsync(10_000);
        await Promise.resolve();
        expect(harness.cleanupCount).toBe(1);
        const setConfig = harness.rpcHandlers.get(RPC_METHODS.SetSessionConfig)!;
        const blockedConfig = setConfig({ model: { provider: 'provider', modelId: 'model' } });
        void blockedConfig.catch(() => {});
        await vi.advanceTimersByTimeAsync(0);
        expect(harness.sent).not.toContainEqual(expect.objectContaining({ type: 'set_model' }));
        vi.useRealTimers();

        await running;
    });

    it('settles consecutive command-only prompts without stamping the old timer onto the next generation', async () => {
        const running = runPi({ workingDirectory: '/work' });
        await vi.waitFor(() => expect(harness.onEvent).not.toBeNull());
        harness.onEvent!({ type: 'response', command: 'get_state', success: true, data: {} });
        await completeHistoryInitialization();

        const userMessage = (text: string) => ({ role: 'user', content: { type: 'text', text } });
        const onUserMessage = harness.session.onUserMessage.mock.calls.at(-1)![0] as (message: ReturnType<typeof userMessage>, localId: string) => void;
        onUserMessage(userMessage('command-a'), 'command-a-id');
        onUserMessage(userMessage('command-b'), 'command-b-id');
        await vi.waitFor(() => expect(harness.sent).toContainEqual(expect.objectContaining({ type: 'prompt', message: 'command-a' })));

        vi.useFakeTimers();
        const firstPrompt = harness.sent.find((item) => (item as { type?: string; message?: string }).type === 'prompt') as { id: string };
        harness.onEvent!({ type: 'response', id: firstPrompt.id, command: 'prompt', success: true });
        await vi.advanceTimersByTimeAsync(1_000);
        const firstFallbackSync = harness.sent.filter((item) => (item as { type?: string }).type === 'get_entries')[2] as { id: string };
        expect(firstFallbackSync).toBeDefined();
        harness.onEvent!({ type: 'response', id: firstFallbackSync.id, command: 'get_entries', success: true, data: { entries: [], leafId: null } });
        await vi.advanceTimersByTimeAsync(0);
        const promptsAfterFirst = harness.sent.filter((item) => (item as { type?: string }).type === 'prompt') as Array<{ id: string; message: string }>;
        expect(promptsAfterFirst.map((item) => item.message)).toEqual(['command-a', 'command-b']);

        const secondPrompt = promptsAfterFirst[1]!;
        harness.onEvent!({ type: 'response', id: secondPrompt.id, command: 'prompt', success: true });
        await vi.advanceTimersByTimeAsync(1_000);
        const secondFallbackSync = harness.sent.filter((item) => (item as { type?: string }).type === 'get_entries')[3] as { id: string };
        expect(secondFallbackSync).toBeDefined();
        harness.onEvent!({ type: 'response', id: secondFallbackSync.id, command: 'get_entries', success: true, data: { entries: [], leafId: null } });
        await vi.advanceTimersByTimeAsync(0);
        onUserMessage(userMessage('command-c'), 'command-c-id');
        await Promise.resolve();
        await vi.advanceTimersByTimeAsync(0);
        expect(harness.sent).toContainEqual(expect.objectContaining({ type: 'prompt', message: 'command-c' }));
        vi.useRealTimers();

        harness.onError?.(new Error('finish test'));
        await running;
    });

    it('syncs a command-only append before registering the following prompt history entry', async () => {
        const running = runPi({ workingDirectory: '/work' });
        await vi.waitFor(() => expect(harness.onEvent).not.toBeNull());
        harness.onEvent!({ type: 'response', command: 'get_state', success: true, data: {} });
        await completeHistoryInitialization();

        const userMessage = (text: string) => ({ role: 'user', content: { type: 'text', text } });
        const onUserMessage = harness.session.onUserMessage.mock.calls.at(-1)![0] as (message: ReturnType<typeof userMessage>, localId: string) => void;
        onUserMessage(userMessage('command-only'), 'command-local');
        onUserMessage(userMessage('following prompt'), 'following-local');
        await vi.waitFor(() => expect(harness.sent).toContainEqual(expect.objectContaining({ type: 'prompt', message: 'command-only' })));

        vi.useFakeTimers();
        const commandPrompt = harness.sent.find((item) => (item as { type?: string; message?: string }).type === 'prompt') as { id: string };
        harness.onEvent!({ type: 'response', id: commandPrompt.id, command: 'prompt', success: true });
        await vi.advanceTimersByTimeAsync(1_000);

        // No entry_appended event arrives. The compatibility fallback must
        // read Pi's append log and bind this entry before command-local is
        // retired and the following prompt is allowed to start.
        const commandSync = harness.sent.filter((item) => (item as { type?: string }).type === 'get_entries')[2] as { id: string };
        expect(commandSync).toBeDefined();
        expect(harness.sent).not.toContainEqual(expect.objectContaining({ type: 'prompt', message: 'following prompt' }));
        harness.onEvent!({
            type: 'response', id: commandSync.id, command: 'get_entries', success: true,
            data: { entries: [{ id: 'native-command', type: 'message', message: { role: 'user' } }], leafId: 'native-command' },
        });
        await vi.advanceTimersByTimeAsync(0);

        const prompts = harness.sent.filter((item) => (item as { type?: string }).type === 'prompt') as Array<{ id: string; message: string }>;
        expect(prompts.map((prompt) => prompt.message)).toEqual(['command-only', 'following prompt']);
        const followingPrompt = prompts[1]!;
        harness.onEvent!({ type: 'response', id: followingPrompt.id, command: 'prompt', success: true });
        harness.onEvent!({ type: 'agent_start' });
        harness.onEvent!({ type: 'turn_start' });
        const followingSync = harness.sent.filter((item) => (item as { type?: string }).type === 'get_entries')[3] as { id: string };
        expect(followingSync).toBeDefined();
        harness.onEvent!({
            type: 'response', id: followingSync.id, command: 'get_entries', success: true,
            data: { entries: [{ id: 'native-following', type: 'message', message: { role: 'user' } }], leafId: 'native-following' },
        });
        await vi.advanceTimersByTimeAsync(0);

        let metadata: Record<string, unknown> = {};
        for (const [updater] of harness.session.updateMetadata.mock.calls) {
            if (typeof updater === 'function') metadata = updater(metadata);
        }
        expect(metadata).toMatchObject({
            conversationHistoryEntryIds: {
                'command-local': 'native-command',
                'following-local': 'native-following',
            },
        });
        vi.useRealTimers();

        harness.onError?.(new Error('finish test'));
        await running;
    });

    it('fails closed without starting the next prompt when command-only history sync fails', async () => {
        const running = runPi({ workingDirectory: '/work' });
        await vi.waitFor(() => expect(harness.onEvent).not.toBeNull());
        harness.onEvent!({ type: 'response', command: 'get_state', success: true, data: {} });
        await completeHistoryInitialization();

        const userMessage = (text: string) => ({ role: 'user', content: { type: 'text', text } });
        const onUserMessage = harness.session.onUserMessage.mock.calls.at(-1)![0] as (message: ReturnType<typeof userMessage>, localId: string) => void;
        onUserMessage(userMessage('command-only'), 'command-local');
        onUserMessage(userMessage('must remain blocked'), 'following-local');
        await vi.waitFor(() => expect(harness.sent).toContainEqual(expect.objectContaining({ type: 'prompt', message: 'command-only' })));

        vi.useFakeTimers();
        const commandPrompt = harness.sent.find((item) => (item as { type?: string; message?: string }).type === 'prompt') as { id: string };
        harness.onEvent!({ type: 'response', id: commandPrompt.id, command: 'prompt', success: true });
        await vi.advanceTimersByTimeAsync(1_000);
        const commandSync = harness.sent.filter((item) => (item as { type?: string }).type === 'get_entries')[2] as { id: string };
        expect(commandSync).toBeDefined();
        harness.onEvent!({ type: 'response', id: commandSync.id, command: 'get_entries', success: false, error: 'temporary read failure' });
        await vi.advanceTimersByTimeAsync(0);

        expect(harness.sent).not.toContainEqual(expect.objectContaining({ type: 'prompt', message: 'must remain blocked' }));
        expect(harness.session.emitMessagesConsumed).not.toHaveBeenCalledWith(
            ['command-local'],
            expect.anything(),
        );
        expect(harness.cleanupCount).toBe(1);
        vi.useRealTimers();
        await running;
    });
});

describe('Pi native steering delivery mode', () => {
    beforeEach(() => {
        harness.sent.length = 0;
        harness.throwOnGetCommands = false;
        harness.onEvent = null;
        harness.rpcHandlers.clear();
        harness.session.onUserMessage.mockReset();
        harness.session.onCancelQueuedMessage.mockReset();
        harness.session.emitMessagesConsumed.mockReset();
        harness.session.sendSessionEvent.mockReset();
        harness.session.updateMetadata.mockReset();
        harness.cleanupCount = 0;
        harness.killCount = 0;
        harness.session.rpcHandlerManager.registerHandler.mockReset();
        harness.session.rpcHandlerManager.registerHandler.mockImplementation((method: string, handler: (payload: unknown) => Promise<unknown>) => {
            harness.rpcHandlers.set(method, handler);
        });
    });

    it('routes explicit steer messages natively while streaming and retains explicit queue FIFO', async () => {
        const running = runPi({ workingDirectory: '/work' });
        await vi.waitFor(() => expect(harness.onEvent).not.toBeNull());
        harness.onEvent!({
            type: 'response', command: 'get_state', success: true,
            data: { sessionId: 'pi-steering-session', sessionFile: '/tmp/pi-steering.jsonl', isStreaming: true },
        });
        await completeHistoryInitialization();

        const onUserMessage = harness.session.onUserMessage.mock.calls.at(-1)![0] as (message: {
            role: 'user';
            content: { type: 'text'; text: string };
            meta?: { deliveryMode?: 'queue' | 'steer' };
        }, localId: string) => void;
        onUserMessage({
            role: 'user',
            content: { type: 'text', text: 'steer the active turn' },
            meta: { deliveryMode: 'steer' },
        }, 'native-steer-id');
        onUserMessage({
            role: 'user',
            content: { type: 'text', text: 'keep this in the normal queue' },
            meta: { deliveryMode: 'queue' },
        }, 'queue-id');

        await vi.waitFor(() => expect(harness.sent).toContainEqual(expect.objectContaining({
            type: 'steer', message: 'steer the active turn',
        })));
        expect(harness.sent).not.toContainEqual(expect.objectContaining({
            type: 'prompt', message: 'keep this in the normal queue',
        }));
        const steer = harness.sent.find((item) => (item as { type?: string }).type === 'steer') as { id: string };
        harness.onEvent!({ type: 'response', id: steer.id, command: 'steer', success: true });
        await vi.waitFor(() => expect(harness.session.emitMessagesConsumed).toHaveBeenCalledWith(['native-steer-id'], undefined));

        // The main turn ending releases only the explicit queue mode. The steer
        // response itself never changes Pi's main streaming/thinking state.
        harness.onEvent!({
            type: 'response', command: 'get_state', success: true,
            data: { sessionId: 'pi-steering-session', sessionFile: '/tmp/pi-steering.jsonl', isStreaming: false },
        });
        await vi.waitFor(() => expect(harness.sent).toContainEqual(expect.objectContaining({
            type: 'prompt', message: 'keep this in the normal queue',
        })));

        harness.onError?.(new Error('finish test'));
        await running;
    });

    it('does not steer a later streaming generation and preserves fallback arrival order', async () => {
        const running = runPi({ workingDirectory: '/work' });
        await vi.waitFor(() => expect(harness.onEvent).not.toBeNull());
        harness.onEvent!({
            type: 'response', command: 'get_state', success: true,
            data: { sessionId: 'pi-steering-session', sessionFile: '/tmp/pi-steering.jsonl', isStreaming: true },
        });
        await completeHistoryInitialization();

        // Hold the shared mutation lock, then simulate turn A ending and turn B
        // starting before the queued steer can reach Pi.
        const setConfig = harness.rpcHandlers.get(RPC_METHODS.SetSessionConfig)!;
        const configRequest = setConfig({ effort: 'low' });
        await vi.waitFor(() => expect(harness.sent).toContainEqual(expect.objectContaining({ type: 'set_thinking_level' })));
        const setThinking = harness.sent.find((item) => (item as { type?: string }).type === 'set_thinking_level') as { id: string };

        const onUserMessage = harness.session.onUserMessage.mock.calls.at(-1)![0] as (message: {
            role: 'user';
            content: { type: 'text'; text: string };
            meta?: { deliveryMode?: 'queue' | 'steer' };
        }, localId: string) => void;
        onUserMessage({
            role: 'user',
            content: { type: 'text', text: 'earlier steer fallback' },
            meta: { deliveryMode: 'steer' },
        }, 'steer-id');
        onUserMessage({
            role: 'user',
            content: { type: 'text', text: 'later ordinary prompt' },
            meta: { deliveryMode: 'queue' },
        }, 'queue-id');

        harness.onEvent!({
            type: 'response', command: 'get_state', success: true,
            data: { sessionId: 'pi-steering-session', sessionFile: '/tmp/pi-steering.jsonl', isStreaming: false },
        });
        harness.onEvent!({
            type: 'response', command: 'get_state', success: true,
            data: { sessionId: 'pi-steering-session', sessionFile: '/tmp/pi-steering.jsonl', isStreaming: true },
        });
        harness.onEvent!({ type: 'response', id: setThinking.id, command: 'set_thinking_level', success: true });
        await configRequest;

        // The stale steer is a normal prompt now, but Pi turn B is still
        // streaming, so neither fallback nor later queue item may start yet.
        await vi.waitFor(() => expect(harness.sent.some((item) => (item as { type?: string }).type === 'steer')).toBe(false));
        expect(harness.sent.some((item) => (item as { type?: string; message?: string }).type === 'prompt' && (item as { message?: string }).message === 'later ordinary prompt')).toBe(false);

        // When B settles, delayed fallback must win its original reservation.
        harness.onEvent!({
            type: 'response', command: 'get_state', success: true,
            data: { sessionId: 'pi-steering-session', sessionFile: '/tmp/pi-steering.jsonl', isStreaming: false },
        });
        await vi.waitFor(() => expect(harness.sent).toContainEqual(expect.objectContaining({
            type: 'prompt', message: 'earlier steer fallback',
        })));
        const prompts = harness.sent.filter((item) => (item as { type?: string }).type === 'prompt') as Array<{ message: string }>;
        expect(prompts.map((prompt) => prompt.message)).toEqual(['earlier steer fallback']);

        harness.onError?.(new Error('finish test'));
        await running;
    });
});

describe('Pi prompt preparation', () => {
    it('reads image attachments into Pi RPC image content while retaining safe text references', async () => {
        const { mkdtemp, writeFile, rm, symlink } = await import('node:fs/promises');
        const { tmpdir } = await import('node:os');
        const { join, sep } = await import('node:path');
        const imagePath = join(process.env.TMPDIR ?? '/tmp', `pi-image-${Date.now()}.png`);
        const uploadDir = await mkdtemp(join(tmpdir(), 'pi-upload-auth-'));
        const outsidePath = process.platform === 'win32' ? null : join(tmpdir(), `pi-outside-${Date.now()}.png`);
        const symlinkPath = process.platform === 'win32' ? null : join(uploadDir, 'escape.png');
        await writeFile(imagePath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
        if (outsidePath && symlinkPath) {
            await writeFile(outsidePath, Buffer.from([1, 2, 3, 4]));
            await symlink(outsidePath, symlinkPath);
        }
        try {
            const { preparePiUserMessage } = await import('./runPi');
            const prepared = await preparePiUserMessage('$brave-search explain', [
                { id: 'image', filename: 'plot.png', mimeType: 'image/png', size: 4, path: imagePath },
                { id: 'text', filename: 'notes file.txt', mimeType: 'text/plain', size: 1, path: '/tmp/notes file.txt' },
            ], [{ name: 'skill:brave-search', source: 'skill' }], {
                authorizeImagePath: () => true,
                authorizeOpenedImage: () => true,
            });
            expect(prepared.message).toBe('/skill:brave-search explain\n\nAttached file: \"/tmp/notes file.txt\"');
            expect(prepared.images).toEqual([{ type: 'image', mimeType: 'image/png', data: 'iVBORw==' }]);
            expect(prepared.imageReadErrors).toEqual([]);
            expect(formatPiUserMessage('', [{ id: 'newline', filename: 'x', mimeType: 'text/plain', size: 1, path: '/tmp/a\nb' }], [])).toBe('Attached file: \"/tmp/a\\nb\"');
            const failed = await preparePiUserMessage('', [{ id: 'missing', filename: 'missing.png', mimeType: 'image/png', size: 1, path: '/missing/image.png' }], [], {
                authorizeImagePath: () => true,
                authorizeOpenedImage: () => true,
            });
            expect(failed).toMatchObject({ message: '', images: [] });
            expect(failed.imageReadErrors[0]).toContain('Could not attach image missing.png');
            const unauthorized = await preparePiUserMessage('', [{ id: 'forged', filename: 'hosts.png', mimeType: 'image/png', size: 1, path: '/etc/hosts' }], [], {
                authorizeImagePath: () => false,
                authorizeOpenedImage: () => false,
            });
            expect(unauthorized).toMatchObject({ message: '', images: [] });
            expect(unauthorized.imageReadErrors).toEqual(['Could not attach image hosts.png: invalid upload path']);
            if (symlinkPath) {
                const symlinkEscape = await preparePiUserMessage('', [{ id: 'symlink', filename: 'escape.png', mimeType: 'image/png', size: 4, path: symlinkPath }], [], {
                    authorizeImagePath: (path) => path.startsWith(`${uploadDir}${sep}`),
                    authorizeOpenedImage: () => false,
                });
                expect(symlinkEscape).toMatchObject({ message: '', images: [] });
                expect(symlinkEscape.imageReadErrors[0]).toContain('Could not attach image escape.png');
            }
        } finally {
            await rm(imagePath, { force: true });
            if (outsidePath) await rm(outsidePath, { force: true });
            await rm(uploadDir, { recursive: true, force: true });
        }
    });
});
