import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CopilotSession } from './session';
import { CopilotRemoteLauncher } from './copilotRemoteLauncher';
import type { AgentMessage } from '@/agent/types';
import { MessageQueue2 } from '@/utils/MessageQueue2';
import { RPC_METHODS } from '@hapi/protocol/rpcMethods';
import type { RemoteLauncherTerminalHandlers } from '@/modules/common/remote/RemoteLauncherBase';

const abortHarness = vi.hoisted(() => {
    let resolveActivePrompt: (() => void) | null = null;
    let releaseCancelAll: (() => void) | null = null;
    let resolveCancelAllEntered: (() => void) | null = null;
    let cancelAllGated = false;
    let cancelAllRejects = false;
    let cancelAllHook: (() => Promise<void>) | null = null;
    let cancelPromptSettles = true;
    const cancelAllEntered = new Promise<void>((resolve) => { resolveCancelAllEntered = resolve; });
    return {
        prompts: [] as Array<Array<{ type: string; text: string }>>,
        cancelAllEntered,
        setCancelAllGated: (gated: boolean) => { cancelAllGated = gated; },
        isCancelAllGated: () => cancelAllGated,
        setCancelAllRejects: (rejects: boolean) => { cancelAllRejects = rejects; },
        isCancelAllRejects: () => cancelAllRejects,
        setCancelAllHook: (hook: (() => Promise<void>) | null) => { cancelAllHook = hook; },
        runCancelAllHook: () => cancelAllHook?.(),
        setCancelPromptSettles: (settles: boolean) => { cancelPromptSettles = settles; },
        cancelPromptSettles: () => cancelPromptSettles,
        settleActivePrompt: () => { resolveActivePrompt?.(); resolveActivePrompt = null; },
        waitActivePrompt: () => new Promise<void>((resolve) => { resolveActivePrompt = resolve; }),
        gateCancelAll: () => new Promise<void>((resolve) => { releaseCancelAll = resolve; }),
        releaseCancelAll: () => { releaseCancelAll?.(); },
        signalCancelAllEntered: () => { resolveCancelAllEntered?.(); },
    };
});

vi.mock('./utils/copilotBackend', () => ({
    createCopilotBackend: vi.fn(() => ({
        initialize: vi.fn(async () => {}),
        newSession: vi.fn(async () => 'copilot-session'),
        loadSession: vi.fn(async () => 'copilot-session'),
        setMode: vi.fn(async () => {}),
        setModel: vi.fn(async () => {}),
        getConfigOptionByCategory: vi.fn(),
        getSessionModelsMetadata: vi.fn(),
        prompt: vi.fn(async (_id: string, content: Array<{ type: string; text: string }>) => {
            abortHarness.prompts.push(content);
            await abortHarness.waitActivePrompt();
        }),
        cancelPrompt: vi.fn(async () => {
            if (abortHarness.cancelPromptSettles()) abortHarness.settleActivePrompt();
        }),
        onStderrError: vi.fn(),
        setSessionInfoUpdateListener: vi.fn(),
        refreshSessionInfo: vi.fn(async () => {}),
        disconnect: vi.fn(async () => {}),
    }))
}));

vi.mock('./utils/permissionHandler', () => ({
    CopilotPermissionHandler: class {
        async cancelAll(reason: string): Promise<void> {
            if (reason === 'User aborted') {
                const pending = abortHarness.runCancelAllHook();
                if (pending) { await pending; return; }
            }
            if (reason === 'User aborted' && abortHarness.isCancelAllRejects()) {
                throw new Error('cancelAll boom');
            }
            if (reason === 'User aborted' && abortHarness.isCancelAllGated()) {
                abortHarness.signalCancelAllEntered();
                await abortHarness.gateCancelAll();
            }
        }
    }
}));

vi.mock('@/ui/ink/CopilotDisplay', () => ({ CopilotDisplay: () => null }));
vi.mock('@/codex/utils/buildHapiMcpBridge', () => ({
    buildHapiMcpBridge: async () => ({ server: { stop: () => {} }, mcpServers: {} })
}));
vi.mock('@/ui/logger', () => ({ logger: { debug: vi.fn(), warn: vi.fn(), info: vi.fn() } }));

