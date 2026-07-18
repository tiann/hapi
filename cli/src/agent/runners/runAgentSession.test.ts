import { describe, expect, it, vi } from 'vitest';

import { acknowledgeManagedAgentIdentity, cleanupFailedAgentSetup, consumeManagedAgentLaunchContext, resolveAgentSessionModel } from './runAgentSession';

describe('resolveAgentSessionModel', () => {
    it('rejects clearing the model for Hermes MoA sessions', () => {
        expect(() => resolveAgentSessionModel('hermes-moa', null)).toThrow('Hermes MoA preset is required');
    });

    it('accepts only explicit Hermes MoA presets', () => {
        expect(resolveAgentSessionModel('hermes-moa', ' fable-5-1m-max ')).toBe('fable-5-1m-max');
        expect(resolveAgentSessionModel('hermes-moa', ' gpt-5.5-xhigh ')).toBe('gpt-5.5-xhigh');
        expect(resolveAgentSessionModel('hermes-moa', ' gpt-5.6-sol-max ')).toBe('gpt-5.6-sol-max');
        expect(() => resolveAgentSessionModel('hermes-moa', 'not-a-moa-preset')).toThrow('Invalid Hermes MoA preset');
    });

    it('preserves null model clearing for agents that support Auto/default models', () => {
        expect(resolveAgentSessionModel('agy', null)).toBeNull();
    });
});

describe('managed generic agent identity', () => {
    it('captures and scrubs managed launch metadata before provider initialization', () => {
        const env: NodeJS.ProcessEnv = {
            HAPI_LAUNCH_NONCE: 'launch-1', HAPI_RUNNER_INSTANCE_ID: 'runner-1',
            HAPI_RESUME_PROFILE_FINGERPRINT: 'profile-1', HAPI_EXPECTED_NATIVE_RESUME_ID: 'native-1',
            HAPI_MANAGED_OUTCOME_FD: '3', HERMES_API_KEY: 'provider-owned'
        };

        expect(consumeManagedAgentLaunchContext(env)).toEqual({
            launchNonce: 'launch-1', resumeProfileFingerprint: 'profile-1', expectedNativeResumeId: 'native-1'
        });
        expect(env).toEqual({ HAPI_MANAGED_OUTCOME_FD: '3', HERMES_API_KEY: 'provider-owned' });
    });

    it('rejects a mismatched managed resume before acknowledging it to the runner', async () => {
        const notify = vi.fn();
        await expect(acknowledgeManagedAgentIdentity({
            launchNonce: 'launch-1', resumeProfileFingerprint: 'profile-1', expectedNativeResumeId: 'native-1'
        }, 'native-other', notify)).rejects.toThrow('native resume identity mismatch');
        expect(notify).not.toHaveBeenCalled();
    });

    it('requires runner acknowledgement before a managed generic session can proceed', async () => {
        const notify = vi.fn().mockResolvedValue({ acknowledged: false });
        await expect(acknowledgeManagedAgentIdentity({
            launchNonce: 'launch-1', resumeProfileFingerprint: 'profile-1', expectedNativeResumeId: 'native-1'
        }, 'native-1', notify)).rejects.toThrow('Runner rejected native identity ownership');
    });

    it('disconnects provider and closes HAPI resources when setup fails before the prompt loop', async () => {
        const calls: string[] = [];
        await cleanupFailedAgentSetup({
            backend: { disconnect: async () => { calls.push('disconnect'); } },
            happyServer: { stop: () => { calls.push('stop-server'); } },
            session: {
                sendSessionDeath: () => { calls.push('death'); },
                flush: async () => { calls.push('flush'); },
                close: () => { calls.push('close'); }
            }
        });
        expect(calls).toEqual(['stop-server', 'death', 'flush', 'close', 'disconnect']);
    });

    it('attempts every cleanup step even when earlier steps fail', async () => {
        const calls: string[] = [];
        await expect(cleanupFailedAgentSetup({
            backend: { disconnect: async () => { calls.push('disconnect'); } },
            happyServer: { stop: () => { calls.push('stop-server'); throw new Error('stop failed'); } },
            session: {
                sendSessionDeath: () => { calls.push('death'); throw new Error('death failed'); },
                flush: async () => { calls.push('flush'); },
                close: () => { calls.push('close'); }
            }
        })).rejects.toThrow();
        expect(calls).toEqual(['stop-server', 'death', 'flush', 'close', 'disconnect']);
    });
});
