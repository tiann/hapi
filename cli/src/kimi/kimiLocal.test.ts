import { afterEach, describe, expect, it, vi } from 'vitest';
import { kimiLocal } from './kimiLocal';
import { spawnWithTerminalGuard } from '@/utils/spawnWithTerminalGuard';
import { getAgentLaunchCommand } from '@/agent/agentLaunchCommand';
import { resetPeerToolsForTests } from '@/modules/common/peerTools';

vi.mock('@/utils/spawnWithTerminalGuard', () => ({
    spawnWithTerminalGuard: vi.fn(async () => {})
}));

vi.mock('@/agent/agentLaunchCommand', () => ({
    getAgentLaunchCommand: vi.fn(() => 'kimi')
}));

describe('kimiLocal peer-tools child env (#2056)', () => {
    const original = process.env.HAPI_DISABLE_PEER_TOOLS;

    afterEach(() => {
        if (original === undefined) {
            delete process.env.HAPI_DISABLE_PEER_TOOLS;
        } else {
            process.env.HAPI_DISABLE_PEER_TOOLS = original;
        }
        resetPeerToolsForTests();
        vi.mocked(spawnWithTerminalGuard).mockClear();
    });

    async function spawnedEnv(peerToolsDisabled?: boolean): Promise<NodeJS.ProcessEnv> {
        await kimiLocal({
            path: '/work',
            sessionId: 'kimi-session-1',
            abort: new AbortController().signal,
            ...(peerToolsDisabled === undefined ? {} : { peerToolsDisabled })
        });
        const call = vi.mocked(spawnWithTerminalGuard).mock.calls.at(-1);
        expect(call).toBeDefined();
        return call![0].env ?? {};
    }

    it('pins the disabled session snapshot into the child env', async () => {
        delete process.env.HAPI_DISABLE_PEER_TOOLS;
        expect((await spawnedEnv(true)).HAPI_DISABLE_PEER_TOOLS).toBe('1');
    });

    it('pins an explicit enabled snapshot', async () => {
        delete process.env.HAPI_DISABLE_PEER_TOOLS;
        expect((await spawnedEnv(false)).HAPI_DISABLE_PEER_TOOLS).toBe('0');
    });

    it('keeps a machine-level deploy override authoritative over the snapshot', async () => {
        process.env.HAPI_DISABLE_PEER_TOOLS = '1';
        expect((await spawnedEnv(false)).HAPI_DISABLE_PEER_TOOLS).toBe('1');
    });

    it('falls back to the module state when no snapshot was captured', async () => {
        delete process.env.HAPI_DISABLE_PEER_TOOLS;
        expect((await spawnedEnv()).HAPI_DISABLE_PEER_TOOLS).toBe('0');
    });
});
