import { describe, expect, it, vi } from 'vitest';

const transportState = vi.hoisted(() => ({
    calls: [] as Array<{ method: string; params?: unknown }>
}));

vi.mock('./AcpStdioTransport', () => {
    class MockAcpStdioTransport {
        static async create(_options: unknown) {
            return new MockAcpStdioTransport();
        }
        onNotification = vi.fn();
        onStderrError = vi.fn();
        registerRequestHandler = vi.fn();
        sendRequest = vi.fn(async (method: string, params?: unknown) => {
            transportState.calls.push({ method, params });
            if (method === 'initialize') {
                return { protocolVersion: 1, authMethods: [] };
            }
            return null;
        });
        close = vi.fn(async () => {});
    }
    return { AcpStdioTransport: MockAcpStdioTransport };
});

import { AcpSdkBackend } from './AcpSdkBackend';

describe('AcpSdkBackend.initialize', () => {
    it('advertises Cursor-compatible parameterized model picker support', async () => {
        const backend = new AcpSdkBackend({ command: 'agent', args: ['acp'] });

        await backend.initialize();

        expect(transportState.calls).toContainEqual({
            method: 'initialize',
            params: expect.objectContaining({
                clientCapabilities: expect.objectContaining({
                    _meta: expect.objectContaining({
                        parameterizedModelPicker: true
                    })
                })
            })
        });
    });

    it('advertises OpenCode child session updates only when enabled', async () => {
        transportState.calls.length = 0;
        await new AcpSdkBackend({ command: 'opencode', args: ['acp'] }).initialize();
        await new AcpSdkBackend({ command: 'opencode', args: ['acp'], childSessionUpdates: true }).initialize();

        const metas = transportState.calls
            .filter((call) => call.method === 'initialize')
            .map((call) => (call.params as { clientCapabilities: { _meta: Record<string, unknown> } }).clientCapabilities._meta);
        expect(metas).toHaveLength(2);
        expect(metas[0]).not.toHaveProperty(['opencode/child-session-updates']);
        expect(metas[1]).toMatchObject({ 'opencode/child-session-updates': true, parameterizedModelPicker: true });
    });
});
