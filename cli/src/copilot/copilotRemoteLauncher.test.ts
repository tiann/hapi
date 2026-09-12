import { describe, expect, it, vi } from 'vitest';
import type { CopilotSession } from './session';
import { CopilotRemoteLauncher } from './copilotRemoteLauncher';
import type { AgentMessage } from '@/agent/types';
import * as bridge from '@/codex/utils/buildHapiMcpBridge';
import * as copilotBackend from './utils/copilotBackend';
import { MessageQueue2 } from '@/utils/MessageQueue2';
import type { CopilotMode } from './types';

type LauncherInternals = {
    backend: {
        setMode: (sessionId: string, mode: string) => Promise<void>;
        setModel?: (sessionId: string, model: string) => Promise<void>;
        setConfigOption?: (sessionId: string, configId: string, value: string) => Promise<void>;
        getConfigOptionByCategory?: (sessionId: string, category: string) => {
            id: string;
            options: Array<{ value: string }>;
        } | undefined;
        getThoughtLevelConfigOption?: (sessionId: string) => {
            id: string;
            currentValue?: string;
            options: Array<{ value: string }>;
        } | undefined;
    } | null;
    activeSessionId: string | null;
    currentAgentMode: string;
    displayAgentMode: string | null;
    applyInitialAgentMode: () => Promise<void>;
    currentBackendModel: string | null;
    appliedModelSelection: string | null;
    reconcileAppliedModelSelection: () => void;
    defaultBackendEffort: string | null;
    applyQueuedModel: (model: string) => Promise<string | null>;
    applyEffort: (effort: string | null) => Promise<string | null>;
    syncDiscoveredEffort: (sessionId: string) => void;
    handleAgentMessage: (message: AgentMessage) => void;
};

function createLauncher(
    setMode: (sessionId: string, mode: string) => Promise<void>,
    onModelRollback?: (model: string | null) => void,
    onEffortChange?: (effort: string | null) => void
) {
    const session = {
        sendSessionEvent: vi.fn(),
        sendAgentMessage: vi.fn(),
        setModel: vi.fn(),
        getModel: vi.fn(() => null),
        setEffort: vi.fn(),
        pushKeepAlive: vi.fn()
    } as unknown as CopilotSession;
    const launcher = new CopilotRemoteLauncher(session, { onModelRollback, onEffortChange });
    const internals = launcher as unknown as LauncherInternals;
    internals.backend = {
        setMode,
        getThoughtLevelConfigOption: vi.fn().mockReturnValue(undefined),
    };
    internals.activeSessionId = 'copilot-session';
    return { launcher, internals, session };
}