type LauncherInternals = {
    backend: {
        setMode: (sessionId: string, mode: string) => Promise<void>;
        setModel?: (sessionId: string, model: string) => Promise<void>;
        setConfigOption?: (sessionId: string, configId: string, value: string) => Promise<void>;
        getConfigOptionByCategory?: (sessionId: string, category: string) => {
            id: string;
            options: Array<{ value: string }>;
        } | undefined;
    } | null;
    activeSessionId: string | null;
    currentAgentMode: string;
    displayAgentMode: string | null;
    applyInitialAgentMode: () => Promise<void>;
    currentBackendModel: string | null;
    applyQueuedModel: (model: string) => Promise<string | null>;
    handleAgentMessage: (message: AgentMessage) => void;
};

function createLauncher(
    setMode: (sessionId: string, mode: string) => Promise<void>,
    onModelRollback?: (model: string | null) => void
) {
    const session = {
        sendSessionEvent: vi.fn(),
        sendAgentMessage: vi.fn(),
        setModel: vi.fn(),
        pushKeepAlive: vi.fn()
    } as unknown as CopilotSession;
    const launcher = new CopilotRemoteLauncher(session, { onModelRollback });
    const internals = launcher as unknown as LauncherInternals;
    internals.backend = { setMode };
    internals.activeSessionId = 'copilot-session';
    return { launcher, internals, session };
}

