import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildCopilotLocalArgs, copilotLocal } from './copilotLocal';
import { spawnWithTerminalGuard } from '@/utils/spawnWithTerminalGuard';
import { getAgentLaunchCommand } from '@/agent/agentLaunchCommand';
import { resetPeerToolsForTests } from '@/modules/common/peerTools';

vi.mock('@/utils/spawnWithTerminalGuard', () => ({
    spawnWithTerminalGuard: vi.fn(async () => {})
}));

vi.mock('@/agent/agentLaunchCommand', () => ({
    getAgentLaunchCommand: vi.fn(() => 'copilot')
}));

const originalPlatformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform');

afterEach(() => {
    if (originalPlatformDescriptor) Object.defineProperty(process, 'platform', originalPlatformDescriptor);
});

describe('buildCopilotLocalArgs', () => {
    it('builds resume, model, approval, and mode arguments', () => {
        expect(buildCopilotLocalArgs({ sessionId: 'session-1', model: 'gpt-5', yolo: true, agentMode: 'plan' }))
            .toEqual(['--resume=session-1', '--model', 'gpt-5', '--allow-all', '--mode', 'plan']);
    });

    it('rejects shell metacharacters in dynamic Windows arguments', () => {
        Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });

        expect(() => buildCopilotLocalArgs({ sessionId: 'session&whoami' })).toThrow('Invalid sessionId');
        expect(() => buildCopilotLocalArgs({ sessionId: 'session-1', model: 'gpt|whoami' })).toThrow('Invalid model');
    });
});

describe('copilotLocal peer-tools child env (#2056)', () => {
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
        await copilotLocal({
            path: '/work',
            sessionId: 'copilot-session-1',
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
