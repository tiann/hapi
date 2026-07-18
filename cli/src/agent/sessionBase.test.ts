import { afterEach, describe, expect, it, vi } from 'vitest';
import { AgentSessionBase } from './sessionBase';

const managedKeys = ['HAPI_LAUNCH_NONCE', 'HAPI_RUNNER_INSTANCE_ID', 'HAPI_RESUME_PROFILE_FINGERPRINT', 'HAPI_EXPECTED_NATIVE_RESUME_ID'] as const;
const saved = Object.fromEntries(managedKeys.map((key) => [key, process.env[key]]));

afterEach(() => {
    for (const key of managedKeys) {
        const value = saved[key];
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
    }
});

function createManagedSession(notifyNativeIdentity: (...args: any[]) => Promise<{ acknowledged: boolean }>) {
    process.env.HAPI_LAUNCH_NONCE = '11111111-1111-4111-8111-111111111111';
    process.env.HAPI_RUNNER_INSTANCE_ID = 'runner-1';
    process.env.HAPI_RESUME_PROFILE_FINGERPRINT = 'a'.repeat(64);
    process.env.HAPI_EXPECTED_NATIVE_RESUME_ID = 'native-expected';
    const client = {
        keepAlive: vi.fn(),
        updateMetadata: vi.fn()
    };
    const session = new AgentSessionBase({
        api: {} as any,
        client: client as any,
        path: '/tmp', logPath: '/tmp/log', sessionId: 'native-expected',
        messageQueue: {} as any, onModeChange: () => {}, sessionLabel: 'Claude', sessionIdLabel: 'Claude',
        applySessionIdToMetadata: (metadata, sessionId) => ({ ...metadata, claudeSessionId: sessionId }),
        notifyNativeIdentity: notifyNativeIdentity as any
    });
    return { session, client };
}

describe('AgentSessionBase managed native identity', () => {
    it('fails closed instead of inventing an incompatible managed profile fingerprint', async () => {
        const notify = vi.fn().mockResolvedValue({ acknowledged: true });
        const { session } = createManagedSession(notify);
        session.stopKeepAlive();
        process.env.HAPI_LAUNCH_NONCE = '22222222-2222-4222-8222-222222222222';
        process.env.HAPI_RUNNER_INSTANCE_ID = 'runner-1';
        delete process.env.HAPI_RESUME_PROFILE_FINGERPRINT;

        const client = { keepAlive: vi.fn(), updateMetadata: vi.fn() };
        const missingProfileSession = new AgentSessionBase({
            api: {} as any,
            client: client as any,
            path: '/tmp', logPath: '/tmp/log', sessionId: null,
            messageQueue: {} as any, onModeChange: () => {}, sessionLabel: 'Claude', sessionIdLabel: 'Claude',
            applySessionIdToMetadata: (metadata, sessionId) => ({ ...metadata, claudeSessionId: sessionId }),
            notifyNativeIdentity: notify as any
        });

        await expect(missingProfileSession.onSessionFound('native-created')).rejects.toThrow('missing resume profile fingerprint');
        missingProfileSession.stopKeepAlive();
        expect(notify).not.toHaveBeenCalled();
    });

    it('does not synthetically confirm the expected id before the provider reports it', () => {
        const notify = vi.fn().mockResolvedValue({ acknowledged: true });
        const { session } = createManagedSession(notify);
        session.stopKeepAlive();
        expect(notify).not.toHaveBeenCalled();
    });

    it('rejects an unexpected first provider-reported native id', async () => {
        const notify = vi.fn().mockResolvedValue({ acknowledged: true });
        const { session } = createManagedSession(notify);
        await expect(session.onSessionFound('native-unexpected')).rejects.toThrow('first native identity mismatch');
        session.stopKeepAlive();
        expect(notify).not.toHaveBeenCalled();
    });

    it('confirms the expected first id then permits a later verified rotation', async () => {
        const notify = vi.fn().mockResolvedValue({ acknowledged: true });
        const { session } = createManagedSession(notify);
        await session.onSessionFound('native-expected');
        await session.onSessionFound('native-after-clear');
        session.stopKeepAlive();
        expect(notify.mock.calls.map((call) => call[0].nativeResumeId)).toEqual(['native-expected', 'native-after-clear']);
    });
});
