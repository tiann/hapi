import { describe, expect, it, vi } from 'vitest';
import type { RawJSONLines } from '../types';
import { getGeneratedImage } from '@/modules/common/generatedImages';
import { ClaudeToolResultImages } from './toolResultImages';

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
const DATA = PNG.toString('base64');

function readCall(): RawJSONLines {
    return {
        type: 'assistant',
        uuid: 'assistant-1',
        message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_1', name: 'Read', input: { file_path: '/tmp/screens/shot.png' } }] }
    } as RawJSONLines;
}

function readResult(overrides: Record<string, unknown> = {}): RawJSONLines {
    return {
        type: 'user',
        uuid: 'user-1',
        message: {
            role: 'user',
            content: [{
                type: 'tool_result',
                tool_use_id: 'toolu_1',
                content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: DATA } }]
            }]
        },
        toolUseResult: { type: 'image', file: { base64: DATA, type: 'image/png', originalSize: PNG.length } },
        ...overrides
    } as RawJSONLines;
}

describe('ClaudeToolResultImages', () => {
    it('forwards viewed images as inline media and strips base64 from the transcript line', () => {
        const images = new ClaudeToolResultImages();
        const client = { sendClaudeSessionMessage: vi.fn(), sendAgentMessage: vi.fn() };

        images.send(client, readCall());
        images.send(client, readResult());

        expect(client.sendClaudeSessionMessage).toHaveBeenCalledTimes(2);
        const forwarded = client.sendClaudeSessionMessage.mock.calls[1][0];
        expect(JSON.stringify(forwarded)).not.toContain(DATA);
        expect(forwarded.message.content[0].content[0]).toEqual({ type: 'image', source: { type: 'base64', media_type: 'image/png' } });
        expect(forwarded.toolUseResult).toEqual({ type: 'image', file: { type: 'image/png', originalSize: PNG.length } });

        expect(client.sendAgentMessage).toHaveBeenCalledOnce();
        const image = client.sendAgentMessage.mock.calls[0][0];
        expect(image).toMatchObject({
            type: 'generated-image',
            fileName: 'shot.png',
            mimeType: 'image/png',
            source: { ingress: 'tool_result', flavor: 'claude', toolCallId: 'toolu_1', toolName: 'Read' }
        });
        expect(getGeneratedImage(image.imageId)?.content.equals(PNG)).toBe(true);
    });

    it('leaves text results, sidechains, and undecodable images untouched', () => {
        const images = new ClaudeToolResultImages();
        const text = readResult({
            message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'file text' }] }
        });
        const sidechain = readResult({ isSidechain: true });
        const bogus = readResult({
            message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'bm90IGFuIGltYWdl' } }] }] }
        });
        for (const message of [text, sidechain, bogus]) {
            expect(images.process(message)).toEqual({ message, images: [] });
        }
    });
});
