import { describe, expect, it, vi } from 'vitest';
import { wireTransportEvents } from './loop';
import type { PiTransport } from './piTransport';
import { PiSession } from './session';
import type { CodexMessage } from '@/agent/messageConverter';

/** 1x1 red PNG. */
const ONE_PX_PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

function createHarness() {
    let listener: ((event: Record<string, unknown>) => void) | null = null;
    const order: string[] = [];
    const messages: CodexMessage[] = [];
    const transport = {
        onEvent: vi.fn((handler: (event: Record<string, unknown>) => void) => { listener = handler; }),
        send: vi.fn(),
    } as unknown as PiTransport;
    const client = {
        keepAlive: vi.fn(),
        updateMetadata: vi.fn(),
        emitMessagesConsumed: vi.fn(),
        sendSessionEvent: vi.fn(),
        updateAgentState: vi.fn(),
        emitSessionReady: vi.fn(),
        getMetadata: vi.fn(() => null),
        rpcHandlerManager: { registerHandler: vi.fn() },
    };
    const session = new PiSession({
        api: {} as never,
        client: {
            ...client,
            sendAgentMessage: vi.fn((msg: CodexMessage) => {
                order.push(`agent:${msg.type}`);
                messages.push(msg);
            }),
            sendSessionEvent: vi.fn((msg: { type: string }) => { order.push(`session:${msg.type}`); }),
        } as never,
        path: '/tmp/test',
        logPath: '/tmp/test.log',
        startedBy: 'terminal',
        startingMode: 'local',
        model: 'deepseek-v4-flash-0731',
    });

    const controller = wireTransportEvents(transport, session, []);

    return {
        emit: (event: Record<string, unknown>) => listener?.(event),
        order,
        messages,
        controller,
        flush: () => new Promise((resolve) => setTimeout(resolve, 0)),
    };
}


describe('Pi publish ordering (real converters)', () => {
    it('publishes inline images before a same-chunk extension notification', () => {
        const h = createHarness();
        h.emit({
            type: 'tool_execution_end', toolCallId: 'image', toolName: 'hapi_display_image',
            result: { content: [{ type: 'image', data: ONE_PX_PNG, mimeType: 'image/png' }] },
            isError: false,
        });
        h.emit({ type: 'extension_ui_request', id: 'notice', method: 'notify', message: 'Image ready', notifyType: 'info' });
        expect(h.order).toEqual(['agent:tool-call-result', 'agent:generated-image', 'session:message']);
    });
    it('publishes a tool-execution result before a later retry notice from the same chunk', async () => {
        const h = createHarness();

        h.emit({
            type: 'tool_execution_end',
            toolCallId: 'tc-1',
            toolName: 'bash',
            result: { content: [{ type: 'text', text: 'ok' }], details: {} },
            isError: false,
        });
        h.emit({ type: 'auto_retry_start', attempt: 1, maxAttempts: 3, delayMs: 10, errorMessage: '429' });

        await h.flush();

        // The tool result must reach the chat before the lifecycle notice.
        const resultIdx = h.order.indexOf('agent:tool-call-result');
        const noticeIdx = h.order.indexOf('session:message');
        expect(resultIdx).toBeGreaterThanOrEqual(0);
        expect(noticeIdx).toBeGreaterThan(resultIdx);
    });

    it('keeps image cards in event order ahead of a compaction notice', async () => {
        const h = createHarness();

        h.emit({
            type: 'tool_execution_end',
            toolCallId: 'tc-2',
            toolName: 'hapi_display_image',
            result: {
                content: [
                    { type: 'text', text: 'screenshot' },
                    { type: 'image', data: ONE_PX_PNG, mimeType: 'image/png' },
                ],
                details: {},
            },
            isError: false,
        });
        h.emit({ type: 'compaction_start', reason: 'threshold' });

        await h.flush();

        const resultIdx = h.order.indexOf('agent:tool-call-result');
        const imageIdx = h.order.indexOf('agent:generated-image');
        const noticeIdx = h.order.indexOf('session:message');
        expect(resultIdx).toBeGreaterThanOrEqual(0);
        expect(imageIdx).toBeGreaterThan(resultIdx);
        expect(noticeIdx).toBeGreaterThan(imageIdx);
    });

    it('preserves assistant snapshots on both sides of an inline image result', async () => {
        const h = createHarness();
        const text = (delta: string) => h.emit({
            type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta },
        });
        h.emit({ type: 'message_start' });
        text('before');
        h.emit({ type: 'message_end' });
        h.emit({
            type: 'tool_execution_end', toolCallId: 'image', toolName: 'hapi_display_image',
            result: { content: [{ type: 'image', data: ONE_PX_PNG, mimeType: 'image/png' }] },
            isError: false,
        });
        h.emit({ type: 'message_start' });
        text('after');
        h.emit({ type: 'message_end' });
        await h.flush();
        expect(h.messages.map((message) => message.type === 'message' ? message.message : message.type))
            .toEqual(['before', 'tool-call-result', 'generated-image', 'after']);
    });

    it('retains queued assistant deltas when the prompt is rejected in the same chunk', async () => {
        const h = createHarness();
        h.controller.beginPromptLifecycle('prompt-rejected');
        h.emit({ type: 'message_start' });
        h.emit({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'before' } });
        await h.flush();

        h.emit({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: ' rejection' } });
        h.emit({ type: 'response', command: 'prompt', id: 'prompt-rejected', success: false, error: 'rejected' });
        await h.flush();
        expect(h.messages.filter((message) => message.type === 'message').map((message) => message.message))
            .toEqual(['before', 'before rejection']);
    });

    it('drains queued deltas before flushing a closed or failed transport', async () => {
        const h = createHarness();
        h.emit({ type: 'message_start' });
        h.emit({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'before' } });
        await h.flush();

        h.emit({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: ' close' } });
        await h.controller.flush();
        await h.flush();
        expect(h.messages.filter((message) => message.type === 'message').map((message) => message.message))
            .toEqual(['before', 'before close']);
    });

});
