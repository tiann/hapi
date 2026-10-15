import { describe, expect, it, vi } from 'vitest';

const transportState = vi.hoisted(() => ({
    calls: [] as Array<{ method: string; params?: unknown }>,
    onClose: null as ((error: Error) => void) | null
}));

vi.mock('./AcpStdioTransport', () => {
    class MockAcpStdioTransport {
        static async create(_options: unknown) {
            return new MockAcpStdioTransport();
        }
        onNotification = vi.fn();
        onStderrError = vi.fn();
        onClose = vi.fn((handler: (error: Error) => void) => {
            transportState.onClose = handler;
        });
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

    it('forwards unexpected ACP transport closes to the registered owner', async () => {
        const backend = new AcpSdkBackend({ command: 'dsh-acp-demo' });
        const onClosed = vi.fn();
        const error = new Error('ACP process exited');

        backend.onTransportClosed(onClosed);
        await backend.initialize();
        transportState.onClose?.(error);

        expect(onClosed).toHaveBeenCalledWith(error);
    });
});
