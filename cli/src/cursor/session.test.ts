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
});
