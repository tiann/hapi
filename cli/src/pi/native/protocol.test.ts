import { describe, expect, it } from 'vitest';
import { PI_NATIVE_MAX_FRAME_BYTES, PiNativeFrameParser } from './protocol';

describe('PiNativeFrameParser', () => {
    it('reassembles split UTF-8 frames and parses coalesced frames', () => {
        const parser = new PiNativeFrameParser();
        const input = Buffer.from('{"text":"你好"}\n{"kind":"ready"}\n');
        const frames: Record<string, unknown>[] = [];
        parser.feed(input.subarray(0, 11), (frame) => frames.push(frame));
        expect(frames).toEqual([]);
        parser.feed(input.subarray(11), (frame) => frames.push(frame));
        expect(frames).toEqual([{ text: '你好' }, { kind: 'ready' }]);
    });

    it('rejects malformed JSON and non-object messages', () => {
        expect(() => new PiNativeFrameParser().feed('not-json\n', () => {})).toThrow();
        expect(() => new PiNativeFrameParser().feed('[]\n', () => {})).toThrow('Invalid');
        expect(() => new PiNativeFrameParser().feed('null\n', () => {})).toThrow('Invalid');
    });

    it('bounds incomplete frames before a peer sends a newline', () => {
        expect(() => new PiNativeFrameParser().feed(Buffer.alloc(PI_NATIVE_MAX_FRAME_BYTES + 1, 32), () => {})).toThrow('size limit');
    });
});