describe('CopilotRemoteLauncher.applyAgentMode', () => {
    it('delivers a queued prompt when an advertised effort is rejected by the provider', async () => {
        const { launcher, session } = createLauncher(vi.fn());
        const queue = new MessageQueue2<CopilotMode>(mode => JSON.stringify(mode));
        queue.push('deliver this prompt', { permissionMode: 'default', effort: 'low' });
        queue.close();
        const backend = {
            initialize: vi.fn(async () => {}), newSession: vi.fn(async () => 'copilot-session'),
            onStderrError: vi.fn(), setSessionInfoUpdateListener: vi.fn(), onPermissionRequest: vi.fn(),
            getConfigOptionByCategory: vi.fn(), getSessionModelsMetadata: vi.fn(),
            getThoughtLevelConfigOption: vi.fn(() => ({ id: 'thought_level', options: [{ value: 'low' }, { value: 'medium' }], currentValue: 'medium' })),
            setConfigOption: vi.fn(async () => { throw new Error('Invalid params'); }),
            setMode: vi.fn(async () => {}), prompt: vi.fn(async () => {}), refreshSessionInfo: vi.fn(async () => {}),
        };
        Object.assign(session, {
            queue, getAgentMode: () => 'interactive', getPermissionMode: () => 'default',
            onSessionFound: vi.fn(), setRemoteAgentModeApplier: vi.fn(), setRemoteEffortApplier: vi.fn(), onThinkingChange: vi.fn(),
            client: { rpcHandlerManager: { registerHandler: vi.fn() }, updateAgentState: vi.fn() },
        });
        const bridgeSpy = vi.spyOn(bridge, 'buildHapiMcpBridge').mockResolvedValue({ server: { stop: vi.fn() }, mcpServers: {} } as never);
        const backendSpy = vi.spyOn(copilotBackend, 'createCopilotBackend').mockReturnValue(backend as never);
        try {
            await (launcher as unknown as { runMainLoop: () => Promise<void> }).runMainLoop();
            expect(backend.setConfigOption).toHaveBeenCalledWith('copilot-session', 'thought_level', 'low');
            expect(backend.prompt).toHaveBeenCalledWith('copilot-session', [{ type: 'text', text: 'deliver this prompt' }], expect.any(Function));
            expect(session.sendSessionEvent).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringContaining('Invalid params') }));
        } finally {
            bridgeSpy.mockRestore();
            backendSpy.mockRestore();
        }
    });
    it('rejects discovery after its backend is retired or the launcher exits', async () => {
        const { launcher, internals, session } = createLauncher(vi.fn());
        const backend = {
            initialize: vi.fn(async () => {}),
            newSession: vi.fn(async () => 'copilot-session'),
            onStderrError: vi.fn(),
            setSessionInfoUpdateListener: vi.fn(),
            getThoughtLevelConfigOption: vi.fn(() => ({ options: [{ value: 'low' }], currentValue: 'low' })),
        };
        let discover: (() => Promise<unknown>) | undefined;
        const registered = new Error('discovery registered');
        Object.assign(session, {
            getAgentMode: () => 'interactive',
            onSessionFound: vi.fn(),
            setRemoteAgentModeApplier: vi.fn(),
            setRemoteEffortApplier: vi.fn(),
            client: { rpcHandlerManager: { registerHandler: (_method: string, handler: () => Promise<unknown>) => {
                discover = handler;
                throw registered;
            } } },
        });
        const bridgeSpy = vi.spyOn(bridge, 'buildHapiMcpBridge').mockResolvedValue({ server: { stop: vi.fn() }, mcpServers: {} } as never);
        const backendSpy = vi.spyOn(copilotBackend, 'createCopilotBackend').mockReturnValue(backend as never);
        try {
            const lifecycle = launcher as unknown as { runMainLoop: () => Promise<void>; shouldExit: boolean };
            await expect(lifecycle.runMainLoop()).rejects.toBe(registered);
            await expect(discover?.()).resolves.toMatchObject({ success: true });
            internals.backend = null;
            await expect(discover?.()).resolves.toMatchObject({ success: false });
            internals.backend = backend as never;
            lifecycle.shouldExit = true;
            await expect(discover?.()).resolves.toMatchObject({ success: false });
            expect(backend.getThoughtLevelConfigOption).toHaveBeenCalledTimes(1);
        } finally {
            bridgeSpy.mockRestore();
            backendSpy.mockRestore();
        }
    });
    it('reconciles equivalent selections but keeps the applied tag during a real model switch', () => {
        const { internals, session } = createLauncher(vi.fn());
        internals.currentBackendModel = 'gpt-5.6';
        vi.mocked(session.getModel).mockReturnValue('gpt-5.6');
        internals.reconcileAppliedModelSelection();
        expect(internals.appliedModelSelection).toBe('gpt-5.6');
        vi.mocked(session.getModel).mockReturnValue('gpt-next');
        internals.reconcileAppliedModelSelection();
        expect(internals.appliedModelSelection).toBe('gpt-5.6');
        internals.currentBackendModel = 'auto';
        vi.mocked(session.getModel).mockReturnValue(null);
        internals.reconcileAppliedModelSelection();
        expect(internals.appliedModelSelection).toBeNull();
    });
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
        expect(internals.appliedModelSelection).toBeNull();
    });

    it('publishes the discovered effort after switching models', async () => {
        const onEffortChange = vi.fn();
        const setModel = vi.fn().mockResolvedValue(undefined);
        const { internals, session } = createLauncher(
            vi.fn().mockResolvedValue(undefined),
            undefined,
            onEffortChange
        );
        internals.backend = {
            setMode: vi.fn().mockResolvedValue(undefined),
            setModel,
            getThoughtLevelConfigOption: vi.fn().mockReturnValue({
                id: 'thought_level',
                currentValue: 'medium',
                options: [{ value: 'low' }, { value: 'medium' }],
            }),
        };
        internals.currentBackendModel = 'gpt-5.4';

        await expect(internals.applyQueuedModel('gpt-5.6')).resolves.toBe('gpt-5.6');

        expect(session.setEffort).toHaveBeenCalledWith('medium');
        expect(onEffortChange).toHaveBeenCalledWith('medium');
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

    it('uses the discovered model default when resetting effort', async () => {
        const setConfigOption = vi.fn().mockResolvedValue(undefined);
        const { internals } = createLauncher(vi.fn().mockResolvedValue(undefined));
        internals.defaultBackendEffort = 'medium';
        internals.backend = {
            setMode: vi.fn().mockResolvedValue(undefined),
            setConfigOption,
            getThoughtLevelConfigOption: vi.fn().mockReturnValue({
                id: 'thought_level',
                options: [{ value: 'low' }, { value: 'medium' }, { value: 'high' }],
            }),
        };

        await expect(internals.applyEffort(null)).resolves.toBeNull();

        expect(setConfigOption).toHaveBeenCalledWith('copilot-session', 'thought_level', 'medium');
    });

    it('applies ACP thought-level effort through the discovered config option', async () => {
        const setConfigOption = vi.fn().mockResolvedValue(undefined)
        const { internals, session } = createLauncher(vi.fn().mockResolvedValue(undefined))
        internals.backend = {
            setMode: vi.fn().mockResolvedValue(undefined),
            setConfigOption,
            getThoughtLevelConfigOption: vi.fn().mockReturnValue({
                id: 'thought_level',
                options: [{ value: 'low' }, { value: 'high' }],
            }),
        }

        await expect(internals.applyEffort('high')).resolves.toBe('high')

        expect(setConfigOption).toHaveBeenCalledWith('copilot-session', 'thought_level', 'high')
        expect(session.setEffort).toHaveBeenCalledWith('high')
        expect(session.pushKeepAlive).toHaveBeenCalledOnce()
    })

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
