import { describe, expect, it, vi } from 'vitest';
import { wireTransportEvents } from './loop';
import type { PiTransport } from './piTransport';
import type { PiSession } from './session';

/** 1x1 red PNG. */
const ONE_PX_PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

function createHarness() {
    let listener: ((event: Record<string, unknown>) => void) | null = null;
    const order: string[] = [];
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
    const session = {
        client,
        path: '/tmp/test',
        logPath: '/tmp/test.log',
        startedBy: 'terminal',
        startingMode: 'local',
        model: 'deepseek-v4-flash-0731',
        sendAgentMessage: vi.fn((msg: { type: string }) => { order.push(`agent:${msg.type}`); }),
        sendSessionEvent: vi.fn((msg: { type: string }) => { order.push(`session:${msg.type}`); }),
    } as unknown as PiSession;

    wireTransportEvents(transport, session, []);

    return {
        emit: (event: Record<string, unknown>) => listener?.(event),
        order,
        flush: () => new Promise((resolve) => setTimeout(resolve, 0)),
    };
}

const FLUSH_MS = 0;

describe('Pi publish ordering (real converters)', () => {
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

        await new Promise((resolve) => setTimeout(resolve, FLUSH_MS));

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

        await new Promise((resolve) => setTimeout(resolve, FLUSH_MS));

        const resultIdx = h.order.indexOf('agent:tool-call-result');
        const imageIdx = h.order.indexOf('agent:generated-image');
        const noticeIdx = h.order.indexOf('session:message');
        expect(resultIdx).toBeGreaterThanOrEqual(0);
        expect(imageIdx).toBeGreaterThan(resultIdx);
        expect(noticeIdx).toBeGreaterThan(imageIdx);
    });
});