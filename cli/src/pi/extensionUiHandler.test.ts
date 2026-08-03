import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PiExtensionUiHandler } from './extensionUiHandler';

type PermissionHandler = (response: unknown) => Promise<void>;

function createHarness() {
    let permissionHandler: PermissionHandler | null = null;
    let state: Record<string, unknown> = { requests: {}, completedRequests: {} };
    const session = {
        rpcHandlerManager: {
            registerHandler: vi.fn((_method: unknown, handler: PermissionHandler) => { permissionHandler = handler; }),
        },
        updateAgentState: vi.fn((updater: (current: never) => unknown) => { state = updater(state as never) as Record<string, unknown>; }),
        sendSessionEvent: vi.fn(),
        getMetadata: vi.fn(() => null),
        updateMetadata: vi.fn(),
    };
    const sendResponse = vi.fn();
    const handler = new PiExtensionUiHandler({ session: session as never, sendResponse });
    return {
        handler,
        session,
        sendResponse,
        state: () => state,
        respond: async (response: unknown) => permissionHandler?.(response),
    };
}

describe('PiExtensionUiHandler', () => {
    beforeEach(() => vi.useRealTimers());

    it('maps select into request_user_input and returns its selected option', async () => {
        const harness = createHarness();
        harness.handler.handle({ type: 'extension_ui_request', id: 'select-1', method: 'select', title: 'Pick', options: ['one', 'two'] });
        expect(harness.state().requests).toMatchObject({
            'select-1': { tool: 'request_user_input', arguments: { questions: [{ id: 'select-1', options: [{ label: 'one' }, { label: 'two' }] }] } },
        });

        await harness.respond({
            id: 'select-1',
            approved: true,
            answers: { 'select-1': { answers: ['two', 'user_note: optional note'] } }
        });
        expect(harness.sendResponse).toHaveBeenCalledWith({ type: 'extension_ui_response', id: 'select-1', value: 'two' });
        expect(harness.state().completedRequests).toMatchObject({ 'select-1': { status: 'approved' } });
    });

    it('maps confirm to the generic permission card and retains a denied history entry', async () => {
        const harness = createHarness();
        harness.handler.handle({ type: 'extension_ui_request', id: 'confirm-1', method: 'confirm', title: 'Proceed?', message: 'Continue this extension?' });
        expect(harness.state().requests).toMatchObject({ 'confirm-1': { tool: 'PiExtensionConfirm' } });

        // The normal Hub deny route omits an explicit decision.
        await harness.respond({ id: 'confirm-1', approved: false });
        expect(harness.sendResponse).toHaveBeenCalledWith({ type: 'extension_ui_response', id: 'confirm-1', confirmed: false });
        expect(harness.state().completedRequests).toMatchObject({ 'confirm-1': { status: 'denied', decision: 'denied' } });
    });

    it('preserves editor prefill and cancels timeout/session shutdown exactly once', async () => {
        vi.useFakeTimers();
        const harness = createHarness();
        harness.handler.handle({ type: 'extension_ui_request', id: 'editor-1', method: 'editor', title: 'Edit', prefill: 'existing text' });
        expect(harness.state().requests).toMatchObject({
            'editor-1': { arguments: { questions: [{ inputType: 'editor', prefill: 'existing text' }] } },
        });
        harness.handler.cancelAll('session shutdown');
        expect(harness.sendResponse).toHaveBeenCalledWith({ type: 'extension_ui_response', id: 'editor-1', cancelled: true });
        expect(harness.state().completedRequests).toMatchObject({ 'editor-1': { status: 'canceled', decision: 'abort' } });

        harness.handler.handle({ type: 'extension_ui_request', id: 'input-1', method: 'input', title: 'Name', placeholder: 'Ada', timeout: 50 });
        await vi.advanceTimersByTimeAsync(50);
        expect(harness.sendResponse).toHaveBeenLastCalledWith({ type: 'extension_ui_response', id: 'input-1', cancelled: true });

        harness.handler.handle({ type: 'extension_ui_request', id: 'no-timeout', method: 'input', title: 'Name', timeout: 0 });
        await vi.advanceTimersByTimeAsync(1_000);
        expect(harness.sendResponse).not.toHaveBeenLastCalledWith({ type: 'extension_ui_response', id: 'no-timeout', cancelled: true });
    });

    it('puts notify on the timeline and ignores unsupported transient UI operations', () => {
        const harness = createHarness();
        harness.handler.handle({ type: 'extension_ui_request', id: 'notice', method: 'notify', message: 'Heads up', notifyType: 'warning' });
        harness.handler.handle({ type: 'extension_ui_request', id: 'status', method: 'setStatus', statusKey: 'x', statusText: 'busy' });
        expect(harness.session.sendSessionEvent).toHaveBeenCalledWith({ type: 'message', message: '[Pi warning] Heads up' });
    });
});


describe('PiExtensionUiHandler duplicate ids', () => {
    it('tombstones a reused id so delayed approval cannot bind a replacement dialog', async () => {
        const harness = createHarness();
        harness.handler.handle({ type: 'extension_ui_request', id: 'same', method: 'input', title: 'First' });
        harness.handler.handle({ type: 'extension_ui_request', id: 'same', method: 'input', title: 'Second' });
        expect(harness.sendResponse).toHaveBeenCalledWith({ type: 'extension_ui_response', id: 'same', cancelled: true });
        await harness.respond({ id: 'same', approved: true, answers: { same: { answers: ['user_note: late'] } } });
        expect(harness.sendResponse).toHaveBeenCalledTimes(1);
        expect(harness.session.sendSessionEvent).toHaveBeenCalledWith(expect.objectContaining({ type: 'message', message: expect.stringContaining('id was reused') }));
    });
});
