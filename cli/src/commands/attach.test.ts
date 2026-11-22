import { describe, expect, it } from 'vitest';
import { parseAttachArgs } from './attach';

describe('attach arguments', () => {
    it('requires an explicit endpoint and native thread, or read-only list', () => {
        expect(parseAttachArgs(['thread', '--socket', '/tmp/a.sock'])).toEqual({ threadId: 'thread', endpoint: 'unix:///tmp/a.sock', list: false, newView: false });
        expect(parseAttachArgs(['--socket', 'unix:///tmp/a.sock', '--new-view', 'thread']).newView).toBe(true);
        expect(parseAttachArgs(['--list', '--socket', '/tmp/a.sock']).list).toBe(true);
    });
    it.each([[], ['thread'], ['--socket'], ['--socket', '/tmp/a'], ['thread', 'other', '--socket', '/tmp/a'],
        ['thread', '--socket', '/tmp/a', '--permission-mode', 'yolo'], ['--list', 'thread', '--socket', '/tmp/a'],
        ['--list', '--new-view', '--socket', '/tmp/a'], ['thread', '--socket', '/tmp/a', '--socket', '/tmp/b'],
        ['thread', '--socket', '/tmp/a', '-c', 'model=x']].map(args => ({ args })))('rejects ambiguous or injecting args $args', ({ args }) => {
        expect(() => parseAttachArgs(args)).toThrow();
    });
});
