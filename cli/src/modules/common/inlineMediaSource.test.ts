import { describe, expect, it } from 'vitest';
import { inlineMediaSourceFromWire } from './inlineMediaSource';

describe('inlineMediaSourceFromWire', () => {
    it('parses ingress and snake_case tool fields', () => {
        expect(inlineMediaSourceFromWire({
            ingress: 'mcp',
            flavor: 'cursor',
            tool_call_id: 'call-1',
            tool_name: 'display_video',
        })).toEqual({
            ingress: 'mcp',
            flavor: 'cursor',
            toolCallId: 'call-1',
            toolName: 'display_video',
        });
    });

    it('accepts legacy path alias for ingress', () => {
        expect(inlineMediaSourceFromWire({ path: 'acp' })).toEqual({ ingress: 'acp' });
    });
});
