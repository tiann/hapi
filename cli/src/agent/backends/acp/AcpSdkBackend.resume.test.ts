import { beforeEach, describe, expect, it, vi } from 'vitest';

const transportState = vi.hoisted(() => ({
    calls: [] as Array<{ method: string; params?: unknown }>,
    initializeResponse: {} as Record<string, unknown>,
    resumeResponse: { configOptions: [] } as Record<string, unknown>
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
                return transportState.initializeResponse;
            }
            if (method === 'session/resume') {
                return transportState.resumeResponse;
            }
            return null;
        });
        sendNotification = vi.fn();
        close = vi.fn(async () => {});
    }
    return { AcpStdioTransport: MockAcpStdioTransport };
});

import { AcpSdkBackend } from './AcpSdkBackend';

describe('AcpSdkBackend.sessionResume', () => {
    beforeEach(() => {
        transportState.calls = [];
        transportState.initializeResponse = { protocolVersion: 1, authMethods: [] };
        transportState.resumeResponse = { configOptions: [] };
    });

    it('probes the resume capability independently of loadSession', async () => {
        transportState.initializeResponse = {
            protocolVersion: 1,
            agentCapabilities: {
                // dsh 0.2.x: no legacy loadSession flag, resume under sessionCapabilities.
                sessionCapabilities: { close: {}, list: {}, resume: {} }
            }
        };
        const backend = new AcpSdkBackend({ command: 'agent', args: ['acp'] });
        await backend.initialize();

        expect(backend.supportsLoadSession()).toBe(false);
        expect(backend.supportsSessionResume()).toBe(true);
    });

    it('reports no resume support for agents that stay silent about session capabilities', async () => {
        const backend = new AcpSdkBackend({ command: 'agent', args: ['acp'] });
        await backend.initialize();

        expect(backend.supportsSessionResume()).toBe(false);
    });

    it('resumes via session/resume and keeps the requested id when none is returned', async () => {
        transportState.initializeResponse = {
            protocolVersion: 1,
            agentCapabilities: {
                sessionCapabilities: { close: {}, list: {}, resume: {} }
            }
        };
        const backend = new AcpSdkBackend({ command: 'agent', args: ['acp'] });
        await backend.initialize();

        const sessionId = await backend.resumeSession({
            sessionId: 'dsh-stored-1',
            cwd: '/tmp',
            mcpServers: []
        });

        expect(transportState.calls).toContainEqual({
            method: 'session/resume',
            params: { sessionId: 'dsh-stored-1', cwd: '/tmp', mcpServers: [] }
        });
        expect(sessionId).toBe('dsh-stored-1');
    });

    it('prefers the sessionId returned by the agent when present', async () => {
        transportState.initializeResponse = {
            protocolVersion: 1,
            agentCapabilities: {
                sessionCapabilities: { close: {}, list: {}, resume: {} }
            }
        };
        transportState.resumeResponse = { sessionId: 'remapped-1' };
        const backend = new AcpSdkBackend({ command: 'agent', args: ['acp'] });
        await backend.initialize();

        const sessionId = await backend.resumeSession({
            sessionId: 'dsh-stored-1',
            cwd: '/tmp',
            mcpServers: []
        });

        expect(sessionId).toBe('remapped-1');
    });
});
