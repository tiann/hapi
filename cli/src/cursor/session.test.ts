import { describe, expect, it, vi } from 'vitest';
import { MessageQueue2 } from '@/utils/MessageQueue2';
import { CursorSession } from './session';
import type { EnhancedMode } from './loop';

describe('CursorSession', () => {
    it('onSessionFoundWithProtocol writes cursorSessionId and protocol to metadata', () => {
        const updates: unknown[] = [];
        const client = {
            updateMetadata: vi.fn((handler: (metadata: Record<string, unknown>) => Record<string, unknown>) => {
                updates.push(handler({ path: '/tmp', host: 'h', flavor: 'cursor' }));
            }),
            keepAlive: vi.fn(),
            emitMessagesConsumed: vi.fn()
        };

        const session = new CursorSession({
            api: {} as never,
            client: client as never,
            path: '/tmp',
            logPath: '/tmp/log',
            sessionId: null,
            messageQueue: new MessageQueue2<EnhancedMode>(() => 'hash'),
            onModeChange: vi.fn(),
            startedBy: 'runner',
            startingMode: 'remote',
            mode: 'remote'
        });

        session.onSessionFoundWithProtocol('acp-session-99', 'acp');

        expect(session.sessionId).toBe('acp-session-99');
        expect(updates[0]).toEqual({
            path: '/tmp',
            host: 'h',
            flavor: 'cursor',
            cursorSessionId: 'acp-session-99',
            cursorSessionProtocol: 'acp'
        });
    });

    it('notifies onPermissionModeChanged so runCursor enqueue mode stays in sync', () => {
        const onPermissionModeChanged = vi.fn();
        const session = new CursorSession({
            api: {} as never,
            client: {
                updateMetadata: vi.fn(),
                keepAlive: vi.fn(),
                emitMessagesConsumed: vi.fn()
            } as never,
            path: '/tmp',
            logPath: '/tmp/log',
            sessionId: null,
            messageQueue: new MessageQueue2<EnhancedMode>(() => 'hash'),
            onModeChange: vi.fn(),
            startedBy: 'runner',
            startingMode: 'remote',
            mode: 'remote',
            permissionMode: 'plan',
            onPermissionModeChanged
        });

        session.setPermissionMode('default');

        expect(session.getPermissionMode()).toBe('default');
        expect(onPermissionModeChanged).toHaveBeenCalledWith('default');
    });

    it('requires a live ACP mode handler and keeps legacy deferred updates', async () => {
        const onPermissionModeChanged = vi.fn();
        const options = {
            api: {} as never,
            client: { keepAlive: vi.fn(), emitMessagesConsumed: vi.fn() } as never,
            path: '/tmp',
            logPath: '/tmp/log',
            sessionId: null,
            messageQueue: new MessageQueue2<EnhancedMode>(() => 'hash'),
            onModeChange: vi.fn(),
            startedBy: 'runner',
            startingMode: 'remote',
            mode: 'remote',
            permissionMode: 'plan',
            onPermissionModeChanged
        } as const;
        const acp = new CursorSession(options);
        const legacy = new CursorSession({ ...options, remoteProtocol: 'stream-json' });
        try {
            await expect(acp.applyPermissionModeConfig('default')).rejects.toThrow('not ready');
            expect(acp.getPermissionMode()).toBe('plan');
            expect(onPermissionModeChanged).not.toHaveBeenCalled();

            const removeHandler = acp.registerPermissionModeApplyHandler(async (mode) => {
                acp.setPermissionMode(mode);
                return mode;
            });
            await expect(acp.applyPermissionModeConfig('default')).resolves.toBe('default');
            expect(acp.getPermissionMode()).toBe('default');
            removeHandler();
            await expect(acp.applyPermissionModeConfig('plan')).rejects.toThrow('not ready');
            expect(acp.getPermissionMode()).toBe('default');
            acp.onModeChange('local');
            await expect(acp.applyPermissionModeConfig('plan')).rejects.toThrow('handing off the Cursor terminal session');
            expect(acp.getPermissionMode()).toBe('default');

            await expect(legacy.applyPermissionModeConfig('default')).resolves.toBe('default');
            expect(legacy.getPermissionMode()).toBe('default');
            expect(onPermissionModeChanged).toHaveBeenCalledTimes(2);
        } finally {
            acp.stopKeepAlive();
            legacy.stopKeepAlive();
        }
    });
});