describe('CopilotRemoteLauncher.applyAgentMode', () => {
    it('attributes usage to the active Copilot model', () => {
        const { internals, session } = createLauncher(vi.fn().mockResolvedValue(undefined));
        internals.currentBackendModel = 'gpt-5.6';

        internals.handleAgentMessage({
            type: 'usage',
            inputTokens: 10,
            outputTokens: 2,
            totalTokens: 12
        });

        expect(session.sendAgentMessage).toHaveBeenCalledWith(expect.objectContaining({
            type: 'token_count',
            model: 'gpt-5.6'
        }));
    });

    it('does not update the acknowledged or displayed mode when setMode fails', async () => {
        const setMode = vi.fn().mockRejectedValue(new Error('transport unavailable'));
        const { launcher, internals, session } = createLauncher(setMode);

        await expect(launcher.applyAgentMode('plan')).rejects.toThrow('transport unavailable');

        expect(internals.currentAgentMode).toBe('interactive');
        expect(internals.displayAgentMode).toBeNull();
        expect(session.sendSessionEvent).toHaveBeenCalledWith({
            type: 'message',
            message: expect.stringContaining('Failed to switch Copilot agent mode')
        });
    });

    it('rejects later changes after Copilot reports mode switching unsupported', async () => {
        const setMode = vi.fn().mockRejectedValue(new Error('Method not found'));
        const { launcher, internals } = createLauncher(setMode);

        await expect(launcher.applyAgentMode('plan')).rejects.toThrow('Method not found');
        await expect(launcher.applyAgentMode('autopilot')).rejects.toThrow(
            'does not support agent mode switching'
        );

        expect(setMode).toHaveBeenCalledTimes(1);
        expect(internals.currentAgentMode).toBe('interactive');
    });

    it('continues startup when runtime mode switching is unsupported', async () => {
        const setMode = vi.fn().mockRejectedValue(new Error('Method not found'));
        const { internals } = createLauncher(setMode);

        await expect(internals.applyInitialAgentMode()).resolves.toBeUndefined();

        expect(internals.currentAgentMode).toBe('interactive');
        expect(internals.displayAgentMode).toBe('interactive');
    });

    it('maps interactive to the ACP agent mode via setMode', async () => {
        const setMode = vi.fn().mockResolvedValue(undefined);
        const { launcher, internals } = createLauncher(setMode);

        await expect(launcher.applyAgentMode('interactive')).resolves.toBeUndefined();

        expect(setMode).toHaveBeenCalledWith('copilot-session', 'agent');
        expect(internals.currentAgentMode).toBe('interactive');
        expect(internals.displayAgentMode).toBe('interactive');
    });

    it('does not permanently disable switching after an Invalid mode rejection', async () => {
        const setMode = vi.fn()
            .mockRejectedValueOnce(
                new Error("Invalid mode 'plan'. Supported values: agent, plan, autopilot.")
            )
            .mockResolvedValueOnce(undefined);
        const { launcher, internals } = createLauncher(setMode);

        await expect(launcher.applyAgentMode('plan')).rejects.toThrow("Invalid mode 'plan'");
        await expect(launcher.applyAgentMode('autopilot')).resolves.toBeUndefined();

        expect(setMode).toHaveBeenCalledTimes(2);
        expect(internals.currentAgentMode).toBe('autopilot');
    });

    it('applies Auto after an explicit model selection', async () => {
        const setModel = vi.fn().mockResolvedValue(undefined);
        const { internals } = createLauncher(vi.fn().mockResolvedValue(undefined));
        internals.backend = {
            setMode: vi.fn().mockResolvedValue(undefined),
            setModel
        };
        internals.currentBackendModel = 'gpt-5.6';

        await expect(internals.applyQueuedModel('auto')).resolves.toBe('auto');

        expect(setModel).toHaveBeenCalledWith('copilot-session', 'auto');
        expect(internals.currentBackendModel).toBe('auto');
    });

    it('rolls back the published model when switching fails', async () => {
        const onModelRollback = vi.fn();
        const { internals, session } = createLauncher(
            vi.fn().mockResolvedValue(undefined),
            onModelRollback
        );
        internals.backend = {
            setMode: vi.fn().mockResolvedValue(undefined),
            setModel: vi.fn().mockRejectedValue(new Error('transport unavailable'))
        };
        internals.currentBackendModel = 'gpt-5.4';

        await expect(internals.applyQueuedModel('gpt-5.6')).resolves.toBe('gpt-5.4');

        expect(session.setModel).toHaveBeenCalledWith('gpt-5.4');
        expect(session.pushKeepAlive).toHaveBeenCalledOnce();
        expect(onModelRollback).toHaveBeenCalledWith('gpt-5.4');
    });

    it('falls back to the model config option when setModel is unavailable', async () => {
        const setModel = vi.fn().mockRejectedValue(new Error('Method not found'));
        const setConfigOption = vi.fn().mockResolvedValue(undefined);
        const { internals } = createLauncher(vi.fn().mockResolvedValue(undefined));
        internals.backend = {
            setMode: vi.fn().mockResolvedValue(undefined),
            setModel,
            setConfigOption,
            getConfigOptionByCategory: vi.fn().mockReturnValue({
                id: 'model',
                options: [{ value: 'gpt-5.6' }]
            })
        };
        internals.currentBackendModel = 'gpt-5.4';

        await expect(internals.applyQueuedModel('gpt-5.6')).resolves.toBe('gpt-5.6');

        expect(setConfigOption).toHaveBeenCalledWith('copilot-session', 'model', 'gpt-5.6');
        expect(internals.currentBackendModel).toBe('gpt-5.6');
    });
});

type CopilotTestMode = { permissionMode: string };

function createAbortSession(queue: MessageQueue2<CopilotTestMode>) {
    const rpcHandlers = new Map<string, () => Promise<void>>();
    const session = {
        path: '/tmp/copilot-abort-test',
        logPath: '/tmp/copilot-abort-test/test.log',
        client: {
            rpcHandlerManager: {
                registerHandler: (method: string, handler: () => Promise<void>) => {
                    rpcHandlers.set(method, handler);
                }
            },
            sendSessionEvent: vi.fn(),
            sendAgentMessage: vi.fn(),
            updateMetadata: vi.fn(),
            emitMessagesConsumed: vi.fn(),
        },
        queue,
        sessionId: null as string | null,
        model: null,
        getAgentMode: () => 'interactive',
        getPermissionMode: () => 'default' as const,
        onSessionFound(id: string) { session.sessionId = id; },
        setRemoteAgentModeApplier: vi.fn(),
        onThinkingChange: vi.fn(),
        sendSessionEvent: vi.fn(),
        sendAgentMessage: vi.fn(),
    };
    return { session, rpcHandlers };
}

