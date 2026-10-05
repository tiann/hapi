import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { wireTransportEvents } from './loop';
import type { PiTransport } from './piTransport';
import { PiSession } from './session';
import { clearGeneratedImages, getGeneratedImage } from '../modules/common/generatedImages';

// Mock logger
vi.mock('@/ui/logger', () => ({
    logger: {
        debug: vi.fn(),
        warn: vi.fn(),
        info: vi.fn(),
    },
}));

// Mock message converter chain (identity, like loop.test.ts)
vi.mock('@/agent/messageConverter', () => ({
    convertAgentMessage: vi.fn((msg) => msg),
}));

vi.mock('./piEventConverter', async (importOriginal) => {
    const actual = await importOriginal<typeof import('./piEventConverter')>();
    return {
        ...actual,
        convertPiEvent: vi.fn(() => []),
    };
});

vi.mock('./piMessageAccumulator', () => {
    return {
        PiMessageAccumulator: class {
            handleEvent = vi.fn(() => []);
            flush = vi.fn(() => []);
        },
    };
});

function createMockSession(model?: string): PiSession {
    return new PiSession({
        api: {} as never,
        client: {
            keepAlive: vi.fn(),
            updateMetadata: vi.fn(),
            sendAgentMessage: vi.fn(),
            emitMessagesConsumed: vi.fn(),
            sendSessionEvent: vi.fn(),
            updateAgentState: vi.fn(),
            emitSessionReady: vi.fn(),
            getMetadata: vi.fn(() => null),
            rpcHandlerManager: { registerHandler: vi.fn() },
        } as never,
        path: '/tmp/test',
        logPath: '/tmp/test.log',
        startedBy: 'terminal',
        startingMode: 'local',
        model,
    });
}

const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d]);

describe('wireTransportEvents generated-image delivery (tool result images)', () => {
    let session: PiSession;
    let eventHandlers: Map<string, (...args: unknown[]) => void>;

    function createMockTransport(): PiTransport {
        eventHandlers = new Map();
        return {
            onEvent: vi.fn((handler) => { eventHandlers.set('event', handler); }),
            send: vi.fn(),
        } as unknown as PiTransport;
    }

    function emitEvent(event: Record<string, unknown>): void {
        eventHandlers.get('event')!(event);
    }

    beforeEach(() => {
        vi.clearAllMocks();
        clearGeneratedImages();
        session = createMockSession('gpt-4o');
    });

    afterEach(() => {
        clearGeneratedImages();
    });

    it('delivers an image returned in a tool result as a generated_image agent message with registered bytes', () => {
        const transport = createMockTransport();
        wireTransportEvents(transport, session, []);

        // The read tool records its args, then the tool result carries an inline PNG.
        emitEvent({
            type: 'tool_execution_start',
            toolCallId: 'tc-img',
            toolName: 'read',
            args: { path: '/tmp/cat.png' },
        });
        emitEvent({
            type: 'tool_execution_end',
            toolCallId: 'tc-img',
            toolName: 'read',
            result: { content: [{ type: 'image', mimeType: 'image/png', data: PNG_BYTES.toString('base64') }] },
            isError: false,
        });

        const sendAgentMessage = session.client.sendAgentMessage as ReturnType<typeof vi.fn>;
        const delivered = sendAgentMessage.mock.calls.map((c) => c[0]).find(
            (m) => (m as { type?: string })?.type === 'generated_image'
        ) as { imageId: string; fileName: string; mimeType: string; source: unknown } | undefined;

        expect(delivered).toBeDefined();
        expect(delivered!.fileName).toBe('cat.png');
        expect(delivered!.mimeType).toBe('image/png');
        expect(delivered!.source).toEqual({ ingress: 'tool_result', flavor: 'pi', toolCallId: 'tc-img' });

        // The image is retrievable through the generated-image registry with exact bytes.
        const media = getGeneratedImage(delivered!.imageId);
        expect(media).not.toBeNull();
        expect(media!.content.equals(PNG_BYTES)).toBe(true);
    });

    it('does not leak the tool-args entry after execution end', () => {
        const transport = createMockTransport();
        wireTransportEvents(transport, session, []);

        emitEvent({
            type: 'tool_execution_end',
            toolCallId: 'tc-nostart',
            toolName: 'read',
            result: { content: [{ type: 'image', mimeType: 'image/png', data: PNG_BYTES.toString('base64') }] },
            isError: false,
        });

        const sendAgentMessage = session.client.sendAgentMessage as ReturnType<typeof vi.fn>;
        const delivered = sendAgentMessage.mock.calls.map((c) => c[0]).find(
            (m) => (m as { type?: string })?.type === 'generated_image'
        ) as { imageId: string; fileName?: string | null } | undefined;

        // Without a recorded start args, the image still registers under the call-id path.
        expect(delivered).toBeDefined();
        expect(getGeneratedImage(delivered!.imageId)).not.toBeNull();

        // A second end for the same callId must not resurrect stale args: the cache entry was deleted.
        emitEvent({
            type: 'tool_execution_end',
            toolCallId: 'tc-nostart',
            toolName: 'read',
            result: { content: [{ type: 'image', mimeType: 'image/png', data: PNG_BYTES.toString('base64') }] },
            isError: false,
        });
        const delivered2 = sendAgentMessage.mock.calls.map((c) => c[0]).filter(
            (m) => (m as { type?: string })?.type === 'generated_image'
        );
        expect(delivered2).toHaveLength(2);
    });
});
