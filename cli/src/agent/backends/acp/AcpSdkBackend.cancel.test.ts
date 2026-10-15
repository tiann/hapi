import { beforeEach, describe, expect, it, vi } from 'vitest';

const transportState = vi.hoisted(() => ({
    calls: [] as Array<{ method: string; params?: unknown; options?: unknown }>,
    notifications: [] as Array<{ method: string; params?: unknown }>,
    initializeResponse: {} as Record<string, unknown>,
    failNextClose: false
}));

vi.mock('./AcpStdioTransport', () => {
    class MockAcpStdioTransport {
        static async create(_options: unknown) {
            return new MockAcpStdioTransport();
        }
        onNotification = vi.fn();
        onStderrError = vi.fn();
        registerRequestHandler = vi.fn();
        sendRequest = vi.fn(async (method: string, params?: unknown, options?: unknown) => {
            transportState.calls.push({ method, params, options });
            if (method === 'session/close' && transportState.failNextClose) {
                transportState.failNextClose = false;
                throw new Error('transport closed');
            }
            if (method === 'initialize') {
                return transportState.initializeResponse;
            }
            return null;
        });
        sendNotification = vi.fn((method: string, params?: unknown) => {
            transportState.notifications.push({ method, params });
        });
        close = vi.fn(async () => {});
    }
    return { AcpStdioTransport: MockAcpStdioTransport };
});

import { AcpSdkBackend } from './AcpSdkBackend';

function sentMethods(state: typeof transportState): string[] {
    return [...state.calls.map((call) => call.method), ...state.notifications.map((note) => note.method)];
}

describe('AcpSdkBackend.cancel', () => {
    beforeEach(() => {
        transportState.calls = [];
        transportState.notifications = [];
        transportState.initializeResponse = { protocolVersion: 1, authMethods: [] };
        transportState.failNextClose = false;
    });

    it('falls back to session/close when capabilities advertise sessions without cancel', async () => {
        transportState.initializeResponse = {
            protocolVersion: 1,
            agentCapabilities: {
                sessionCapabilities: { close: {}, list: {}, resume: {} }
            }
        };
        const backend = new AcpSdkBackend({ command: 'agent', args: ['acp'] });
        await backend.initialize();

        expect(backend.supportsCancelNotification()).toBe(false);

        await backend.cancelPrompt('session-1');

        // dsh-style capability set: closing the session is the only safe abort
        // — session/cancel kills the whole process.
        expect(transportState.calls).toContainEqual({
            method: 'session/close',
            params: { sessionId: 'session-1' },
            options: expect.objectContaining({ timeoutMs: 5000 })
        });
        expect(sentMethods(transportState)).not.toContain('session/cancel');
    });

    it('sends session/cancel when the cancel capability is advertised', async () => {
        transportState.initializeResponse = {
            protocolVersion: 1,
            agentCapabilities: {
                sessionCapabilities: { cancel: {}, close: {} }
            }
        };
        const backend = new AcpSdkBackend({ command: 'agent', args: ['acp'] });
        await backend.initialize();

        expect(backend.supportsCancelNotification()).toBe(true);

        await backend.cancelPrompt('session-1');

        expect(transportState.notifications).toContainEqual({
            method: 'session/cancel',
            params: { sessionId: 'session-1' }
        });
        expect(sentMethods(transportState)).not.toContain('session/close');
    });

    it('keeps session/cancel for agents that stay silent about session capabilities', async () => {
        // Positive-absence back-compat: zed-based flavors do not advertise
        // sessionCapabilities and previously received session/cancel.
        const backend = new AcpSdkBackend({ command: 'agent', args: ['acp'] });
        await backend.initialize();

        expect(backend.supportsCancelNotification()).toBe(true);

        await backend.cancelPrompt('session-1');

        expect(transportState.notifications).toContainEqual({
            method: 'session/cancel',
            params: { sessionId: 'session-1' }
        });
    });

    it('does nothing when capabilities advertise neither cancel nor close', async () => {
        transportState.initializeResponse = {
            protocolVersion: 1,
            agentCapabilities: {
                sessionCapabilities: { list: {} }
            }
        };
        const backend = new AcpSdkBackend({ command: 'agent', args: ['acp'] });
        await backend.initialize();

        expect(backend.supportsCancelNotification()).toBe(false);

        await backend.cancelPrompt('session-1');

        expect(sentMethods(transportState)).not.toContain('session/cancel');
        expect(sentMethods(transportState)).not.toContain('session/close');
    });

    it('swallows session/close fallback failures', async () => {
        transportState.initializeResponse = {
            protocolVersion: 1,
            agentCapabilities: {
                sessionCapabilities: { close: {} }
            }
        };
        const backend = new AcpSdkBackend({ command: 'agent', args: ['acp'] });
        await backend.initialize();

        // Transport rejects (agent already gone, timeout, ...) — cancelPrompt
        // must not surface the error to the abort path.
        transportState.failNextClose = true;

        await expect(backend.cancelPrompt('session-1')).resolves.toBeUndefined();
    });
});
