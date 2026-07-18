import { describe, expect, it, vi } from 'vitest';
import { MessageQueue2 } from '@/utils/MessageQueue2';
import { Session } from './session';
import type { EnhancedMode } from './loop';

function createSession(overrides?: Partial<{ permissionMode: 'default' | 'acceptEdits' | 'plan' | 'auto' | 'bypassPermissions' }>) {
    const client = {
        keepAlive: vi.fn(),
        updateMetadata: vi.fn(),
        emitMessagesConsumed: vi.fn()
    };
    return new Session({
        api: {} as never,
        client: client as never,
        path: '/tmp',
        logPath: '/tmp/log',
        sessionId: null,
        mcpServers: {},
        messageQueue: new MessageQueue2<EnhancedMode>(() => 'hash'),
        onModeChange: vi.fn(),
        startedBy: 'runner',
        startingMode: 'remote',
        mode: 'remote',
        hookSettingsPath: '/tmp/hooks.json',
        permissionMode: overrides?.permissionMode
    });
}

describe('Session (claude) setPermissionMode', () => {
    it('fires the config-change handler when the mode actually changes', () => {
        const session = createSession({ permissionMode: 'default' });
        const handler = vi.fn();
        session.setConfigChangeHandler(handler);

        session.setPermissionMode('plan');

        expect(session.getPermissionMode()).toBe('plan');
        expect(handler).toHaveBeenCalledTimes(1);
    });

    it('does NOT fire the config-change handler when the mode is unchanged (matches setModel/setEffort dedup)', () => {
        const session = createSession({ permissionMode: 'acceptEdits' });
        const handler = vi.fn();
        session.setConfigChangeHandler(handler);

        session.setPermissionMode('acceptEdits');

        expect(handler).not.toHaveBeenCalled();
    });

    it('fires on every distinct change across multiple calls', () => {
        const session = createSession({ permissionMode: 'default' });
        const handler = vi.fn();
        session.setConfigChangeHandler(handler);

        session.setPermissionMode('acceptEdits');
        session.setPermissionMode('acceptEdits');
        session.setPermissionMode('plan');

        expect(handler).toHaveBeenCalledTimes(2);
    });

    it('does NOT fire the config-change handler when called with { notify: false }, even on a real change', () => {
        // Used by back-sync (claude self-reporting its live mode via the
        // PreToolUse hook): the mode is already what claude is actually running,
        // so re-notifying the PTY launcher would trigger a pointless respawn
        // (hostile-review finding #1: back-sync re-entering the respawn path).
        const session = createSession({ permissionMode: 'default' });
        const handler = vi.fn();
        session.setConfigChangeHandler(handler);

        session.setPermissionMode('plan', { notify: false });

        expect(session.getPermissionMode()).toBe('plan');
        expect(handler).not.toHaveBeenCalled();
    });

    it('still updates bookkeeping under { notify: false } so a later distinct change notifies normally', () => {
        const session = createSession({ permissionMode: 'default' });
        const handler = vi.fn();
        session.setConfigChangeHandler(handler);

        session.setPermissionMode('plan', { notify: false });
        expect(handler).not.toHaveBeenCalled();

        // A later call back to 'default' is a real change relative to the
        // now-current 'plan' and must notify normally (default notify: true).
        session.setPermissionMode('default');
        expect(handler).toHaveBeenCalledTimes(1);
    });
});
