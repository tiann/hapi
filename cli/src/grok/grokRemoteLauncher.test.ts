import { describe, expect, it, vi } from 'vitest';
import type { AgentSessionConfig } from '@/agent/types';
import { GrokCancelTimeoutError } from './utils/grokBackend';
import { openGrokSession, settleGrokAbort, shouldPublishGrokReady } from './grokRemoteLauncher';

const config: AgentSessionConfig = { cwd: '/repo', mcpServers: [] };

describe('openGrokSession', () => {
    it('propagates a resume failure without creating a replacement session', async () => {
        const resumeError = new Error('native session is unavailable');
        const backend = {
            resumeSession: vi.fn().mockRejectedValue(resumeError),
            newSession: vi.fn().mockResolvedValue('replacement-session')
        };
        const publishIdentity = vi.fn();

        await expect(openGrokSession(backend, 'existing-session', config, publishIdentity)).rejects.toBe(resumeError);

        expect(backend.resumeSession).toHaveBeenCalledWith('existing-session', config);
        expect(backend.newSession).not.toHaveBeenCalled();
        expect(publishIdentity).not.toHaveBeenCalled();
    });

    it('creates a native session only when there is no session to resume', async () => {
        const backend = {
            resumeSession: vi.fn(),
            newSession: vi.fn().mockResolvedValue('new-session')
        };
        let releaseIdentity!: () => void;
        const publishIdentity = vi.fn(() => new Promise<void>((resolve) => { releaseIdentity = resolve; }));
        let settled = false;

        const opening = openGrokSession(backend, null, config, publishIdentity)
            .then((sessionId) => { settled = true; return sessionId; });
        await vi.waitFor(() => expect(publishIdentity).toHaveBeenCalledWith('new-session'));

        expect(backend.resumeSession).not.toHaveBeenCalled();
        expect(backend.newSession).toHaveBeenCalledWith(config);
        expect(settled).toBe(false);
        releaseIdentity();
        await expect(opening).resolves.toBe('new-session');
    });
});

describe('settleGrokAbort', () => {
    function lifecycle(cancelPrompt: () => Promise<void>) {
        return {
            backend: { cancelPrompt },
            nativeSessionId: 'provider-confirmed-session',
            cancelPermissions: vi.fn(async () => {}),
            resetQueue: vi.fn(),
            setThinkingIdle: vi.fn(),
            resetAbortController: vi.fn(),
            onCancelTimeout: vi.fn(async () => {})
        };
    }

    it('terminalizes a typed cancellation timeout and still runs every abort cleanup', async () => {
        const timeout = new GrokCancelTimeoutError(10);
        const cancelPrompt = vi.fn(async () => { throw timeout; });
        const hooks = lifecycle(cancelPrompt);

        await expect(settleGrokAbort(hooks)).resolves.toBeUndefined();

        expect(cancelPrompt).toHaveBeenCalledWith('provider-confirmed-session');
        expect(hooks.onCancelTimeout).toHaveBeenCalledWith(timeout);
        expect(hooks.cancelPermissions).toHaveBeenCalledTimes(1);
        expect(hooks.resetQueue).toHaveBeenCalledTimes(1);
        expect(hooks.setThinkingIdle).toHaveBeenCalledTimes(1);
        expect(hooks.resetAbortController).toHaveBeenCalledTimes(1);
    });

    it('rethrows an unknown cancellation failure only after running every abort cleanup', async () => {
        const failure = new Error('unexpected cancel failure');
        const hooks = lifecycle(vi.fn(async () => { throw failure; }));

        await expect(settleGrokAbort(hooks)).rejects.toBe(failure);

        expect(hooks.onCancelTimeout).not.toHaveBeenCalled();
        expect(hooks.cancelPermissions).toHaveBeenCalledTimes(1);
        expect(hooks.resetQueue).toHaveBeenCalledTimes(1);
        expect(hooks.setThinkingIdle).toHaveBeenCalledTimes(1);
        expect(hooks.resetAbortController).toHaveBeenCalledTimes(1);
    });
});

describe('shouldPublishGrokReady', () => {
    it('suppresses ready after the ACP transport was force-closed', () => {
        expect(shouldPublishGrokReady({ queueSize: 0, shouldExit: false, isConnected: false })).toBe(false);
        expect(shouldPublishGrokReady({ queueSize: 0, shouldExit: false, isConnected: true })).toBe(true);
    });
});
