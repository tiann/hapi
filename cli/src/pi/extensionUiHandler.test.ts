import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getExtensionUiCleanupTimeout, PiExtensionUiHandler } from './extensionUiHandler';

type PermissionHandler = (response: unknown) => Promise<void>;

function createHarness() {
    let permissionHandler: PermissionHandler | null = null;
    let state: Record<string, unknown> = { requests: {}, completedRequests: {} };
    const session = {
        rpcHandlerManager: {
            registerHandler: vi.fn((_method: unknown, handler: PermissionHandler) => { permissionHandler = handler; }),
        },
        updateAgentState: vi.fn((updater: (current: never) => unknown) => { state = updater(state as never) as Record<string, unknown>; }),
        sendAgentMessage: vi.fn(),
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
        expect(harness.session.sendAgentMessage).toHaveBeenCalledWith(expect.objectContaining({
            type: 'tool-call', callId: 'select-1', name: 'request_user_input', status: 'in_progress',
        }));

        await harness.respond({
            id: 'select-1',
            approved: true,
            answers: { 'select-1': { answers: ['two', 'user_note: optional note'] } }
        });
        expect(harness.sendResponse).toHaveBeenCalledWith({ type: 'extension_ui_response', id: 'select-1', value: 'two' });
        expect(harness.session.sendAgentMessage).toHaveBeenCalledWith({
            type: 'tool-call-result',
            callId: 'select-1',
            output: { 'select-1': { answers: ['two', 'user_note: optional note'] } },
            is_error: false,
        });
        expect(harness.state().completedRequests).toMatchObject({ 'select-1': { status: 'approved' } });
    });

    it('round-trips select options that use metadata-like prefixes or padded labels', async () => {
        const harness = createHarness();
        harness.handler.handle({
            type: 'extension_ui_request', id: 'select-prefix', method: 'select', title: 'Pick',
            options: ['user_note: later', '  padded option  '],
        });
        await harness.respond({
            id: 'select-prefix', approved: true,
            answers: { 'select-prefix': { answers: ['user_note: later'] } },
        });
        expect(harness.sendResponse).toHaveBeenLastCalledWith({
            type: 'extension_ui_response', id: 'select-prefix', value: 'user_note: later',
        });

        harness.handler.handle({
            type: 'extension_ui_request', id: 'select-padded', method: 'select', title: 'Pick',
            options: ['  padded option  '],
        });
        await harness.respond({
            id: 'select-padded', approved: true,
            answers: { 'select-padded': { answers: ['padded option'] } },
        });
        expect(harness.sendResponse).toHaveBeenLastCalledWith({
            type: 'extension_ui_response', id: 'select-padded', value: '  padded option  ',
        });

        harness.handler.handle({
            type: 'extension_ui_request', id: 'select-exact-first', method: 'select', title: 'Pick',
            options: ['  padded option  ', 'padded option'],
        });
        await harness.respond({
            id: 'select-exact-first', approved: true,
            answers: { 'select-exact-first': { answers: ['padded option'] } },
        });
        expect(harness.sendResponse).toHaveBeenLastCalledWith({
            type: 'extension_ui_response', id: 'select-exact-first', value: 'padded option',
        });

        harness.handler.handle({
            type: 'extension_ui_request', id: 'select-ambiguous', method: 'select', title: 'Pick',
            options: [' padded option', 'padded option '],
        });
        await harness.respond({
            id: 'select-ambiguous', approved: true,
            answers: { 'select-ambiguous': { answers: ['padded option'] } },
        });
        expect(harness.sendResponse).toHaveBeenLastCalledWith({
            type: 'extension_ui_response', id: 'select-ambiguous', cancelled: true,
        });
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
        await vi.advanceTimersByTimeAsync(120_000);
        expect(harness.sendResponse).not.toHaveBeenCalled();
        harness.handler.cancelAll('session shutdown');
        expect(harness.sendResponse).toHaveBeenCalledWith({ type: 'extension_ui_response', id: 'editor-1', cancelled: true });
        expect(harness.state().completedRequests).toMatchObject({ 'editor-1': { status: 'canceled', decision: 'abort' } });

        harness.handler.handle({ type: 'extension_ui_request', id: 'input-1', method: 'input', title: 'Name', placeholder: 'Ada', timeout: 50 });
        await vi.advanceTimersByTimeAsync(38);
        expect(harness.sendResponse).toHaveBeenLastCalledWith({ type: 'extension_ui_response', id: 'input-1', cancelled: true });

        harness.handler.handle({ type: 'extension_ui_request', id: 'no-timeout', method: 'input', title: 'Name', timeout: 0 });
        await vi.advanceTimersByTimeAsync(1_000);
        expect(harness.sendResponse).not.toHaveBeenLastCalledWith({ type: 'extension_ui_response', id: 'no-timeout', cancelled: true });
    });

    it('returns editor whitespace and an intentionally empty document byte-for-byte', async () => {
        const harness = createHarness();
        harness.handler.handle({ type: 'extension_ui_request', id: 'editor-whitespace', method: 'editor', title: 'Edit' });
        await harness.respond({
            id: 'editor-whitespace', approved: true,
            answers: { 'editor-whitespace': { answers: ['user_note:   code\n'] } },
        });
        expect(harness.sendResponse).toHaveBeenCalledWith({
            type: 'extension_ui_response', id: 'editor-whitespace', value: '  code\n',
        });

        harness.handler.handle({ type: 'extension_ui_request', id: 'editor-empty', method: 'editor', title: 'Edit' });
        await harness.respond({
            id: 'editor-empty', approved: true,
            answers: { 'editor-empty': { answers: ['user_note: '] } },
        });
        expect(harness.sendResponse).toHaveBeenCalledWith({
            type: 'extension_ui_response', id: 'editor-empty', value: '',
        });
    });

    it('reserves a capped proportional margin before Pi expires the dialog', async () => {
        vi.useFakeTimers();
        expect(getExtensionUiCleanupTimeout(undefined)).toBeUndefined();
        expect(getExtensionUiCleanupTimeout(0)).toBeUndefined();
        expect(getExtensionUiCleanupTimeout(0.5)).toBe(0);
        expect(getExtensionUiCleanupTimeout(1)).toBe(0);
        expect(getExtensionUiCleanupTimeout(2)).toBe(1);
        expect(getExtensionUiCleanupTimeout(50)).toBe(38);
        expect(getExtensionUiCleanupTimeout(1_000)).toBe(900);
        expect(getExtensionUiCleanupTimeout(100_000)).toBe(95_000);

        const harness = createHarness();
        harness.handler.handle({ type: 'extension_ui_request', id: 'margin-1', method: 'input', title: 'Name', timeout: 1_000 });
        await vi.advanceTimersByTimeAsync(899);
        expect(harness.sendResponse).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(1);
        expect(harness.sendResponse).toHaveBeenCalledWith({ type: 'extension_ui_response', id: 'margin-1', cancelled: true });
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

    it('retires an id after normal completion and cancels any later reuse', async () => {
        const harness = createHarness();
        harness.handler.handle({ type: 'extension_ui_request', id: 'completed', method: 'input', title: 'First' });
        await harness.respond({ id: 'completed', approved: true, answers: { completed: { answers: ['user_note: accepted'] } } });
        harness.handler.handle({ type: 'extension_ui_request', id: 'completed', method: 'input', title: 'Replacement' });

        expect(harness.sendResponse).toHaveBeenNthCalledWith(1, { type: 'extension_ui_response', id: 'completed', value: 'accepted' });
        expect(harness.sendResponse).toHaveBeenNthCalledWith(2, { type: 'extension_ui_response', id: 'completed', cancelled: true });
        await harness.respond({ id: 'completed', approved: true, answers: { completed: { answers: ['user_note: late'] } } });
        expect(harness.sendResponse).toHaveBeenCalledTimes(2);
    });

    it('retires a timed-out id and immediately cancels a replacement dialog', async () => {
        vi.useFakeTimers();
        const harness = createHarness();
        harness.handler.handle({ type: 'extension_ui_request', id: 'timed-out', method: 'input', title: 'First', timeout: 50 });
        await vi.advanceTimersByTimeAsync(38);
        harness.handler.handle({ type: 'extension_ui_request', id: 'timed-out', method: 'input', title: 'Replacement' });

        expect(harness.sendResponse).toHaveBeenNthCalledWith(1, { type: 'extension_ui_response', id: 'timed-out', cancelled: true });
        expect(harness.sendResponse).toHaveBeenNthCalledWith(2, { type: 'extension_ui_response', id: 'timed-out', cancelled: true });
    });
});
