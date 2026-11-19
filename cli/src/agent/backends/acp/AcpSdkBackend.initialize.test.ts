import { describe, expect, it, vi } from 'vitest';
import type { AcpStdioTransport } from './AcpStdioTransport';

const transportState = vi.hoisted(() => ({
    registerRequestHandler: vi.fn<AcpStdioTransport['registerRequestHandler']>(),
    calls: [] as Array<{ method: string; params?: unknown }>
}));

vi.mock('./AcpStdioTransport', () => {
    class MockAcpStdioTransport {
        static async create(_options: unknown) {
            return new MockAcpStdioTransport();
        }
        onNotification = vi.fn();
        onStderrError = vi.fn();
        registerRequestHandler = transportState.registerRequestHandler;
        sendRequest = vi.fn(async (method: string, params?: unknown) => {
            transportState.calls.push({ method, params });
            if (method === 'initialize') {
                return { protocolVersion: 1, authMethods: [] };
            }
            return null;
        });
        close = vi.fn(async () => {});
    }
    // AcpSdkBackend imports this alongside the transport class; keep the
    // mock module shape complete.
    return {
        AcpStdioTransport: MockAcpStdioTransport,
        isAcpIndeterminateError: (error: unknown) =>
            typeof error === 'object'
            && error !== null
            && (error as Record<symbol, unknown>)[Symbol.for('acp-indeterminate')] === true
    };
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
    it.each(['opencode', 'agy'] as const)('wires form request lifetime for %s only as supported', async (flavor) => {
        transportState.registerRequestHandler.mockClear();
        const backend = new AcpSdkBackend({ command: flavor, flavor, elicitationForm: true });
        const receiveForm = vi.fn(async (_request: { signal?: AbortSignal }) => ({ action: 'cancel' as const }));
        backend.onFormElicitation(receiveForm);
        await backend.initialize();

        const registration = transportState.registerRequestHandler.mock.calls.find(([method]) => method === 'elicitation/create');
        expect(registration?.[2]).toEqual({ cancellable: flavor === 'opencode' });
        if (flavor === 'opencode') {
            const withdrawal = new AbortController();
            await registration![1]({ mode: 'form', sessionId: 'session-1', requestedSchema: {} }, 0, withdrawal.signal);
            const signal = receiveForm.mock.calls[0]?.[0].signal;
            expect(signal?.aborted).toBe(false);
            withdrawal.abort();
            expect(signal?.aborted).toBe(true);
        }
    });

    it('advertises form elicitation only when enabled', async () => {
        transportState.calls.length = 0;
        await new AcpSdkBackend({ command: 'opencode', args: ['acp'] }).initialize();
        await new AcpSdkBackend({ command: 'opencode', args: ['acp'], elicitationForm: true }).initialize();

        const capabilities = transportState.calls
            .filter((call) => call.method === 'initialize')
            .map((call) => (call.params as { clientCapabilities: Record<string, unknown> }).clientCapabilities);
        expect(capabilities).toHaveLength(2);
        expect(capabilities[0]).not.toHaveProperty('elicitation');
        expect(capabilities[1]).toMatchObject({ elicitation: { form: {} } });
    });
});
