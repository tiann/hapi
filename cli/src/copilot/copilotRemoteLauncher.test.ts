import { describe, expect, it, vi } from 'vitest';
import type { CopilotSession } from './session';
import { CopilotRemoteLauncher } from './copilotRemoteLauncher';
import type { AgentMessage } from '@/agent/types';

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
