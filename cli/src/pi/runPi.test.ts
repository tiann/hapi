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
        sendAgentMessage: vi.fn(),
        updateAgentState: vi.fn(),
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

describe('Pi steer-queued-message RPC', () => {
    beforeEach(() => {
        harness.sent.length = 0;
        harness.throwOnGetCommands = false;
        harness.onError = null;
        harness.onEvent = null;
        harness.rpcHandlers.clear();
        harness.session.rpcHandlerManager.registerHandler.mockReset();
        harness.session.rpcHandlerManager.registerHandler.mockImplementation(
            (method: string, handler: (payload: unknown) => Promise<unknown>) => {
                harness.rpcHandlers.set(method, handler);
            }
        );
        harness.session.onUserMessage.mockReset();
        harness.session.emitMessagesConsumed.mockReset();
        harness.session.sendSessionEvent.mockReset();
        harness.session.updateMetadata.mockReset();
        harness.killCount = 0;
        harness.cleanupCount = 0;
        vi.useFakeTimers();
    });

    // Startup helper used by the flow tests. Mirrors the existing "establishes
    // the history baseline" test: the 30s ready fallback establishes the
    // baseline first, then get_state reports the streaming state and the native
    // preparation probe completes. Advancing timers explicitly (instead of
    // letting vi.waitFor auto-advance) keeps the fallback from re-firing mid-test.
    async function startReadySession(streaming: boolean): Promise<{ running: Promise<void> }> {
        const running = runPi({ workingDirectory: '/work' });
        await Promise.resolve();
        await vi.advanceTimersByTimeAsync(31_000);
        await completeHistoryBaseline();
        harness.onEvent!({
            type: 'response', command: 'get_state', success: true,
            data: { sessionId: 'pi-session', sessionFile: '/tmp/pi-session.jsonl', ...(streaming ? { isStreaming: true } : {}) },
        });
        await completeHistoryProbe();
        await vi.advanceTimersByTimeAsync(0);
        return { running };
    }

    it('registers the steer-queued-message RPC handler', async () => {
        const { running } = await startReadySession(false);

        expect(harness.rpcHandlers.has(RPC_METHODS.SteerQueuedMessage)).toBe(true);

        harness.onError?.(new Error('stop test transport'));
        await running;
    });

    it('requires a localId', async () => {
        const { running } = await startReadySession(false);

        const handler = harness.rpcHandlers.get(RPC_METHODS.SteerQueuedMessage)!;
        const result = await handler({});

        expect(result).toEqual({ steered: false, error: 'localId is required' });

        harness.onError?.(new Error('stop test transport'));
        await running;
    });

    it('promotes a queued message into the active turn while Pi is streaming', async () => {
        const { running } = await startReadySession(true);

        // Pi reports a streaming turn: the prompt pump stays blocked, so the
        // message waits in the queue instead of being sent as a prompt.
        const onUserMessage = harness.session.onUserMessage.mock.calls.at(-1)![0] as (
            message: { role: 'user'; content: { type: 'text'; text: string } },
            localId: string
        ) => void;
        onUserMessage({ role: 'user', content: { type: 'text', text: 'steer me' } }, 'steer-local');
        await vi.advanceTimersByTimeAsync(0);

        expect(harness.sent).not.toContainEqual(expect.objectContaining({ type: 'prompt', message: 'steer me' }));

        const handler = harness.rpcHandlers.get(RPC_METHODS.SteerQueuedMessage)!;
        const result = await handler({ localId: 'steer-local' });

        expect(result).toEqual({ steered: true });

        // The native steer reaches Pi stdin and is acked once Pi confirms it.
        await vi.advanceTimersByTimeAsync(0);
        const steer = harness.sent.find((item) => (item as { type?: string }).type === 'steer') as
            { id: string; message: string } | undefined;
        expect(steer?.message).toBe('steer me');
        harness.onEvent!({ type: 'response', id: steer!.id, command: 'steer', success: true });
        await vi.advanceTimersByTimeAsync(0);
        expect(harness.session.emitMessagesConsumed).toHaveBeenCalledWith(['steer-local'], undefined);

        harness.onError?.(new Error('stop test transport'));
        await running;
    });

    it('rejects a steer when the message is not queued (already dispatched)', async () => {
        const { running } = await startReadySession(false);

        // Idle Pi: the pump dispatches the message as a normal prompt right away.
        const onUserMessage = harness.session.onUserMessage.mock.calls.at(-1)![0] as (
            message: { role: 'user'; content: { type: 'text'; text: string } },
            localId: string
        ) => void;
        onUserMessage({ role: 'user', content: { type: 'text', text: 'prompt me' } }, 'prompt-local');
        await vi.advanceTimersByTimeAsync(0);

        expect(harness.sent).toContainEqual(expect.objectContaining({ type: 'prompt', message: 'prompt me' }));

        const handler = harness.rpcHandlers.get(RPC_METHODS.SteerQueuedMessage)!;
        const result = await handler({ localId: 'prompt-local' });

        expect(result).toEqual({ steered: false, error: 'Message not found or already dispatched' });
        expect(harness.sent.filter((item) => (item as { type?: string }).type === 'steer')).toHaveLength(0);

        harness.onError?.(new Error('stop test transport'));
        await running;
    });

    it('defers a steer requested while the message is still preparing, then steers after preparation', async () => {
        const { running } = await startReadySession(true);

        const onUserMessage = harness.session.onUserMessage.mock.calls.at(-1)![0] as (
            message: { role: 'user'; content: { type: 'text'; text: string } },
            localId: string
        ) => void;
        const handler = harness.rpcHandlers.get(RPC_METHODS.SteerQueuedMessage)!;

        // The handler registers the localId in preparingLocalIds synchronously;
        // call the steer RPC before the preparation microtask completes so the
        // message is still "preparing".
        onUserMessage({ role: 'user', content: { type: 'text', text: 'attach me' } }, 'attach-local');
        const result = await handler({ localId: 'attach-local' });

        expect(result).toEqual({ steered: true });
        expect(harness.sent.filter((item) => (item as { type?: string }).type === 'steer')).toHaveLength(0);

        // Preparation completes and the pending steer is promoted into the turn.
        await vi.advanceTimersByTimeAsync(0);
        const steer = harness.sent.find((item) => (item as { type?: string }).type === 'steer') as
            { id: string; message: string } | undefined;
        expect(steer?.message).toBe('attach me');
        harness.onEvent!({ type: 'response', id: steer!.id, command: 'steer', success: true });
        await vi.advanceTimersByTimeAsync(0);
        expect(harness.session.emitMessagesConsumed).toHaveBeenCalledWith(['attach-local'], undefined);

        harness.onError?.(new Error('stop test transport'));
        await running;
    });

    it('steers into the generation captured at request time, not one that started mid-preparation', async () => {
        const { running } = await startReadySession(true);

        const onUserMessage = harness.session.onUserMessage.mock.calls.at(-1)![0] as (
            message: { role: 'user'; content: { type: 'text'; text: string } },
            localId: string
        ) => void;
        const handler = harness.rpcHandlers.get(RPC_METHODS.SteerQueuedMessage)!;

        // Request the steer while the message is still preparing (generation G1).
        onUserMessage({ role: 'user', content: { type: 'text', text: 'rollover me' } }, 'rollover-local');
        const result = await handler({ localId: 'rollover-local' });
        expect(result).toEqual({ steered: true });
        expect(harness.sent.filter((item) => (item as { type?: string }).type === 'steer')).toHaveLength(0);

        // G1 ends and G2 starts while the message is still preparing.
        const state = { sessionId: 'pi-session', sessionFile: '/tmp/pi-session.jsonl' };
        harness.onEvent!({ type: 'response', command: 'get_state', success: true, data: { ...state, isStreaming: false } });
        harness.onEvent!({ type: 'response', command: 'get_state', success: true, data: { ...state, isStreaming: true } });

        // Preparation completes; the dispatcher sees generation G2 != captured
        // G1 and degrades the message to the prompt FIFO instead of steering it.
        await vi.advanceTimersByTimeAsync(0);
        expect(harness.sent.filter((item) => (item as { type?: string }).type === 'steer')).toHaveLength(0);
        expect(harness.session.emitMessagesConsumed).not.toHaveBeenCalledWith(['rollover-local'], undefined);

        // Once G2 settles, the FIFO delivers the message as a normal prompt.
        harness.onEvent!({ type: 'response', command: 'get_state', success: true, data: { ...state, isStreaming: false } });
        await vi.advanceTimersByTimeAsync(0);
        expect(harness.sent).toContainEqual(expect.objectContaining({ type: 'prompt', message: 'rollover me' }));

        harness.onError?.(new Error('stop test transport'));
        await running;
    });

    it('drops a deferred steer when the message is cancelled while preparing', async () => {
        const { running } = await startReadySession(true);

        const onUserMessage = harness.session.onUserMessage.mock.calls.at(-1)![0] as (
            message: { role: 'user'; content: { type: 'text'; text: string } },
            localId: string
        ) => void;
        const handler = harness.rpcHandlers.get(RPC_METHODS.SteerQueuedMessage)!;

        onUserMessage({ role: 'user', content: { type: 'text', text: 'cancel me' } }, 'cancel-local');
        const result = await handler({ localId: 'cancel-local' });
        expect(result).toEqual({ steered: true });

        // Cancellation wins over the deferred steer (checked first in the chain).
        const onCancelQueuedMessage = harness.session.onCancelQueuedMessage.mock.calls.at(-1)![0] as (localId: string) => boolean;
        expect(onCancelQueuedMessage('cancel-local')).toBe(true);

        // Preparation completes: the message is dropped — never steered, never
        // sent as a prompt, never consumed (the hub deletes the row instead).
        await vi.advanceTimersByTimeAsync(0);
        expect(harness.sent.filter((item) => (item as { type?: string }).type === 'steer')).toHaveLength(0);
        expect(harness.sent.filter((item) => (item as { type?: string }).type === 'prompt')).toHaveLength(0);
        expect(harness.session.emitMessagesConsumed).not.toHaveBeenCalled();

        harness.onError?.(new Error('stop test transport'));
        await running;
    });
});

