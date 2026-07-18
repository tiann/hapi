import { afterEach, describe, expect, it, vi } from 'vitest';
import { MessageQueue2 } from '@/utils/MessageQueue2';
import { GrokSession } from './session';
import type { GrokMode, PermissionMode } from './types';

const sessions: GrokSession[] = [];

function createSession(permissionMode: PermissionMode): GrokSession {
    const client = {
        keepAlive: vi.fn(),
        updateMetadata: vi.fn(),
        sendAgentMessage: vi.fn(),
        sendUserMessage: vi.fn(),
        sendSessionEvent: vi.fn()
    };
    const session = new GrokSession({
        api: {} as never,
        client: client as never,
        path: '/repo',
        logPath: '/tmp/grok.log',
        sessionId: 'grok-session',
        messageQueue: new MessageQueue2<GrokMode>((mode) => JSON.stringify(mode)),
        onModeChange: vi.fn(),
        mode: 'remote',
        startedBy: 'terminal',
        startingMode: 'remote',
        permissionMode
    });
    sessions.push(session);
    return session;
}

afterEach(() => {
    for (const session of sessions.splice(0)) session.stopKeepAlive();
});

describe('GrokSession.applyRuntimeConfig', () => {
    it('applies permission changes that preserve the native sandbox profile', async () => {
        const session = createSession('default');
        const backendConfig = vi.fn().mockResolvedValue({ model: 'grok-4.5' });
        session.setRuntimeConfigHandler(backendConfig);

        await expect(session.applyRuntimeConfig({
            permissionMode: 'safe-yolo', model: 'grok-4.5'
        })).resolves.toEqual({ permissionMode: 'safe-yolo', model: 'grok-4.5' });

        expect(session.getPermissionMode()).toBe('safe-yolo');
        expect(backendConfig).toHaveBeenCalledWith({ model: 'grok-4.5', effort: undefined });
    });

    it.each([
        ['default', 'read-only'],
        ['read-only', 'yolo'],
        ['yolo', 'safe-yolo']
    ] as const)('rejects a live sandbox-profile change from %s to %s', async (current, next) => {
        const session = createSession(current);
        const backendConfig = vi.fn();
        session.setRuntimeConfigHandler(backendConfig);

        await expect(session.applyRuntimeConfig({ permissionMode: next }))
            .rejects.toThrow(/new Grok session/i);

        expect(session.getPermissionMode()).toBe(current);
        expect(backendConfig).not.toHaveBeenCalled();
    });
});
