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

const DSH_SESSION_CAPS = {
    protocolVersion: 1,
    agentCapabilities: {
        sessionCapabilities: { close: {}, list: {}, resume: {} }
    }
};

describe('AcpSdkBackend.cancel', () => {
    beforeEach(() => {
        transportState.calls = [];
        transportState.notifications = [];
        transportState.initializeResponse = { protocolVersion: 1, authMethods: [] };
        transportState.failNextClose = false;
    });

    it('keeps the session/cancel baseline for standard adapters regardless of capabilities', async () => {
        // ACP v1 defines no cancel capability field: session/cancel is
        // unconditional baseline behavior. An agent advertising
        // sessionCapabilities without a cancel key (e.g. {close, list,
        // resume}) must still receive the standard notification.
        transportState.initializeResponse = DSH_SESSION_CAPS;
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

    it('keeps the session/cancel baseline for standard adapters that stay silent', async () => {
        const backend = new AcpSdkBackend({ command: 'agent', args: ['acp'] });
        await backend.initialize();

        expect(backend.supportsCancelNotification()).toBe(true);

        await backend.cancelPrompt('session-1');

        expect(transportState.notifications).toContainEqual({
            method: 'session/cancel',
            params: { sessionId: 'session-1' }
        });
    });

    it('cancels via session/close in close-fallback mode when close is advertised', async () => {
        transportState.initializeResponse = DSH_SESSION_CAPS;
        const backend = new AcpSdkBackend({ command: 'dsh', cancelMode: 'close-fallback' });
        await backend.initialize();

        expect(backend.supportsCancelNotification()).toBe(false);

        await backend.cancelPrompt('session-1');

        // dsh-style capability set: closing the session is the only safe
        // abort — the session/cancel notification kills the whole process.
        expect(transportState.calls).toContainEqual({
            method: 'session/close',
            params: { sessionId: 'session-1' },
            options: expect.objectContaining({ timeoutMs: 5000 })
        });
        expect(sentMethods(transportState)).not.toContain('session/cancel');
    });

    it('falls back to the session/cancel baseline in close-fallback mode without close', async () => {
        // No close advertised: there is nothing safer to try than the spec
        // baseline, even in close-fallback mode.
        transportState.initializeResponse = {
            protocolVersion: 1,
            agentCapabilities: {
                sessionCapabilities: { list: {} }
            }
        };
        const backend = new AcpSdkBackend({ command: 'dsh', cancelMode: 'close-fallback' });
        await backend.initialize();

        expect(backend.supportsCancelNotification()).toBe(true);

        await backend.cancelPrompt('session-1');

        expect(transportState.notifications).toContainEqual({
            method: 'session/cancel',
            params: { sessionId: 'session-1' }
        });
        expect(sentMethods(transportState)).not.toContain('session/close');
    });

    it('falls back to the session/cancel baseline in close-fallback mode when capabilities are silent', async () => {
        const backend = new AcpSdkBackend({ command: 'dsh', cancelMode: 'close-fallback' });
        await backend.initialize();

        expect(backend.supportsCancelNotification()).toBe(true);

        await backend.cancelPrompt('session-1');

        expect(transportState.notifications).toContainEqual({
            method: 'session/cancel',
            params: { sessionId: 'session-1' }
        });
    });

    it('swallows session/close failures in close-fallback mode', async () => {
        transportState.initializeResponse = DSH_SESSION_CAPS;
        const backend = new AcpSdkBackend({ command: 'dsh', cancelMode: 'close-fallback' });
        await backend.initialize();

        // Transport rejects (agent already gone, timeout, ...) — cancelPrompt
        // must not surface the error to the abort path.
        transportState.failNextClose = true;

        await expect(backend.cancelPrompt('session-1')).resolves.toBeUndefined();
    });
});