describe('Pi built-in slash commands', () => {
    beforeEach(() => {
        vi.useRealTimers();
        harness.sent.length = 0;
        harness.throwOnGetCommands = false;
        harness.onError = null;
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

    async function startReadySession(commands: Array<Record<string, unknown>> = [
        { name: 'test-extension', description: 'Test extension', source: 'extension' },
        { name: 'skill:brave-search', description: 'Search the web', source: 'skill' },
    ]): Promise<{
        running: Promise<void>;
        onUserMessage: (message: {
            role: 'user';
            content: { type: 'text'; text: string };
            meta?: { deliveryMode?: 'queue' | 'steer' };
        }, localId: string) => void;
    }> {
        const running = runPi({ workingDirectory: '/work' });
        await vi.waitFor(() => expect(harness.onEvent).not.toBeNull());
        harness.onEvent!({
            type: 'response', command: 'get_state', success: true,
            data: { sessionId: 'pi-slash-session', sessionFile: '/tmp/pi-slash.jsonl', isStreaming: false },
        });
        await completeHistoryInitialization();
        // Warm the command cache: slash-message handling consults discovered
        // commands to decide extension-vs-builtin precedence.
        const getCommands = harness.sent.find((item) => (item as { type?: string }).type === 'get_commands') as { id: string };
        harness.onEvent!({ type: 'response', id: getCommands.id, command: 'get_commands', success: true, data: { commands } });
        const onUserMessage = harness.session.onUserMessage.mock.calls.at(-1)![0] as (message: {
            role: 'user';
            content: { type: 'text'; text: string };
            meta?: { deliveryMode?: 'queue' | 'steer' };
        }, localId: string) => void;
        return { running, onUserMessage };
    }

    it('executes /compact via Pi RPC, reports the summary, and holds queued prompts until it completes', async () => {
        const { running, onUserMessage } = await startReadySession();
        onUserMessage({
            role: 'user',
            content: { type: 'text', text: '/compact focus on the API design' },
        }, 'compact-id');

        onUserMessage({
            role: 'user',
            content: { type: 'text', text: 'continue after compaction' },
        }, 'after-id');

        await vi.waitFor(() => expect(harness.sent).toContainEqual(expect.objectContaining({
            type: 'compact', customInstructions: 'focus on the API design',
        })));
        // The /compact row is consumed at dispatch: slash commands are
        // executed by HAPI and never delivered to Pi as prompts, so they must
        // not linger in the web queued bar for the duration of the command.
        await vi.waitFor(() => expect(harness.session.emitMessagesConsumed).toHaveBeenCalledWith(['compact-id'], undefined));
        // Compaction keeps working for minutes without a Pi streaming event,
        // so the session reports thinking while the RPC is outstanding and
        // clears it once the run settles.
        await vi.waitFor(() => expect(harness.session.keepAlive).toHaveBeenCalledWith(true, expect.anything(), expect.anything()));
        // While the compact RPC is outstanding, the FIFO must not release the
        // following prompt — Pi rejects prompts during compaction.
        expect(harness.sent).not.toContainEqual(expect.objectContaining({ type: 'prompt' }));

        const compact = harness.sent.find((item) => (item as { type?: string }).type === 'compact') as { id: string };
        // The compact RPC holds the session in the thinking state for its
        // whole duration (web would otherwise mark it idle after the hub's
        // 15s queued-thinking grace).
        const keepAliveCalls = harness.session.keepAlive.mock.calls;
        expect(keepAliveCalls[keepAliveCalls.length - 1]?.[0]).toBe(true);
        harness.onEvent!({
            type: 'response', id: compact.id, command: 'compact', success: true,
            data: { summary: 'API design focused summary', tokensBefore: 1000, estimatedTokensAfter: 120 },
        });

        // The summary lands as a structured event (the web renders it as a
        // dedicated block), not as a plain status message. (The /compact row
        // was already consumed at dispatch above.)
        await vi.waitFor(() => expect(harness.session.sendSessionEvent).toHaveBeenCalledWith({
            type: 'compact-summary',
            summary: 'API design focused summary',
            tokensBefore: 1000,
            estimatedTokensAfter: 120,
        }));
        expect(harness.session.sendSessionEvent).not.toHaveBeenCalledWith(expect.objectContaining({
            message: expect.stringContaining('Compaction summary'),
        }));
        await vi.waitFor(() => expect(harness.session.keepAlive).toHaveBeenCalledWith(false, expect.anything(), expect.anything()));

        // The thinking state is released once the RPC completes.
        await vi.waitFor(() => {
            const calls = harness.session.keepAlive.mock.calls;
            expect(calls[calls.length - 1]?.[0]).toBe(false);
        });

        // The queued prompt may only flow once compaction completed.
        await vi.waitFor(() => expect(harness.sent).toContainEqual(expect.objectContaining({
            type: 'prompt', message: 'continue after compaction',
        })));

        harness.onError?.(new Error('finish test'));
        await running;
    });

    it('dispatches a head-of-line /compact even when delivered as a steer while streaming', async () => {
        const { running, onUserMessage } = await startReadySession();
        harness.onEvent!({
            type: 'response', command: 'get_state', success: true,
            data: { sessionId: 'pi-slash-session', sessionFile: '/tmp/pi-slash.jsonl', isStreaming: true },
        });
        onUserMessage({
            role: 'user',
            content: { type: 'text', text: '/compact' },
            meta: { deliveryMode: 'steer' },
        }, 'steer-compact-id');

        // /compact stays interruptible while streaming: Pi's compact() aborts
        // the active generation itself, and the command must never degrade to
        // a native steer.
        await vi.waitFor(() => expect(harness.sent).toContainEqual(expect.objectContaining({ type: 'compact' })));
        const compact = harness.sent.find((item) => (item as { type?: string }).type === 'compact') as { id: string; customInstructions?: string };
        expect(compact.customInstructions).toBeUndefined();
        expect(harness.sent).not.toContainEqual(expect.objectContaining({ type: 'steer' }));

        harness.onEvent!({ type: 'response', id: compact.id, command: 'compact', success: true, data: {} });
        await vi.waitFor(() => expect(harness.session.emitMessagesConsumed).toHaveBeenCalledWith(['steer-compact-id'], undefined));

        harness.onError?.(new Error('finish test'));
        await running;
    });

    it('keeps non-compact commands queued while streaming (FIFO head rule)', async () => {
        const { running, onUserMessage } = await startReadySession();
        harness.onEvent!({
            type: 'response', command: 'get_state', success: true,
            data: { sessionId: 'pi-slash-session', sessionFile: '/tmp/pi-slash.jsonl', isStreaming: true },
        });
        onUserMessage({ role: 'user', content: { type: 'text', text: '/session' } }, 'session-id');

        await new Promise((resolve) => setTimeout(resolve, 100));
        expect(harness.sent).not.toContainEqual(expect.objectContaining({ type: 'get_session_stats' }));

        harness.onEvent!({
            type: 'response', command: 'get_state', success: true,
            data: { sessionId: 'pi-slash-session', sessionFile: '/tmp/pi-slash.jsonl', isStreaming: false },
        });
        await vi.waitFor(() => expect(harness.sent).toContainEqual(expect.objectContaining({ type: 'get_session_stats' })));

        harness.onError?.(new Error('finish test'));
        await running;
    });

    it('dispatches a prompt queued before /compact ahead of the command (FIFO)', async () => {
        const { running, onUserMessage } = await startReadySession();
        harness.onEvent!({
            type: 'response', command: 'get_state', success: true,
            data: { sessionId: 'pi-slash-session', sessionFile: '/tmp/pi-slash.jsonl', isStreaming: true },
        });
        onUserMessage({ role: 'user', content: { type: 'text', text: 'queued prompt B' } }, 'b-id');
        onUserMessage({ role: 'user', content: { type: 'text', text: '/compact' } }, 'compact-after-b-id');
        await new Promise((resolve) => setTimeout(resolve, 100));
        expect(harness.sent).not.toContainEqual(expect.objectContaining({ type: 'prompt' }));
        expect(harness.sent).not.toContainEqual(expect.objectContaining({ type: 'compact' }));

        // Turn settles: prompt B is dispatched first; /compact must wait.
        harness.onEvent!({
            type: 'response', command: 'get_state', success: true,
            data: { sessionId: 'pi-slash-session', sessionFile: '/tmp/pi-slash.jsonl', isStreaming: false },
        });
        await vi.waitFor(() => expect(harness.sent).toContainEqual(expect.objectContaining({
            type: 'prompt', message: 'queued prompt B',
        })));
        expect(harness.sent).not.toContainEqual(expect.objectContaining({ type: 'compact' }));

        // Settle prompt B, then the queued /compact executes. The lifecycle
        // fallback reads the append log before retiring the entry.
        const promptB = harness.sent.find((item) => (item as { type?: string }).type === 'prompt') as { id: string };
        vi.useFakeTimers();
        harness.onEvent!({ type: 'response', id: promptB.id, command: 'prompt', success: true });
        await vi.advanceTimersByTimeAsync(1_100);
        const appendSync = harness.sent.filter((item) => (item as { type?: string }).type === 'get_entries').at(-1) as { id: string };
        harness.onEvent!({ type: 'response', id: appendSync.id, command: 'get_entries', success: true, data: { entries: [], leafId: null } });
        await vi.advanceTimersByTimeAsync(10);
        vi.useRealTimers();
        expect(harness.sent).toContainEqual(expect.objectContaining({ type: 'compact' }));

        harness.onError?.(new Error('finish test'));
        await running;
    });

    it('reports compact failures as a visible message', async () => {
        const { running, onUserMessage } = await startReadySession();
        onUserMessage({ role: 'user', content: { type: 'text', text: '/compact' } }, 'fail-id');

        const compact = await vi.waitFor(() => {
            const found = harness.sent.find((item) => (item as { type?: string }).type === 'compact') as { id: string } | undefined;
            expect(found).toBeDefined();
            return found!;
        });
        // Consumption happens at dispatch, before the command outcome is
        // known: a failing /compact still leaves the queue immediately and
        // surfaces its failure through the ⚠️ event message instead.
        await vi.waitFor(() => expect(harness.session.emitMessagesConsumed).toHaveBeenCalledWith(['fail-id'], undefined));
        harness.onEvent!({ type: 'response', id: compact.id, command: 'compact', success: false, error: 'no model selected' });

        await vi.waitFor(() => expect(harness.session.sendSessionEvent).toHaveBeenCalledWith(expect.objectContaining({
            message: '⚠️ Compaction failed: no model selected',
        })));
        // The raw Pi error must not be emitted a second time by the common
        // response handler (compact owns its failure reporting).
        expect(harness.session.sendSessionEvent).not.toHaveBeenCalledWith({ type: 'message', message: 'no model selected' });

        harness.onError?.(new Error('finish test'));
        await running;
    });

    it('shows session stats for /session', async () => {
        const { running, onUserMessage } = await startReadySession();
        onUserMessage({ role: 'user', content: { type: 'text', text: '/session' } }, 'stats-id');

        await vi.waitFor(() => expect(harness.sent).toContainEqual(expect.objectContaining({ type: 'get_session_stats' })));
        const statsCmd = harness.sent.find((item) => (item as { type?: string }).type === 'get_session_stats') as { id: string };
        harness.onEvent!({
            type: 'response', id: statsCmd.id, command: 'get_session_stats', success: true,
            data: {
                totalMessages: 42,
                tokens: { input: 3000, output: 2000, total: 5000 },
                cost: 0.1234,
                contextUsage: { tokens: 4000, contextWindow: 200000, percent: 2 },
            },
        });

        await vi.waitFor(() => expect(harness.session.sendSessionEvent).toHaveBeenCalledWith(expect.objectContaining({
            message: expect.stringContaining('Messages: 42'),
        })));
        expect(harness.session.sendSessionEvent).toHaveBeenCalledWith(expect.objectContaining({
            message: expect.stringContaining('Tokens: total 5000 · in 3000 · out 2000'),
        }));
        expect(harness.session.sendSessionEvent).toHaveBeenCalledWith(expect.objectContaining({
            message: expect.stringContaining('Cost: $0.1234'),
        }));
        expect(harness.session.sendSessionEvent).toHaveBeenCalledWith(expect.objectContaining({
            message: expect.stringContaining('Context: 4000 / 200000 tokens (2%)'),
        }));
        await vi.waitFor(() => expect(harness.session.emitMessagesConsumed).toHaveBeenCalledWith(['stats-id'], { clearQueuedThinkingGrace: true }));

        harness.onError?.(new Error('finish test'));
        await running;
    });

    it('lists or switches the model for /model', async () => {
        const { running, onUserMessage } = await startReadySession();
        harness.onEvent!({ type: 'response', command: 'get_available_models', success: true, data: {
            models: [
                { id: 'gpt-5.2', provider: 'openai' },
                { id: 'gpt-4.1', provider: 'openai' },
            ],
        } });
        await vi.waitFor(() => expect(harness.session.updateMetadata).toHaveBeenCalled());

        onUserMessage({ role: 'user', content: { type: 'text', text: '/model' } }, 'list-id');
        await vi.waitFor(() => expect(harness.session.sendSessionEvent).toHaveBeenCalledWith(expect.objectContaining({
            message: expect.stringContaining('Available: openai/gpt-5.2, openai/gpt-4.1'),
        })));
        await vi.waitFor(() => expect(harness.session.emitMessagesConsumed).toHaveBeenCalledWith(['list-id'], { clearQueuedThinkingGrace: true }));

        onUserMessage({ role: 'user', content: { type: 'text', text: '/model gpt-4.1' } }, 'switch-id');
        const setModel = await vi.waitFor(() => {
            const found = harness.sent.find((item) => (item as { type?: string }).type === 'set_model') as { id: string; provider?: string; modelId?: string } | undefined;
            expect(found).toBeDefined();
            return found!;
        });
        expect(setModel).toMatchObject({ provider: 'openai', modelId: 'gpt-4.1' });
        harness.onEvent!({ type: 'response', id: setModel.id, command: 'set_model', success: true });
        await vi.waitFor(() => expect(harness.session.sendSessionEvent).toHaveBeenCalledWith(expect.objectContaining({
            message: 'Model switched to gpt-4.1',
        })));
        await vi.waitFor(() => expect(harness.session.emitMessagesConsumed).toHaveBeenCalledWith(['switch-id'], { clearQueuedThinkingGrace: true }));

        onUserMessage({ role: 'user', content: { type: 'text', text: '/model does-not-exist' } }, 'unknown-id');
        await vi.waitFor(() => expect(harness.session.sendSessionEvent).toHaveBeenCalledWith(expect.objectContaining({
            message: '⚠️ Unknown model: does-not-exist. Use /model to list available models.',
        })));

        harness.onError?.(new Error('finish test'));
        await running;
    });

    it('recovers /model from an empty model cache by retrying discovery', async () => {
        const { running, onUserMessage } = await startReadySession();
        // No get_available_models was answered at startup: the cache is empty
        // and the first /model must retry the discovery RPC instead of
        // reporting the catalog as unknown.
        onUserMessage({ role: 'user', content: { type: 'text', text: '/model' } }, 'retry-list-id');

        const discovery = await vi.waitFor(() => {
            // Pick the latest discovery request: the startup probe may also
            // still be outstanding.
            const found = harness.sent.filter((item) => (item as { type?: string }).type === 'get_available_models').at(-1) as { id: string } | undefined;
            expect(found).toBeDefined();
            return found!;
        });
        harness.onEvent!({ type: 'response', id: discovery.id, command: 'get_available_models', success: true, data: {
            models: [
                { id: 'gpt-5.2', provider: 'openai' },
                { id: 'gpt-4.1', provider: 'openai' },
            ],
        } });

        await vi.waitFor(() => expect(harness.session.sendSessionEvent).toHaveBeenCalledWith(expect.objectContaining({
            message: expect.stringContaining('Available: openai/gpt-5.2, openai/gpt-4.1'),
        })));
        await vi.waitFor(() => expect(harness.session.emitMessagesConsumed).toHaveBeenCalledWith(['retry-list-id'], { clearQueuedThinkingGrace: true }));

        harness.onError?.(new Error('finish test'));
        await running;
    });

    it('aborts an in-flight /compact directly instead of waiting on the mutation lease', async () => {
        const { running, onUserMessage } = await startReadySession();
        onUserMessage({ role: 'user', content: { type: 'text', text: '/compact' } }, 'abortable-id');

        const compact = await vi.waitFor(() => {
            const found = harness.sent.find((item) => (item as { type?: string }).type === 'compact') as { id: string } | undefined;
            expect(found).toBeDefined();
            return found!;
        });

        // The Abort action must interrupt the compaction via the abort RPC —
        // waiting for the runtime-mutation lease would exceed the 25s abort
        // deadline while compaction may run for up to 120s.
        const abort = harness.rpcHandlers.get(RPC_METHODS.Abort)!;
        const abortPromise = abort({});
        await vi.waitFor(() => expect(harness.sent).toContainEqual(expect.objectContaining({ type: 'abort' })));
        const abortRpc = harness.sent.find((item) => (item as { type?: string }).type === 'abort') as { id: string };
        harness.onEvent!({ type: 'response', id: abortRpc.id, command: 'abort', success: true });
        await abortPromise;
        expect(harness.cleanupCount).toBe(0);

        // Pi reports the cancellation through its lifecycle event; the RPC
        // error is the same cancellation and must not double-report a failure.
        harness.onEvent!({ type: 'response', id: compact.id, command: 'compact', success: false, error: 'Compaction cancelled' });
        await vi.waitFor(() => expect(harness.session.emitMessagesConsumed).toHaveBeenCalledWith(['abortable-id'], undefined));
        expect(harness.session.sendSessionEvent).not.toHaveBeenCalledWith(expect.objectContaining({
            message: expect.stringContaining('Compaction failed'),
        }));

        harness.onError?.(new Error('finish test'));
        await running;
    });

    it('cancels a /compact still queued on the runtime-mutation lock when Abort lands first', async () => {
        const { running, onUserMessage } = await startReadySession();

        // Hold the runtime-mutation lock open so the compact RPC cannot be
        // issued before Abort arrives.
        const { PiSession } = await import('./session');
        const realRunRuntimeMutation = PiSession.prototype.runRuntimeMutation;
        let gate: Promise<void> | null = null;
        let releaseGate!: () => void;
        const spy = vi.spyOn(PiSession.prototype, 'runRuntimeMutation').mockImplementation(async function (this: unknown, op, opts) {
            if (gate) await gate;
            return realRunRuntimeMutation.call(this, op, opts);
        });
        try {
            gate = new Promise<void>((resolve) => { releaseGate = resolve; });
            onUserMessage({ role: 'user', content: { type: 'text', text: '/compact' } }, 'prestart-id');
            await vi.waitFor(() => expect(spy).toHaveBeenCalled());

            const abort = harness.rpcHandlers.get(RPC_METHODS.Abort)!;
            await abort({});

            // No abort RPC may be sent: the compact RPC never started, so
            // there is nothing on Pi's side to interrupt.
            expect(harness.sent).not.toContainEqual(expect.objectContaining({ type: 'abort' }));
            expect(harness.sent).not.toContainEqual(expect.objectContaining({ type: 'compact' }));

            // Release the lock: the compact RPC must be skipped entirely and
            // the row still consumed.
            releaseGate();
            await vi.waitFor(() => expect(harness.session.emitMessagesConsumed).toHaveBeenCalledWith(['prestart-id'], undefined));
            expect(harness.sent).not.toContainEqual(expect.objectContaining({ type: 'compact' }));
            expect(harness.cleanupCount).toBe(0);
            expect(harness.session.sendSessionEvent).not.toHaveBeenCalledWith(expect.objectContaining({
                message: expect.stringContaining('Compaction'),
            }));
        } finally {
            spy.mockRestore();
        }

        harness.onError?.(new Error('finish test'));
        await running;
    });

    it('retires pending extension UI requests when /compact interrupts a streaming turn', async () => {
        const { running, onUserMessage } = await startReadySession();
        harness.onEvent!({
            type: 'response', command: 'get_state', success: true,
            data: { sessionId: 'pi-slash-session', sessionFile: '/tmp/pi-slash.jsonl', isStreaming: true },
        });
        harness.onEvent!({ type: 'extension_ui_request', id: 'ui-blocking', method: 'input', title: 'Need input' });

        onUserMessage({ role: 'user', content: { type: 'text', text: '/compact' } }, 'ui-compact-id');
        await vi.waitFor(() => expect(harness.sent).toContainEqual(expect.objectContaining({ type: 'compact' })));

        // The stale input card must be cancelled and removed from agent state
        // exactly like the Abort path does, so the web is not stuck on it.
        await vi.waitFor(() => expect(harness.sent).toContainEqual(expect.objectContaining({
            type: 'extension_ui_response', id: 'ui-blocking', cancelled: true,
        })));

        harness.onError?.(new Error('finish test'));
        await running;
    });

    it('fails closed when the direct compact-abort RPC times out', async () => {
        const { running, onUserMessage } = await startReadySession();
        onUserMessage({ role: 'user', content: { type: 'text', text: '/compact' } }, 'timeout-abort-id');
        await vi.waitFor(() => expect(harness.sent).toContainEqual(expect.objectContaining({ type: 'compact' })));

        vi.useFakeTimers();
        const abort = harness.rpcHandlers.get(RPC_METHODS.Abort)!;
        const abortPromise = abort({});
        // Attach the settlement handler before advancing timers so the
        // rejection is never observed as unhandled.
        const settled = abortPromise.then(() => 'ok', () => 'failed');
        await vi.advanceTimersByTimeAsync(10);
        expect(harness.sent).toContainEqual(expect.objectContaining({ type: 'abort' }));

        // The abort RPC never answers: the compaction outcome is
        // indeterminate (the compact RPC keeps the mutation lease for up to
        // 120s), so the session must fail closed exactly like the ordinary
        // Abort path and never release the prompt FIFO.
        await vi.advanceTimersByTimeAsync(30_000);
        expect(await settled).toBe('failed');
        expect(harness.cleanupCount).toBe(1);
        vi.useRealTimers();

        harness.onError?.(new Error('finish test'));
        await running;
    });

    it('fails the session when compaction times out with a queued prompt', async () => {
        const { running, onUserMessage } = await startReadySession();
        // Fake timers must be installed before the compact RPC is issued so
        // its 120s timeout timer is mocked.
        vi.useFakeTimers();
        onUserMessage({ role: 'user', content: { type: 'text', text: '/compact' } }, 'timeout-id');
        onUserMessage({ role: 'user', content: { type: 'text', text: 'queued behind compaction' } }, 'queued-id');
        await vi.advanceTimersByTimeAsync(10);

        expect(harness.sent).toContainEqual(expect.objectContaining({ type: 'compact' }));
        expect(harness.sent).not.toContainEqual(expect.objectContaining({ type: 'prompt' }));

        // The compact RPC never answers: the outcome is indeterminate and the
        // runtime lease stays poisoned, so the session must be torn down and
        // the prompt FIFO must never be reopened into a possibly-compacting Pi.
        await vi.advanceTimersByTimeAsync(120_000);
        expect(harness.cleanupCount).toBe(1);
        expect(harness.sent).not.toContainEqual(expect.objectContaining({ type: 'prompt' }));
        vi.useRealTimers();

        harness.onError?.(new Error('finish test'));
        await running;
    });

    it('does not acknowledge cancellation while a special command is executing', async () => {
        const { running, onUserMessage } = await startReadySession();
        onUserMessage({ role: 'user', content: { type: 'text', text: '/compact' } }, 'in-flight-id');

        await vi.waitFor(() => expect(harness.sent).toContainEqual(expect.objectContaining({ type: 'compact' })));

        // The row is consumed at dispatch (the command executes out-of-band
        // and is never delivered to Pi), so a cancel that lands while the
        // compact RPC is in flight is not acknowledged — the entry is already
        // gone from the queue.
        const onCancelQueuedMessage = harness.session.onCancelQueuedMessage.mock.calls.at(-1)![0] as (localId: string) => boolean;
        expect(onCancelQueuedMessage('in-flight-id')).toBe(false);

        const compact = harness.sent.find((item) => (item as { type?: string }).type === 'compact') as { id: string };
        harness.onEvent!({ type: 'response', id: compact.id, command: 'compact', success: true, data: { summary: 'done' } });
        await vi.waitFor(() => expect(harness.session.emitMessagesConsumed).toHaveBeenCalledWith(['in-flight-id'], undefined));

        harness.onError?.(new Error('finish test'));
        await running;
    });

    it('refuses ambiguous bare model IDs shared across providers and accepts qualified ones', async () => {
        const { running, onUserMessage } = await startReadySession();
        harness.onEvent!({ type: 'response', command: 'get_available_models', success: true, data: {
            models: [
                { id: 'gpt-5.2', provider: 'openai' },
                { id: 'gpt-5.2', provider: 'azure' },
            ],
        } });
        await vi.waitFor(() => expect(harness.session.updateMetadata).toHaveBeenCalled());

        onUserMessage({ role: 'user', content: { type: 'text', text: '/model' } }, 'list-ambig-id');
        await vi.waitFor(() => expect(harness.session.sendSessionEvent).toHaveBeenCalledWith(expect.objectContaining({
            message: expect.stringContaining('Available: openai/gpt-5.2, azure/gpt-5.2'),
        })));

        onUserMessage({ role: 'user', content: { type: 'text', text: '/model gpt-5.2' } }, 'ambig-id');
        await vi.waitFor(() => expect(harness.session.sendSessionEvent).toHaveBeenCalledWith(expect.objectContaining({
            message: '⚠️ Ambiguous model: gpt-5.2. Use openai/gpt-5.2, azure/gpt-5.2.',
        })));
        expect(harness.sent).not.toContainEqual(expect.objectContaining({ type: 'set_model' }));
        await vi.waitFor(() => expect(harness.session.emitMessagesConsumed).toHaveBeenCalledWith(['ambig-id'], { clearQueuedThinkingGrace: true }));

        onUserMessage({ role: 'user', content: { type: 'text', text: '/model azure/gpt-5.2' } }, 'qualified-id');
        const setModel = await vi.waitFor(() => {
            const found = harness.sent.find((item) => (item as { type?: string }).type === 'set_model') as { id: string; provider?: string; modelId?: string } | undefined;
            expect(found).toBeDefined();
            return found!;
        });
        expect(setModel).toMatchObject({ provider: 'azure', modelId: 'gpt-5.2' });
        harness.onEvent!({ type: 'response', id: setModel.id, command: 'set_model', success: true });
        await vi.waitFor(() => expect(harness.session.sendSessionEvent).toHaveBeenCalledWith(expect.objectContaining({
            message: 'Model switched to azure/gpt-5.2',
        })));
        // The web picker prefers piSelectedModel metadata, so a
        // provider-qualified switch must persist it (a bare keepalive model
        // cannot represent the provider dimension).
        await vi.waitFor(() => expect(harness.session.updateMetadata).toHaveBeenCalledWith(expect.any(Function)));
        const metadataUpdater = harness.session.updateMetadata.mock.calls.at(-1)![0] as (meta: Record<string, unknown>) => Record<string, unknown>;
        expect(metadataUpdater({})).toEqual({ piSelectedModel: { provider: 'azure', modelId: 'gpt-5.2' } });

        harness.onError?.(new Error('finish test'));
        await running;
    });

    it('reports a rejected model switch once, without the raw Pi error', async () => {
        const { running, onUserMessage } = await startReadySession();
        harness.onEvent!({ type: 'response', command: 'get_available_models', success: true, data: {
            models: [{ id: 'gpt-5.2', provider: 'openai' }],
        } });
        await vi.waitFor(() => expect(harness.session.updateMetadata).toHaveBeenCalled());

        onUserMessage({ role: 'user', content: { type: 'text', text: '/model gpt-5.2' } }, 'reject-id');
        const setModel = await vi.waitFor(() => {
            const found = harness.sent.find((item) => (item as { type?: string }).type === 'set_model') as { id: string } | undefined;
            expect(found).toBeDefined();
            return found!;
        });
        harness.onEvent!({ type: 'response', id: setModel.id, command: 'set_model', success: false, error: 'model rejected' });
        await vi.waitFor(() => expect(harness.session.sendSessionEvent).toHaveBeenCalledWith(expect.objectContaining({
            message: '⚠️ Model switch failed: model rejected',
        })));
        expect(harness.session.sendSessionEvent).not.toHaveBeenCalledWith({ type: 'message', message: 'model rejected' });

        harness.onError?.(new Error('finish test'));
        await running;
    });

    it('shows help and flags terminal-only Pi builtins instead of passing them to the model', async () => {
        const { running, onUserMessage } = await startReadySession();

        onUserMessage({ role: 'user', content: { type: 'text', text: '/help' } }, 'help-id');
        await vi.waitFor(() => expect(harness.session.sendSessionEvent).toHaveBeenCalledWith(expect.objectContaining({
            message: expect.stringContaining('/compact [instructions]'),
        })));

        onUserMessage({ role: 'user', content: { type: 'text', text: '/tree 42' } }, 'tree-id');
        await vi.waitFor(() => expect(harness.session.sendSessionEvent).toHaveBeenCalledWith(expect.objectContaining({
            message: expect.stringContaining('/tree is a Pi terminal-only command'),
        })));
        await vi.waitFor(() => expect(harness.session.emitMessagesConsumed).toHaveBeenCalledWith(['tree-id'], { clearQueuedThinkingGrace: true }));
        expect(harness.sent).not.toContainEqual(expect.objectContaining({ type: 'prompt' }));

        harness.onError?.(new Error('finish test'));
        await running;
    });

    it('leaves unknown slash text on the normal prompt path', async () => {
        const { running, onUserMessage } = await startReadySession();
        onUserMessage({ role: 'user', content: { type: 'text', text: '/some-custom-thing arg' } }, 'custom-id');
        await vi.waitFor(() => expect(harness.sent).toContainEqual(expect.objectContaining({
            type: 'prompt', message: '/some-custom-thing arg',
        })));

        harness.onError?.(new Error('finish test'));
        await running;
    });

    it('merges HAPI builtins with Pi extension commands in the slash-command list', async () => {
        const { running } = await startReadySession();
        const slashHandler = harness.rpcHandlers.get(RPC_METHODS.ListSlashCommands)!;

        const result = await slashHandler({ agent: 'pi' });
        const names = (result as { commands: Array<{ name: string }> }).commands.map((command) => command.name);
        expect(names).toEqual(expect.arrayContaining(['compact', 'session', 'model', 'help', 'test-extension']));
        // Skills stay out of slash completion; they surface via $ instead.
        expect(names).not.toContain('skill:brave-search');

        harness.onError?.(new Error('finish test'));
        await running;
    });

    it('lets a discovered extension named compact override the builtin', async () => {
        const { running, onUserMessage } = await startReadySession([
            { name: 'compact', description: 'Custom compact', source: 'extension' },
        ]);
        onUserMessage({ role: 'user', content: { type: 'text', text: '/compact' } }, 'ext-compact-id');

        // The menu lists the extension over the builtin, so the message must
        // reach Pi as an ordinary prompt instead of the HAPI compact RPC.
        await vi.waitFor(() => expect(harness.sent).toContainEqual(expect.objectContaining({
            type: 'prompt', message: '/compact',
        })));
        expect(harness.sent).not.toContainEqual(expect.objectContaining({ type: 'compact' }));

        harness.onError?.(new Error('finish test'));
        await running;
    });

    it('cancels a slash command canceled while command discovery is pending', async () => {
        const { running, onUserMessage } = await startReadySession([]);
        const onCancelQueuedMessage = harness.session.onCancelQueuedMessage.mock.calls.at(-1)![0] as (localId: string) => boolean;
        onUserMessage({ role: 'user', content: { type: 'text', text: '/compact' } }, 'discover-cancel-id');

        // Discovery RPC is in flight (empty cache is not cached).
        await vi.waitFor(() => expect(harness.sent.filter((item) => (item as { type?: string }).type === 'get_commands').length).toBeGreaterThan(1));
        // Cancel while discovery is pending is acknowledged (reservation held)...
        expect(onCancelQueuedMessage('discover-cancel-id')).toBe(true);

        // ...and must still win once discovery resolves: no compact RPC, no
        // consumption (the hub deletes the row instead).
        const pending = harness.sent.filter((item) => (item as { type?: string }).type === 'get_commands').at(-1) as { id: string };
        harness.onEvent!({ type: 'response', id: pending.id, command: 'get_commands', success: true, data: { commands: [{ name: 'ext', description: 'Ext', source: 'extension' }] } });
        await new Promise((resolve) => setTimeout(resolve, 100));
        expect(harness.sent).not.toContainEqual(expect.objectContaining({ type: 'compact' }));
        expect(harness.session.emitMessagesConsumed).not.toHaveBeenCalledWith(['discover-cancel-id'], expect.anything());

        harness.onError?.(new Error('finish test'));
        await running;
    });

    it('treats reserved-name path prefixes as ordinary prompts', async () => {
        const { running, onUserMessage } = await startReadySession();
        onUserMessage({ role: 'user', content: { type: 'text', text: '/compact.md notes' } }, 'path-id');
        await vi.waitFor(() => expect(harness.sent).toContainEqual(expect.objectContaining({
            type: 'prompt', message: '/compact.md notes',
        })));
        expect(harness.sent).not.toContainEqual(expect.objectContaining({ type: 'compact' }));

        harness.onError?.(new Error('finish test'));
        await running;
    });
});
