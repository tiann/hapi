import { describe, expect, it, vi } from 'vitest';
import { AcpSdkBackend } from './AcpSdkBackend';

type Internal = {
    handleElicitationRequest: (params: unknown) => Promise<unknown>;
    transport: { sendNotification: (method: string, params: unknown) => void; close: () => Promise<void> } | null;
};

const formParams = {
    mode: 'form',
    sessionId: 'session-1',
    toolCallId: 'call-1',
    message: 'Questions',
    requestedSchema: { type: 'object', properties: { q0: { type: 'string' } }, required: [] }
};

function createBackend() {
    const backend = new AcpSdkBackend({ command: 'opencode', elicitationForm: true });
    const internal = backend as unknown as Internal;
    const notifications: Array<{ method: string; params: unknown }> = [];
    internal.transport = {
        sendNotification: (method, params) => notifications.push({ method, params }),
        close: async () => {}
    };
    return { backend, internal, notifications };
}

describe('AcpSdkBackend form elicitation', () => {
    it('passes the form to the handler and returns its answer', async () => {
        const { backend, internal } = createBackend();
        const handler = vi.fn(async () => ({ action: 'accept' as const, content: { q0: '승인' } }));
        backend.onFormElicitation(handler);

        await expect(internal.handleElicitationRequest(formParams)).resolves.toEqual({
            action: 'accept',
            content: { q0: '승인' }
        });
        expect(handler).toHaveBeenCalledWith({
            sessionId: 'session-1',
            toolCallId: 'call-1',
            message: 'Questions',
            requestedSchema: formParams.requestedSchema
        });
    });

    it('passes a decline back to the agent', async () => {
        const { backend, internal } = createBackend();
        backend.onFormElicitation(async () => ({ action: 'decline' }));

        await expect(internal.handleElicitationRequest(formParams)).resolves.toEqual({ action: 'decline' });
    });

    it('cancels when no handler is registered', async () => {
        const { internal } = createBackend();

        await expect(internal.handleElicitationRequest(formParams)).resolves.toEqual({ action: 'cancel' });
    });

    it('cancels url mode and malformed requests without calling the handler', async () => {
        const { backend, internal } = createBackend();
        const handler = vi.fn(async () => ({ action: 'accept' as const, content: {} }));
        backend.onFormElicitation(handler);

        await expect(internal.handleElicitationRequest({ ...formParams, mode: 'url' })).resolves.toEqual({ action: 'cancel' });
        await expect(internal.handleElicitationRequest(null)).resolves.toEqual({ action: 'cancel' });
        await expect(internal.handleElicitationRequest({ mode: 'form', message: 'x' })).resolves.toEqual({ action: 'cancel' });
        expect(handler).not.toHaveBeenCalled();
    });

    it('cancels when the handler throws', async () => {
        const { backend, internal } = createBackend();
        backend.onFormElicitation(async () => {
            throw new Error('boom');
        });

        await expect(internal.handleElicitationRequest(formParams)).resolves.toEqual({ action: 'cancel' });
    });

    it('settles a pending form with cancel when the prompt is cancelled', async () => {
        const { backend, internal, notifications } = createBackend();
        backend.onFormElicitation(() => new Promise(() => {}));

        const pending = internal.handleElicitationRequest(formParams);
        await backend.cancelPrompt('session-1');

        await expect(pending).resolves.toEqual({ action: 'cancel' });
        expect(notifications).toEqual([{ method: 'session/cancel', params: { sessionId: 'session-1' } }]);
    });

    it('keeps forms of other sessions pending when one session is cancelled', async () => {
        const { backend, internal } = createBackend();
        backend.onFormElicitation(() => new Promise(() => {}));

        let settled = false;
        void internal.handleElicitationRequest({ ...formParams, sessionId: 'session-2' }).then(() => {
            settled = true;
        });
        await backend.cancelPrompt('session-1');
        await Promise.resolve();

        expect(settled).toBe(false);
    });

    it('settles pending forms with cancel on disconnect', async () => {
        const { backend, internal } = createBackend();
        backend.onFormElicitation(() => new Promise(() => {}));

        const pending = internal.handleElicitationRequest(formParams);
        await backend.disconnect();

        await expect(pending).resolves.toEqual({ action: 'cancel' });
    });

    it('does not let a late handler answer overwrite the cancel', async () => {
        const { backend, internal } = createBackend();
        let answer!: (value: { action: 'accept'; content: Record<string, string> }) => void;
        backend.onFormElicitation(() => new Promise((resolve) => {
            answer = resolve;
        }));

        const pending = internal.handleElicitationRequest(formParams);
        await backend.cancelPrompt('session-1');
        answer({ action: 'accept', content: { q0: '승인' } });

        await expect(pending).resolves.toEqual({ action: 'cancel' });
    });
});
