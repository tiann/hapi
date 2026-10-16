import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CodexRuntimeRecord } from './registry';

const state = vi.hoisted(() => ({ alive: true, initialize: vi.fn(), request: vi.fn(), disconnect: vi.fn() }));
vi.mock('./registry', () => ({ runtimeAlive: () => state.alive }));
vi.mock('./runtime', () => ({ runSharedRuntime: vi.fn() }));
vi.mock('../codexAppServerClient', () => ({ CodexAppServerClient: class {
    setServerRequestHandler() {}
    async connect() {}
    initialize = state.initialize;
    request = state.request;
    disconnect = state.disconnect;
} }));
import { runtimeControl } from './frontend';

const runtime = { endpoint: 'unix://test' } as CodexRuntimeRecord;
beforeEach(() => { vi.resetAllMocks(); state.alive = true; });

describe('bounded shared runtime control', () => {
    it('detaches its control client after a confirmed reconnect', async () => {
        state.request.mockResolvedValue({ connected: true });
        await expect(runtimeControl(runtime, 'hapi/reconnectSession', 'sid', { timeoutMs: 100 }))
            .resolves.toEqual({ connected: true });
        expect(state.request).toHaveBeenCalledExactlyOnceWith('hapi/reconnectSession', { sessionId: 'sid' });
        expect(state.disconnect).toHaveBeenCalledOnce();
    });

    it('does not send a late control request after initialization exceeds the deadline', async () => {
        let finish!: () => void;
        state.initialize.mockImplementation(() => new Promise<void>(resolve => { finish = resolve; }));
        await expect(runtimeControl(runtime, 'hapi/reconnectSession', 'sid', { timeoutMs: 10 }))
            .rejects.toThrow('timed out');
        expect(state.disconnect).toHaveBeenCalledOnce();
        finish();
        await Promise.resolve();
        await Promise.resolve();
        expect(state.request).not.toHaveBeenCalled();
    });

    it('requires a verified live generation before connecting', async () => {
        state.alive = false;
        await expect(runtimeControl(runtime, 'hapi/reconnectSession', 'sid', { timeoutMs: 10 }))
            .rejects.toThrow('not alive');
        expect(state.initialize).not.toHaveBeenCalled();
        expect(state.request).not.toHaveBeenCalled();
    });
});