beforeEach(() => {
    process.stdin.isTTY = false;
    process.stdout.isTTY = false;
    abortHarness.setCancelAllGated(false);
    abortHarness.setCancelAllRejects(false);
    abortHarness.setCancelAllHook(null);
    abortHarness.setCancelPromptSettles(true);
    abortHarness.prompts.length = 0;
});

describe('CopilotRemoteLauncher Abort queue preservation', () => {
    it.each(
        (['switch', 'exit'] as const).flatMap(reason =>
            [false, true].flatMap(active =>
                [false, true].flatMap(repeated =>
                    [false, true].map(failing => ({ reason, active, repeated, failing })))))
    )('settles $reason during delayed Stop teardown (active: $active, repeated: $repeated, failing: $failing)', async ({ reason, active, repeated, failing }) => {
        const gates = [0, 1].map(() => {
            let enter!: () => void;
            let release!: () => void;
            const entered = new Promise<void>(resolve => { enter = resolve; });
            const pending = new Promise<void>(resolve => { release = resolve; });
            return { enter, release, entered, pending };
        });
        let cancels = 0;
        abortHarness.setCancelAllHook(async () => {
            const call = ++cancels;
            // Call 2 is terminal cleanup, which overtakes the serialized Stops.
            if (call === 2) return;
            const gate = gates[call === 1 ? 0 : 1];
            gate.enter();
            await gate.pending;
            if (failing && call === (repeated ? 3 : 1)) throw new Error('cancelAll boom');
        });
        const queue = new MessageQueue2<CopilotTestMode>((mode) => mode.permissionMode);
        const wait = vi.spyOn(queue, 'waitForMessagesAndGetAsString');
        const consumed = vi.fn();
        queue.onBatchConsumed = consumed;
        if (active) queue.push('active', { permissionMode: 'default' }, 'active-id');
        const { session, rpcHandlers } = createAbortSession(queue);
        let terminal!: RemoteLauncherTerminalHandlers;
        class TestLauncher extends CopilotRemoteLauncher {
            protected override setupTerminal(handlers: RemoteLauncherTerminalHandlers): void { terminal = handlers; }
        }
        const launcher = new TestLauncher(session as never, {});
        const barrier = vi.spyOn(launcher as unknown as { waitForAbortBarrier(): Promise<void> }, 'waitForAbortBarrier');
        const launched = launcher.launch().catch((error: unknown) => error);
        const stops: Array<Promise<unknown>> = [];
        try {
            await vi.waitFor(() => expect(wait).toHaveBeenCalledTimes(1));
            if (active) await vi.waitFor(() => expect(abortHarness.prompts).toHaveLength(1));
            const stop = () => rpcHandlers.get(RPC_METHODS.Abort)!().catch((error: unknown) => error);
            stops.push(stop());
            await gates[0].entered;
            await vi.waitFor(() => expect(barrier).toHaveBeenCalledTimes(2));
            if (repeated) stops.push(stop());
            consumed.mockClear();
            queue.push('A', { permissionMode: 'default' }, 'pending-a');
            queue.push('B', { permissionMode: 'default' }, 'pending-b');
            expect(queue.pendingLocalIds()).toEqual(['pending-a', 'pending-b']);
            if (reason === 'switch') await rpcHandlers.get(RPC_METHODS.Switch)!();
            else await terminal.onExit();
            gates[0].release();
            if (repeated) {
                await gates[1].entered;
                expect(wait).toHaveBeenCalledTimes(1);
                expect(consumed).not.toHaveBeenCalled();
                gates[1].release();
            }
            const results = await Promise.all(stops);
            if (failing) expect(results.at(-1)).toEqual(new Error('cancelAll boom'));
            else expect(results.every(result => result === undefined)).toBe(true);
            await new Promise<void>(resolve => setImmediate(resolve));
            expect(wait).toHaveBeenCalledTimes(1);
            expect(consumed).not.toHaveBeenCalled();
            expect(abortHarness.prompts).toHaveLength(active ? 1 : 0);
            expect(queue.pendingLocalIds()).toEqual([]);
            expect(await launched).toEqual(failing ? new Error('cancelAll boom') : reason);
        } finally {
            gates.forEach(gate => gate.release());
            abortHarness.setCancelAllHook(null);
            queue.close();
            await Promise.all(stops);
            abortHarness.settleActivePrompt();
            await launched;
        }
    });

    it('does not ACK newly arriving input while an idle Stop is awaiting teardown', async () => {
        let entered!: () => void;
        let release!: () => void;
        const enteredPromise = new Promise<void>(resolve => { entered = resolve; });
        const teardown = new Promise<void>(resolve => { release = resolve; });
        abortHarness.setCancelAllHook(async () => { entered(); await teardown; });
        const queue = new MessageQueue2<CopilotTestMode>((mode) => mode.permissionMode);
        const consumed = vi.fn();
        queue.onBatchConsumed = consumed;
        const { session, rpcHandlers } = createAbortSession(queue);
        const launcherPromise = new CopilotRemoteLauncher(session as never, {}).launch();
        let stop: Promise<unknown> | undefined;
        try {
            await vi.waitFor(() => expect(rpcHandlers.has(RPC_METHODS.Abort)).toBe(true));
            await new Promise<void>(resolve => setImmediate(resolve));
            stop = rpcHandlers.get(RPC_METHODS.Abort)!();
            await enteredPromise;
            queue.push('A', { permissionMode: 'default' }, 'id-a');
            queue.push('B', { permissionMode: 'default' }, 'id-b');
            await new Promise<void>(resolve => setImmediate(resolve));
            expect(queue.pendingLocalIds()).toEqual(['id-a', 'id-b']);
            expect(consumed).not.toHaveBeenCalled();
            expect(abortHarness.prompts).toHaveLength(0);
            release();
            await stop;
            await vi.waitFor(() => expect(abortHarness.prompts).toHaveLength(1));
            expect(abortHarness.prompts[0][0].text).toBe('A\nB');
            expect(consumed).toHaveBeenCalledExactlyOnceWith(['id-a', 'id-b']);
        } finally {
            release();
            abortHarness.setCancelAllHook(null);
            queue.close();
            await stop?.catch(() => {});
            await new Promise<void>(resolve => setImmediate(resolve));
            abortHarness.settleActivePrompt();
            await launcherPromise;
        }
    });

    it('keeps pending input behind the second Stop after the first teardown completes', async () => {
        // A cancellation ACK can precede the active prompt's final completion.
        abortHarness.setCancelPromptSettles(false);
        const gates = [0, 1].map(() => {
            let enter!: () => void;
            let release!: () => void;
            const entered = new Promise<void>(resolve => { enter = resolve; });
            const pending = new Promise<void>(resolve => { release = resolve; });
            return { enter, release, entered, pending };
        });
        let call = 0;
        abortHarness.setCancelAllHook(async () => {
            const gate = gates[call++];
            gate.enter();
            await gate.pending;
        });
        const queue = new MessageQueue2<CopilotTestMode>((mode) => mode.permissionMode);
        const consumed = vi.fn();
        queue.onBatchConsumed = consumed;
        queue.push('active', { permissionMode: 'default' }, 'id-active');
        const { session, rpcHandlers } = createAbortSession(queue);
        const launcherPromise = new CopilotRemoteLauncher(session as never, {}).launch();
        let first: Promise<unknown> | undefined;
        let second: Promise<unknown> | undefined;
        try {
            await vi.waitFor(() => expect(abortHarness.prompts).toHaveLength(1));
            consumed.mockClear();
            const abort = rpcHandlers.get(RPC_METHODS.Abort)!;
            first = abort();
            await gates[0].entered;
            second = abort();
            queue.push('A', { permissionMode: 'default' }, 'id-a');
            queue.push('B', { permissionMode: 'default' }, 'id-b');
            gates[0].release();
            await first;
            await gates[1].entered;
            abortHarness.settleActivePrompt();
            await new Promise<void>(resolve => setImmediate(resolve));
            expect(queue.pendingLocalIds()).toEqual(['id-a', 'id-b']);
            expect(consumed).not.toHaveBeenCalled();
            expect(abortHarness.prompts).toHaveLength(1);
            gates[1].release();
            await second;
            await vi.waitFor(() => expect(abortHarness.prompts).toHaveLength(2));
            expect(abortHarness.prompts[1][0].text).toBe('A\nB');
            expect(consumed).toHaveBeenCalledExactlyOnceWith(['id-a', 'id-b']);
        } finally {
            gates[0].release();
            gates[1].release();
            abortHarness.setCancelAllHook(null);
            queue.close();
            await Promise.allSettled([first, second]);
            await new Promise<void>(resolve => setImmediate(resolve));
            abortHarness.settleActivePrompt();
            await launcherPromise;
        }
    });

    it('keeps pending A/B queued and dispatches them exactly once in order after a plain Stop', async () => {
        const queue = new MessageQueue2<CopilotTestMode>((mode) => mode.permissionMode);
        queue.push('active', { permissionMode: 'default' }, 'id-active');
        const { session, rpcHandlers } = createAbortSession(queue);
        const launcher = new CopilotRemoteLauncher(session as never, {});
        const launcherPromise = launcher.launch();

        await vi.waitFor(() => expect(abortHarness.prompts).toHaveLength(1));

        queue.push('A', { permissionMode: 'default' }, 'id-a');
        queue.push('B', { permissionMode: 'default' }, 'id-b');

        const abort = rpcHandlers.get(RPC_METHODS.Abort)!;
        await abort();

        await vi.waitFor(() => expect(abortHarness.prompts).toHaveLength(2));
        expect(abortHarness.prompts[1][0].text).toBe('A\nB');

        abortHarness.settleActivePrompt();
        abortHarness.setCancelAllGated(false);
        queue.close();
        await rpcHandlers.get(RPC_METHODS.Abort)!();
        await launcherPromise;
    });

    it('does not dequeue/ACK/send pending A/B while abort teardown is still awaiting permission cancelAll', async () => {
        abortHarness.setCancelAllGated(true);
        const queue = new MessageQueue2<CopilotTestMode>((mode) => mode.permissionMode);
        const consumedIds: string[][] = [];
        queue.onBatchConsumed = (ids) => { consumedIds.push([...ids]); };
        queue.push('active', { permissionMode: 'default' }, 'id-active');
        const { session, rpcHandlers } = createAbortSession(queue);
        const launcher = new CopilotRemoteLauncher(session as never, {});
        const launcherPromise = launcher.launch();

        await vi.waitFor(() => expect(abortHarness.prompts).toHaveLength(1));
        consumedIds.length = 0;

        queue.push('A', { permissionMode: 'default' }, 'id-a');
        queue.push('B', { permissionMode: 'default' }, 'id-b');

        const abort = rpcHandlers.get(RPC_METHODS.Abort)!;
        const abortPromise = abort();

        await abortHarness.cancelAllEntered;

        queue.push('C', { permissionMode: 'default' }, 'id-c');

        expect(abortHarness.prompts).toHaveLength(1);
        expect(queue.pendingLocalIds()).toEqual(['id-a', 'id-b', 'id-c']);
        expect(consumedIds).toEqual([]);

        abortHarness.releaseCancelAll();
        await abortPromise;

        await vi.waitFor(() => expect(abortHarness.prompts).toHaveLength(2));
        expect(abortHarness.prompts[1][0].text).toBe('A\nB\nC');
        expect(consumedIds).toEqual([['id-a', 'id-b', 'id-c']]);

        abortHarness.settleActivePrompt();
        abortHarness.setCancelAllGated(false);
        queue.close();
        await rpcHandlers.get(RPC_METHODS.Abort)!();
        await launcherPromise;
    });

    it('keeps the loop alive across an idle plain Stop and still drains the queue afterwards', async () => {
        const queue = new MessageQueue2<CopilotTestMode>((mode) => mode.permissionMode);
        const { session, rpcHandlers } = createAbortSession(queue);
        const launcher = new CopilotRemoteLauncher(session as never, {});
        const launcherPromise = launcher.launch();

        await vi.waitFor(() => expect(rpcHandlers.has(RPC_METHODS.Abort)).toBe(true));

        const abort = rpcHandlers.get(RPC_METHODS.Abort)!;
        await abort();

        let settled = false;
        void launcherPromise.then(() => { settled = true; });
        await new Promise<void>((resolve) => setImmediate(resolve));
        expect(settled).toBe(false);

        queue.push('A', { permissionMode: 'default' }, 'id-a');
        queue.push('B', { permissionMode: 'default' }, 'id-b');

        await vi.waitFor(() => expect(abortHarness.prompts).toHaveLength(1));
        expect(abortHarness.prompts[0][0].text).toBe('A\nB');

        abortHarness.settleActivePrompt();
        abortHarness.setCancelAllGated(false);
        queue.close();
        await rpcHandlers.get(RPC_METHODS.Abort)!();
        await launcherPromise;
    });

    it('serializes concurrent Stop requests and dispatches the pending batch exactly once', async () => {
        const queue = new MessageQueue2<CopilotTestMode>((mode) => mode.permissionMode);
        const consumedIds: string[][] = [];
        queue.onBatchConsumed = (ids) => { consumedIds.push([...ids]); };
        queue.push('active', { permissionMode: 'default' }, 'id-active');
        const { session, rpcHandlers } = createAbortSession(queue);
        const launcher = new CopilotRemoteLauncher(session as never, {});
        const launcherPromise = launcher.launch();

        await vi.waitFor(() => expect(abortHarness.prompts).toHaveLength(1));
        consumedIds.length = 0;

        queue.push('A', { permissionMode: 'default' }, 'id-a');
        queue.push('B', { permissionMode: 'default' }, 'id-b');

        const abort = rpcHandlers.get(RPC_METHODS.Abort)!;
        const first = abort();
        const second = abort();
        await Promise.all([first, second]);

        await vi.waitFor(() => expect(abortHarness.prompts).toHaveLength(2));
        expect(abortHarness.prompts[1][0].text).toBe('A\nB');
        // Exactly one batch consumed, with both localIds in FIFO order.
        expect(consumedIds).toEqual([['id-a', 'id-b']]);

        abortHarness.settleActivePrompt();
        abortHarness.setCancelAllGated(false);
        queue.close();
        await rpcHandlers.get(RPC_METHODS.Abort)!();
        await launcherPromise;
    });

    it('fails the loop closed and surfaces the error when cancelAll rejects during teardown', async () => {
        abortHarness.setCancelAllRejects(true);
        const queue = new MessageQueue2<CopilotTestMode>((mode) => mode.permissionMode);
        queue.push('active', { permissionMode: 'default' }, 'id-active');
        const { session, rpcHandlers } = createAbortSession(queue);
        const launcher = new CopilotRemoteLauncher(session as never, {});
        const launcherPromise = launcher.launch();

        await vi.waitFor(() => expect(abortHarness.prompts).toHaveLength(1));
        queue.push('A', { permissionMode: 'default' }, 'id-a');
        queue.push('B', { permissionMode: 'default' }, 'id-b');

        const abort = rpcHandlers.get(RPC_METHODS.Abort)!;
        await expect(abort()).rejects.toThrow('cancelAll boom');

        // The run loop must fail closed: launcher rejects, pending A/B are
        // never dispatched or ACKed, no spin.
        await expect(launcherPromise).rejects.toThrow('cancelAll boom');
        expect(abortHarness.prompts).toHaveLength(1);
        expect(queue.pendingLocalIds()).toEqual(['id-a', 'id-b']);
    });
});
