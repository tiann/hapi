import { describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    sessions: [] as Array<{ onSessionFound: ReturnType<typeof vi.fn> }>,
    runLocalRemoteSession: vi.fn(async () => {})
}));

vi.mock('./session', () => ({
    GrokSession: class {
        onSessionFound = vi.fn();
        constructor() {
            mocks.sessions.push(this);
        }
    }
}));

vi.mock('@/agent/loopBase', () => ({
    runLocalRemoteSession: mocks.runLocalRemoteSession
}));

import { grokLoop } from './loop';

describe('grokLoop native identity publication', () => {
    it('does not publish a requested resume id before the provider confirms it', async () => {
        await grokLoop({
            path: '/repo',
            startingMode: 'remote',
            startedBy: 'runner',
            onModeChange: vi.fn(),
            messageQueue: {} as never,
            session: {} as never,
            api: {} as never,
            permissionMode: 'default',
            resumeSessionId: 'requested-native-session'
        });

        expect(mocks.sessions).toHaveLength(1);
        expect(mocks.sessions[0]?.onSessionFound).not.toHaveBeenCalled();
    });
});
