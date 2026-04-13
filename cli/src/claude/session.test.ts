import { describe, expect, it, vi } from 'vitest';
import { MessageQueue2 } from '@/utils/MessageQueue2';
import { Session } from './session';
import type { EnhancedMode } from './loop';

describe('Claude Session.clearSessionId', () => {
    it('removes the persisted Claude session token from metadata', () => {
        let clearedMetadata: Record<string, unknown> | null = null;

        const client = {
            keepAlive: vi.fn(),
            updateMetadata: vi.fn((handler: (metadata: Record<string, unknown>) => Record<string, unknown>) => {
                clearedMetadata = handler({
                    path: '/tmp/project',
                    claudeSessionId: 'claude-session-123'
                });
            }),
            rpcHandlerManager: {}
        };

        const session = new Session({
            api: {} as never,
            client: client as never,
            path: '/tmp/project',
            logPath: '/tmp/project/hapi.log',
            sessionId: 'claude-session-123',
            mcpServers: {},
            messageQueue: new MessageQueue2<EnhancedMode>((mode) => JSON.stringify(mode)),
            onModeChange: () => {},
            startedBy: 'terminal',
            startingMode: 'remote',
            hookSettingsPath: '/tmp/hooks.json',
            permissionMode: 'default'
        });

        try {
            session.clearSessionId();

            expect(session.sessionId).toBeNull();
            expect(client.updateMetadata).toHaveBeenCalledTimes(1);
            expect(clearedMetadata).toEqual({
                path: '/tmp/project'
            });
        } finally {
            session.stopKeepAlive();
        }
    });

    it('removes stale persisted Claude session metadata even if the in-memory session id is already null', () => {
        let clearedMetadata: Record<string, unknown> | null = null;

        const client = {
            keepAlive: vi.fn(),
            updateMetadata: vi.fn((handler: (metadata: Record<string, unknown>) => Record<string, unknown>) => {
                clearedMetadata = handler({
                    path: '/tmp/project',
                    claudeSessionId: 'stale-claude-session'
                });
            }),
            rpcHandlerManager: {}
        };

        const session = new Session({
            api: {} as never,
            client: client as never,
            path: '/tmp/project',
            logPath: '/tmp/project/hapi.log',
            sessionId: null,
            mcpServers: {},
            messageQueue: new MessageQueue2<EnhancedMode>((mode) => JSON.stringify(mode)),
            onModeChange: () => {},
            startedBy: 'terminal',
            startingMode: 'remote',
            hookSettingsPath: '/tmp/hooks.json',
            permissionMode: 'default'
        });

        try {
            session.clearSessionId();

            expect(session.sessionId).toBeNull();
            expect(client.updateMetadata).toHaveBeenCalledTimes(1);
            expect(clearedMetadata).toEqual({
                path: '/tmp/project'
            });
        } finally {
            session.stopKeepAlive();
        }
    });
});
