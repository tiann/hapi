import { describe, expect, it, vi } from 'vitest';
import type { ApiSessionClient } from '@/api/apiSession';
import type { Metadata } from '@/api/types';
import { SharedCodexProjection } from './projection';

function fixture(parentThreadId?: string, deferWrites = false) {
    let metadata: Metadata = { path: '/repo', host: 'test', flavor: 'codex', name: 'Manual name' };
    const queued: Array<(value: Metadata) => Metadata> = [];
    const update = vi.fn((fn: (value: Metadata) => Metadata) => {
        if (deferWrites) queued.push(fn);
        else metadata = fn(metadata);
    });
    const send = vi.fn();
    const committed = vi.fn(async (_id: string) => {});
    const session = {
        getMetadata: () => metadata, updateMetadata: update, sendAgentMessage: send,
        sendUserMessage() {}
    } as unknown as ApiSessionClient;
    return {
        projection: new SharedCodexProjection(session, 'thread', committed, parentThreadId),
        metadata: () => metadata, update, send, committed,
        flush: () => { for (const fn of queued.splice(0)) metadata = fn(metadata); }
    };
}

function titleItem(id: string, title: string) {
    return { id, type: 'mcpToolCall', server: 'hapi', tool: 'change_title', arguments: { title },
        status: 'completed', result: { content: [{ type: 'text', text: 'Successfully changed chat title' }], isError: false } };
}
function params(item: unknown, turnId = 'turn') { return { threadId: 'thread', turnId, item }; }
function history(...items: unknown[]) { return { turns: [{ id: 'turn', status: 'completed', items }] }; }

describe('shared Codex titles', () => {
    it('persists a successful root tool title while preserving the manual name and transcript', async () => {
        const f = fixture();
        const item = titleItem('title', ' Remote title ');
        await f.projection.notification('item/started', params(item));
        expect(f.update).not.toHaveBeenCalled();
        // Completion may omit the arguments already sent at start.
        await f.projection.notification('item/completed', params({ ...item, arguments: undefined }));
        expect(f.metadata()).toMatchObject({ name: 'Manual name', summary: { text: 'Remote title', updatedAt: expect.any(Number) } });
        expect(f.send.mock.calls.map(([body]) => body.type)).toEqual(['tool-call', 'tool-call-result']);
        expect(f.update).toHaveBeenCalledTimes(1);
        await f.projection.notification('item/completed', params(item));
        f.projection.reset();
        await f.projection.history(history(item));
        await f.projection.notification('item/completed', params(item));
        expect(f.update).toHaveBeenCalledTimes(1);
    });

    it('handles a complete item without a start and orders successive titles across deferred writes', async () => {
        const f = fixture(undefined, true);
        await f.projection.notification('item/completed', params(titleItem('first', 'First')));
        await f.projection.notification('item/completed', params(titleItem('second', 'Second')));
        f.flush();
        expect(f.metadata().summary?.text).toBe('Second');
    });

    it.each([
        { status: 'failed' }, { status: 'cancelled' }, { status: 'inProgress' },
        { error: { message: 'failed' } }, { result: { Err: 'failed' } },
        { result: { isError: true } }, { result: { Ok: { isError: true } } },
        { result: null }, { arguments: { title: '   ' } },
        { server: 'other' }, { tool: 'other' }
    ])('ignores unsuccessful or unrelated tools: %j', async overrides => {
        const f = fixture();
        const item = { ...titleItem('title', 'Wrong'), ...overrides };
        await f.projection.notification('item/started', params(item));
        await f.projection.notification('item/completed', params(item));
        await f.projection.history(history(item));
        expect(f.update).not.toHaveBeenCalled();
    });

    it('isolates child and sibling titles from the root metadata', async () => {
        const child = fixture('parent');
        const item = titleItem('title', 'Child title');
        await child.projection.notification('item/started', params(item));
        await child.projection.notification('item/completed', params(item));
        await child.projection.history(history(item));
        expect(child.update).not.toHaveBeenCalled();
        expect(child.send.mock.calls[0][0].type).toBe('agent-run-trace');
        const root = fixture();
        await root.projection.notification('item/completed', { ...params(item), threadId: 'sibling' });
        expect(root.update).not.toHaveBeenCalled();
    });

    it('restores only the last successful historical title and does not replay earlier names', async () => {
        const f = fixture();
        const first = titleItem('first', 'First');
        const last = titleItem('last', 'Last');
        const snapshot = history(first, last, { ...titleItem('failed', 'Failed'), result: { isError: true } });
        await f.projection.history(snapshot);
        expect(f.metadata().summary?.text).toBe('Last');
        expect(f.update).toHaveBeenCalledTimes(1);
        f.projection.reset();
        await f.projection.history(snapshot);
        await f.projection.notification('item/completed', params(first));
        expect(f.metadata().summary?.text).toBe('Last');
        expect(f.update).toHaveBeenCalledTimes(1);
    });

    it('never overwrites an existing summary during a cold history replay', async () => {
        const f = fixture();
        f.update(metadata => ({ ...metadata, summary: { text: 'Existing', updatedAt: 123 } }));
        f.update.mockClear();
        await f.projection.history(history(titleItem('old', 'Old')));
        expect(f.update).not.toHaveBeenCalled();
        expect(f.metadata().summary).toEqual({ text: 'Existing', updatedAt: 123 });
    });

    it('keeps pending inputs from an active snapshot for a later argument-less completion', async () => {
        const f = fixture();
        const item = { ...titleItem('title', 'Resumed'), status: 'inProgress', result: null };
        await f.projection.history({ turns: [{ id: 'turn', status: 'inProgress', items: [item] }] });
        expect(f.update).not.toHaveBeenCalled();
        await f.projection.notification('item/completed', params({ ...titleItem('title', 'unused'), arguments: undefined }));
        expect(f.metadata().summary?.text).toBe('Resumed');
    });

    it('does not roll back a live title when a suspended replay or queued metadata callback resumes', async () => {
        const f = fixture(undefined, true);
        let release!: () => void;
        f.committed.mockImplementationOnce(() => new Promise<void>(resolve => { release = resolve; }));
        const replay = f.projection.history(history(
            { id: 'user', type: 'userMessage', content: [{ type: 'text', text: 'hello' }] },
            titleItem('old', 'Old')
        ));
        await vi.waitFor(() => expect(release).toBeTypeOf('function'));
        await f.projection.notification('item/completed', params(titleItem('live', 'Live'), 'next'));
        release(); await replay;
        f.flush();
        expect(f.metadata().summary?.text).toBe('Live');

        const queued = fixture(undefined, true);
        await queued.projection.history(history(titleItem('old', 'Old')));
        await queued.projection.notification('item/completed', params(titleItem('live', 'Live'), 'next'));
        queued.flush();
        expect(queued.metadata().summary?.text).toBe('Live');
    });
});
