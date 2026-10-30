import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SharedCodexQueue, type QueueInput } from './queue';
import { INDETERMINATE_SYMBOL } from '../codexAppServerClient';

const directories: string[] = [];
afterEach(async () => {
    await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true })));
});

it('delivers compatible pending messages as one ordered native submission without early consumption', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'hapi-native-batch-'));
    directories.push(directory);
    const native: Array<{ id: string; clientUserMessageId: string; input: QueueInput }> = [];
    let sequence = 0;
    const client = {
        async request<T>(method: string, raw?: unknown): Promise<T> {
            const params = raw as { input: QueueInput; clientUserMessageId: string; queuedSubmissionId: string };
            if (method === 'thread/queue/list') return { data: structuredClone(native), nextCursor: null } as T;
            if (method === 'thread/queue/add') {
                const submission = { id: `native-${++sequence}`, input: structuredClone(params.input), clientUserMessageId: params.clientUserMessageId };
                native.push(submission);
                return { queuedSubmission: structuredClone(submission) } as T;
            }
            if (method === 'thread/queue/update') {
                const submission = native.find(item => item.id === params.queuedSubmissionId);
                if (!submission) throw new Error(`queued submission not found: ${params.queuedSubmissionId}`);
                submission.input = structuredClone(params.input);
                return { queuedSubmission: structuredClone(submission) } as T;
            }
            throw new Error(`Unexpected native mutation: ${method}`);
        }
    };
    const consumed = vi.fn();
    const queue = new SharedCodexQueue(client, 'thread', join(directory, 'ledger.json'), consumed, vi.fn());
    await queue.load();
    const enqueue = queue.enqueue.bind(queue) as (id: string, input: QueueInput, resume: boolean, batchKey: string) => Promise<void>;
    const a = [{ type: 'text', text: 'MARKER-A' }];
    const b = [{ type: 'text', text: 'MARKER-B' }];
    await enqueue('original-A', a, false, 'same-mode');
    await enqueue('original-B', b, false, 'same-mode');
    expect(native).toHaveLength(1);
    expect(native[0].input).toEqual([...a, ...b]);
    expect(consumed).not.toHaveBeenCalled();
});

type NativeSubmission = { id: string; clientUserMessageId: string; input: QueueInput };
const text = (value: string): QueueInput => [{ type: 'text', text: value }];
const combined = (...values: string[]): QueueInput => values.flatMap(text);
const lost = (message: string): Error => {
    const error = new Error(message) as Error & { [INDETERMINATE_SYMBOL]?: boolean };
    error[INDETERMINATE_SYMBOL] = true; return error;
};

function nativeServer() {
    const native: NativeSubmission[] = [];
    const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
    const overrides = new Map<string, (params: Record<string, unknown>) => unknown>();
    let sequence = 0;
    const client = {
        async request<T>(method: string, raw?: unknown): Promise<T> {
            const params = (raw ?? {}) as Record<string, unknown>;
            calls.push({ method, params });
            const override = overrides.get(method);
            if (override) return override(params) as T;
            if (method === 'thread/queue/list') return { data: structuredClone(native), nextCursor: null } as T;
            if (method === 'thread/queue/add') {
                const submission = { id: `native-${++sequence}`, input: structuredClone(params.input as QueueInput), clientUserMessageId: params.clientUserMessageId as string };
                native.push(submission);
                return { queuedSubmission: structuredClone(submission) } as T;
            }
            if (method === 'thread/queue/update') {
                const submission = native.find(item => item.id === params.queuedSubmissionId);
                if (!submission) throw new Error(`queued submission not found: ${String(params.queuedSubmissionId)}`);
                submission.input = structuredClone(params.input as QueueInput);
                return { queuedSubmission: structuredClone(submission) } as T;
            }
            if (method === 'thread/queue/delete') {
                const index = native.findIndex(item => item.id === params.queuedSubmissionId);
                if (index >= 0) native.splice(index, 1);
                return { deleted: index >= 0 } as T;
            }
            if (method === 'thread/queue/start' || method === 'turn/steer') return {} as T;
            throw new Error(`Unexpected native mutation: ${method}`);
        }
    };
    return { client, native, calls, overrides };
}

async function fixture() {
    const directory = await mkdtemp(join(tmpdir(), 'hapi-native-batch-'));
    directories.push(directory);
    const server = nativeServer();
    const consumed = vi.fn(); const uncertain = vi.fn(); const mirror = vi.fn();
    const queue = new SharedCodexQueue(server.client, 'thread', join(directory, 'ledger.json'), consumed, uncertain, mirror);
    await queue.load();
    return { queue, consumed, uncertain, mirror, directory, ...server };
}

it('returns [] and flags the pending members for unproven batch content without a synthetic row', async () => {
    const { queue, consumed, uncertain, native } = await fixture();
    await queue.enqueue('original-A', text('MARKER-A'), false, 'same-mode');
    await queue.enqueue('original-B', text('MARKER-B'), false, 'same-mode');
    expect(await queue.committed(native[0].clientUserMessageId, text('SOMETHING-ELSE'))).toEqual([]);
    expect(consumed).not.toHaveBeenCalled();
    expect(uncertain).toHaveBeenCalledWith(['original-A', 'original-B']);
    expect(queue.owns(native[0].clientUserMessageId)).toBe(false);
});

it('does not acknowledge a superseded older version after a confirmed replacement', async () => {
    const { queue, consumed, uncertain, native } = await fixture();
    await queue.enqueue('original-A', text('MARKER-A'), false, 'same-mode');
    await queue.enqueue('original-B', text('MARKER-B'), false, 'same-mode');
    expect(await queue.committed(native[0].clientUserMessageId, text('MARKER-A'))).toEqual([]);
    expect(consumed).not.toHaveBeenCalled();
    expect(uncertain).toHaveBeenCalledWith(['original-A', 'original-B']);
});

it('acknowledges an older version only while the replacement outcome is still unknown', async () => {
    const { queue, consumed, overrides, native } = await fixture();
    await queue.enqueue('original-A', text('MARKER-A'), false, 'same-mode');
    overrides.set('thread/queue/update', () => { throw lost('connection lost'); });
    await expect(queue.enqueue('original-B', text('MARKER-B'), false, 'same-mode')).rejects.toThrow();
    overrides.delete('thread/queue/update');
    expect(await queue.committed(native[0].clientUserMessageId, text('MARKER-A'))).toEqual([{ id: 'original-A', input: text('MARKER-A') }]);
    expect(consumed).toHaveBeenCalledWith(['original-A']);
    expect(queue.state('original-A')).toBe('consumed');
    expect(queue.state('original-B')).toBe('unknown');
});

it('does not acknowledge a canceled member when an eligible version reuses its exact input', async () => {
    const { queue, native } = await fixture();
    await queue.enqueue('original-A', text('same'), false, 'same-mode');
    await queue.enqueue('original-B', text('same'), false, 'same-mode');
    expect(await queue.cancel('original-A')).toBe(true);
    expect(await queue.committed(native[0].clientUserMessageId, text('same'))).toEqual([{ id: 'original-B', input: text('same') }]);
    expect(queue.state('original-A')).toBe('canceled');
    expect(queue.state('original-B')).toBe('consumed');
});

it('cancels one member by shrinking the shared native submission and keeps the sibling', async () => {
    const { queue, native, mirror } = await fixture();
    await queue.enqueue('original-A', text('MARKER-A'), false, 'same-mode');
    await queue.enqueue('original-B', text('MARKER-B'), false, 'same-mode');
    expect(await queue.cancel('original-A')).toBe(true);
    expect(native).toHaveLength(1);
    expect(native[0].input).toEqual(text('MARKER-B'));
    expect(queue.state('original-A')).toBe('canceled');
    expect(queue.state('original-B')).toBe('queued');
    expect(mirror).toHaveBeenCalledWith('original-A', null);
});

it('withdraws a canceled member once the surviving input is proven accepted', async () => {
    const { queue, native, overrides, consumed } = await fixture();
    await queue.enqueue('original-A', text('MARKER-A'), false, 'same-mode');
    await queue.enqueue('original-B', text('MARKER-B'), false, 'same-mode');
    const batchId = native[0].clientUserMessageId;
    overrides.set('thread/queue/update', params => {
        const submission = native.find(item => item.id === params.queuedSubmissionId);
        if (submission) submission.input = structuredClone(params.input as QueueInput);
        throw lost('lost cancel ACK');
    });
    expect(await queue.cancel('original-A')).toBe('indeterminate');
    expect(queue.state('original-A')).toBe('unknown');
    overrides.delete('thread/queue/update');
    expect(await queue.committed(batchId, text('MARKER-B'))).toEqual([{ id: 'original-B', input: text('MARKER-B') }]);
    expect(consumed).toHaveBeenCalledWith(['original-B']);
    expect(queue.state('original-A')).toBe('canceled');
    expect(queue.state('original-B')).toBe('consumed');
});

it('steers one member with its original id, leaves the sibling queued and pins the turn', async () => {
    const { queue, native, calls } = await fixture();
    await queue.enqueue('original-A', text('MARKER-A'), false, 'same-mode');
    await queue.enqueue('original-B', text('MARKER-B'), false, 'same-mode');
    expect(await queue.steer('original-A', 'turn-1')).toEqual({ steered: true });
    expect(native).toHaveLength(1);
    expect(native[0].input).toEqual(text('MARKER-B'));
    expect(calls.find(call => call.method === 'turn/steer')?.params).toEqual({
        threadId: 'thread', expectedTurnId: 'turn-1', input: text('MARKER-A'), clientUserMessageId: 'original-A'
    });
    expect(queue.state('original-A')).toBe('consumed');
    expect(queue.state('original-B')).toBe('queued');
});

it('never cancels a member removed for steering when the surviving input is consumed', async () => {
    const { queue, native, overrides, consumed } = await fixture();
    await queue.enqueue('original-A', text('MARKER-A'), false, 'same-mode');
    await queue.enqueue('original-B', text('MARKER-B'), false, 'same-mode');
    const batchId = native[0].clientUserMessageId;
    overrides.set('turn/steer', () => { throw lost('lost steer ACK'); });
    expect(await queue.steer('original-A', 'turn-1')).toEqual({ steered: false, indeterminate: true });
    expect(queue.state('original-A')).toBe('unknown');
    overrides.delete('turn/steer');
    expect(await queue.committed(batchId, text('MARKER-B'))).toEqual([{ id: 'original-B', input: text('MARKER-B') }]);
    expect(consumed).toHaveBeenCalledWith(['original-B']);
    expect(queue.state('original-A')).toBe('unknown');
});

it('restores a steered member into the group on a definite steer rejection', async () => {
    const { queue, native, overrides, consumed } = await fixture();
    await queue.enqueue('original-A', text('MARKER-A'), false, 'same-mode');
    await queue.enqueue('original-B', text('MARKER-B'), false, 'same-mode');
    const batchId = native[0].clientUserMessageId;
    overrides.set('turn/steer', () => { throw new Error('expected active turn id mismatch'); });
    expect((await queue.steer('original-A', 'turn-1')).steered).toBe(false);
    overrides.delete('turn/steer');
    expect(native[0].input).toEqual(combined('MARKER-A', 'MARKER-B'));
    expect(queue.state('original-A')).toBe('queued');
    expect(queue.state('original-B')).toBe('queued');
    // The proven restored group is authoritative again and its aliases remain ACKable.
    expect(await queue.committed(batchId, combined('MARKER-A', 'MARKER-B'))).toEqual([
        { id: 'original-A', input: text('MARKER-A') }, { id: 'original-B', input: text('MARKER-B') }
    ]);
    expect(consumed).toHaveBeenCalledWith(['original-A', 'original-B']);
});

it('treats an invalid native update response as unknown rather than success', async () => {
    const { queue, overrides } = await fixture();
    await queue.enqueue('original-A', text('MARKER-A'), false, 'same-mode');
    await queue.enqueue('original-B', text('MARKER-B'), false, 'same-mode');
    overrides.set('thread/queue/update', () => ({}));
    expect(await queue.cancel('original-A')).toBe('indeterminate');
    expect(queue.state('original-A')).toBe('unknown');
    expect(queue.state('original-B')).toBe('queued');
});

it('rejects an invalid external update response without canceling members', async () => {
    const { queue, overrides, native } = await fixture();
    await queue.enqueue('original-A', text('MARKER-A'), false, 'same-mode');
    await queue.enqueue('original-B', text('MARKER-B'), false, 'same-mode');
    overrides.set('thread/queue/update', () => ({ queuedSubmission: { id: 'other', input: text('X'), clientUserMessageId: 'other' } }));
    await expect(queue.nativeMutation('thread/queue/update', { threadId: 'thread', queuedSubmissionId: native[0].id, input: text('EDITED') })).rejects.toThrow();
    expect(queue.state('original-A')).toBe('queued');
    expect(queue.state('original-B')).toBe('queued');
});

it('does not extend a tail whose own append outcome is still unknown', async () => {
    const { queue, native, overrides } = await fixture();
    await queue.enqueue('original-A', text('MARKER-A'), false, 'same-mode');
    overrides.set('thread/queue/update', () => { throw lost('lost append'); });
    await expect(queue.enqueue('original-B', text('MARKER-B'), false, 'same-mode')).rejects.toThrow();
    expect(queue.state('original-B')).toBe('unknown');
    overrides.delete('thread/queue/update');
    await queue.enqueue('original-C', text('MARKER-C'), false, 'same-mode');
    expect(native).toHaveLength(2);
    expect(native[1].input).toEqual(text('MARKER-C'));
    expect(native[1].clientUserMessageId).toMatch(/^hapi-batch-/);
});

it('does not treat an older queued snapshot as proof that an unresolved append failed', async () => {
    const { queue, overrides } = await fixture();
    await queue.enqueue('original-A', text('MARKER-A'), false, 'same-mode');
    overrides.set('thread/queue/update', () => { throw lost('lost append'); });
    await expect(queue.enqueue('original-B', text('MARKER-B'), false, 'same-mode')).rejects.toThrow();
    overrides.delete('thread/queue/update');
    await queue.reconcile();
    expect(queue.state('original-A')).toBe('queued');
    expect(queue.state('original-B')).toBe('unknown');
});

it('does not extend a foreign native tail', async () => {
    const { queue, native } = await fixture();
    native.push({ id: 'foreign-1', clientUserMessageId: 'foreign', input: text('FOREIGN') });
    await queue.enqueue('original-A', text('MARKER-A'), false, 'same-mode');
    expect(native).toHaveLength(2);
    expect(native[1].input).toEqual(text('MARKER-A'));
    expect(native[1].clientUserMessageId).toMatch(/^hapi-batch-/);
});

it('starts a fresh submission when the previous tail is gone', async () => {
    const { queue, native } = await fixture();
    await queue.enqueue('original-A', text('MARKER-A'), false, 'same-mode');
    const first = native[0].clientUserMessageId;
    native.length = 0;
    await queue.enqueue('original-B', text('MARKER-B'), false, 'same-mode');
    expect(native).toHaveLength(1);
    expect(native[0].input).toEqual(text('MARKER-B'));
    expect(native[0].clientUserMessageId).not.toBe(first);
});

it('treats a differing batch key as a boundary', async () => {
    const { queue, native } = await fixture();
    await queue.enqueue('original-A', text('MARKER-A'), false, 'mode-1');
    await queue.enqueue('original-B', text('MARKER-B'), false, 'mode-2');
    expect(native).toHaveLength(2);
    expect(native[0].input).toEqual(text('MARKER-A'));
    expect(native[1].input).toEqual(text('MARKER-B'));
});

it('keeps an indeterminate add unknown and never replays it after a ledger reload', async () => {
    const { queue, overrides, client, directory, consumed, native, calls } = await fixture();
    overrides.set('thread/queue/add', () => { throw lost('connection lost'); });
    await expect(queue.enqueue('original-A', text('MARKER-A'), false, 'same-mode')).rejects.toThrow();
    expect(queue.state('original-A')).toBe('unknown');
    expect(native).toHaveLength(0);
    const restarted = new SharedCodexQueue(client, 'thread', join(directory, 'ledger.json'), consumed, vi.fn());
    await restarted.load();
    overrides.delete('thread/queue/add');
    await restarted.enqueue('original-A', text('MARKER-A'), false, 'same-mode');
    expect(restarted.state('original-A')).toBe('unknown');
    expect(calls.filter(call => call.method === 'thread/queue/add')).toHaveLength(1);
});

it.each([false, true])('retries an unsent input after a failed preflight read and ledger reload (existing tail: %s)', async hasTail => {
    const f = await fixture();
    if (hasTail) await f.queue.enqueue('original-A', text('A'), false, 'same-mode');
    const before = f.calls.length;
    f.overrides.set('thread/queue/list', async () => {
        const ledger = JSON.parse(await readFile(join(f.directory, 'ledger.json'), 'utf8'));
        expect(ledger.entries['retry-B'].state).toBe('rejected');
        throw lost('preflight connection lost');
    });
    await expect(f.queue.enqueue('retry-B', text('B'), false, 'same-mode')).rejects.toThrow('preflight connection lost');
    expect(f.queue.state('retry-B')).toBe('rejected');
    expect(f.calls.slice(before).map(call => call.method)).toEqual(['thread/queue/list']);
    expect(f.uncertain).not.toHaveBeenCalled();

    const restarted = new SharedCodexQueue(f.client, 'thread', join(f.directory, 'ledger.json'), f.consumed, f.uncertain);
    await restarted.load();
    expect(restarted.state('retry-B')).toBe('rejected');
    f.overrides.delete('thread/queue/list');
    await restarted.reconcile();
    await restarted.enqueue('retry-B', text('B'), false, 'same-mode');
    expect(restarted.state('retry-B')).toBe('queued');
    expect(f.native).toHaveLength(1);
    expect(f.native[0].input).toEqual(hasTail ? [...text('A'), ...text('B')] : text('B'));
    expect(f.calls.filter(call => call.method === 'thread/queue/add')).toHaveLength(1);
    expect(f.calls.filter(call => call.method === 'thread/queue/update')).toHaveLength(hasTail ? 1 : 0);
    expect(f.consumed).not.toHaveBeenCalled();
});

it('allows cancellation of an input whose preflight read failed before dispatch', async () => {
    const f = await fixture();
    f.overrides.set('thread/queue/list', () => { throw new Error('queue unavailable'); });
    await expect(f.queue.enqueue('original-A', text('A'), false, 'same-mode')).rejects.toThrow('queue unavailable');
    const restarted = new SharedCodexQueue(f.client, 'thread', join(f.directory, 'ledger.json'), f.consumed, f.uncertain);
    await restarted.load();
    expect(await restarted.cancel('original-A')).toBe(true);
    expect(restarted.state('original-A')).toBe('canceled');
    expect(f.calls.map(call => call.method)).toEqual(['thread/queue/list']);
});

it('preserves released native edits when the next preflight read fails and the ledger reloads', async () => {
    const f = await fixture();
    await f.queue.enqueue('original-A', text('A'), false, 'same-mode');
    await f.queue.nativeMutation('thread/queue/update', {
        threadId: 'thread', queuedSubmissionId: f.native[0].id, input: text('EDITED')
    });
    await f.queue.suspend();
    f.overrides.set('thread/queue/list', () => { throw new Error('queue unavailable'); });
    await expect(f.queue.enqueue('original-A', text('stale hub text'), false, 'same-mode')).rejects.toThrow('queue unavailable');
    const restarted = new SharedCodexQueue(f.client, 'thread', join(f.directory, 'ledger.json'), f.consumed, f.uncertain);
    await restarted.load();
    f.overrides.delete('thread/queue/list');
    await restarted.enqueue('original-A', text('stale hub text'), false, 'same-mode');
    expect(f.native).toHaveLength(1);
    expect(f.native[0].input).toEqual(text('EDITED'));
});

it.each(['add', 'update'])('journals uncertainty before dispatching the native %s after preflight', async mutation => {
    const f = await fixture();
    if (mutation === 'update') await f.queue.enqueue('original-A', text('A'), false, 'same-mode');
    const method = `thread/queue/${mutation}`;
    f.overrides.set(method, async () => {
        const ledger = JSON.parse(await readFile(join(f.directory, 'ledger.json'), 'utf8'));
        expect(ledger.entries['original-B'].state).toBe('unknown');
        expect(ledger.entries['original-B'].batchId).toEqual(expect.any(String));
        throw lost('mutation reply lost');
    });
    await expect(f.queue.enqueue('original-B', text('B'), false, 'same-mode')).rejects.toThrow('mutation reply lost');
    const before = f.calls.filter(call => call.method === method).length;
    const restarted = new SharedCodexQueue(f.client, 'thread', join(f.directory, 'ledger.json'), f.consumed, f.uncertain);
    await restarted.load();
    expect(restarted.state('original-B')).toBe('unknown');
    f.overrides.delete(method);
    await restarted.enqueue('original-B', text('B'), false, 'same-mode');
    expect(restarted.state('original-B')).toBe('unknown');
    expect(f.calls.filter(call => call.method === method)).toHaveLength(before);
});

it('does not redispatch acceptance proven while a preflight read is in flight', async () => {
    const f = await fixture();
    f.overrides.set('thread/queue/list', async () => {
        await f.queue.committed('original-A');
        return { data: [], nextCursor: null };
    });
    await f.queue.enqueue('original-A', text('A'), false, 'same-mode');
    expect(f.queue.state('original-A')).toBe('consumed');
    expect(f.consumed).toHaveBeenCalledExactlyOnceWith(['original-A']);
    expect(f.calls.map(call => call.method)).toEqual(['thread/queue/list']);
});

it('matches accepted content that only adds an empty text_elements representation', async () => {
    const { queue, native, consumed } = await fixture();
    await queue.enqueue('original-A', text('MARKER-A'), false, 'same-mode');
    await queue.enqueue('original-B', text('MARKER-B'), false, 'same-mode');
    const content = [
        { type: 'text', text: 'MARKER-A', text_elements: [] },
        { type: 'text', text: 'MARKER-B', text_elements: [] }
    ];
    expect(await queue.committed(native[0].clientUserMessageId, content)).toEqual([
        { id: 'original-A', input: text('MARKER-A') }, { id: 'original-B', input: text('MARKER-B') }
    ]);
    expect(consumed).toHaveBeenCalledWith(['original-A', 'original-B']);
});

it('reloads the v2 batch ledger and consumes the exact combined version', async () => {
    const { queue, client, directory, native, consumed } = await fixture();
    await queue.enqueue('original-A', text('MARKER-A'), false, 'same-mode');
    await queue.enqueue('original-B', text('MARKER-B'), false, 'same-mode');
    const batchId = native[0].clientUserMessageId;
    const restarted = new SharedCodexQueue(client, 'thread', join(directory, 'ledger.json'), consumed, vi.fn());
    await restarted.load();
    expect(restarted.state('original-A')).toBe('queued');
    expect(restarted.state('original-B')).toBe('queued');
    expect(await restarted.committed(batchId, combined('MARKER-A', 'MARKER-B'))).toEqual([
        { id: 'original-A', input: text('MARKER-A') }, { id: 'original-B', input: text('MARKER-B') }
    ]);
    expect(consumed).toHaveBeenCalledWith(['original-A', 'original-B']);
});

it('journals a whole-batch native delete and cancels every member on the definitive response', async () => {
    const { queue, native } = await fixture();
    await queue.enqueue('original-A', text('MARKER-A'), false, 'same-mode');
    await queue.enqueue('original-B', text('MARKER-B'), false, 'same-mode');
    expect(await queue.nativeMutation('thread/queue/delete', { threadId: 'thread', queuedSubmissionId: native[0].id })).toEqual({ deleted: true });
    expect(native).toHaveLength(0);
    expect(queue.state('original-A')).toBe('canceled');
    expect(queue.state('original-B')).toBe('canceled');
});

it('journals whole-delete uncertainty before the RPC and never authorizes replay when the response is lost', async () => {
    const { queue, native, overrides } = await fixture();
    await queue.enqueue('original-A', text('MARKER-A'), false, 'same-mode');
    await queue.enqueue('original-B', text('MARKER-B'), false, 'same-mode');
    overrides.set('thread/queue/delete', () => { throw new Error('connection lost'); });
    await expect(queue.nativeMutation('thread/queue/delete', { threadId: 'thread', queuedSubmissionId: native[0].id })).rejects.toThrow();
    expect(queue.state('original-A')).toBe('unknown');
    expect(queue.state('original-B')).toBe('unknown');
});

it('deletes a shared native submission once during suspend and releases every member', async () => {
    const { queue, native, calls } = await fixture();
    await queue.enqueue('original-A', text('MARKER-A'), false, 'same-mode');
    await queue.enqueue('original-B', text('MARKER-B'), false, 'same-mode');
    await queue.suspend();
    expect(calls.filter(call => call.method === 'thread/queue/delete')).toHaveLength(1);
    expect(queue.state('original-A')).toBe('released');
    expect(queue.state('original-B')).toBe('released');
});

it.each(['native delete', 'suspend'] as const)('settles all batch members after a lost append response and confirmed %s', async operation => {
    const { queue, native, overrides, calls } = await fixture();
    await queue.enqueue('original-A', text('MARKER-A'), false, 'same-mode');
    overrides.set('thread/queue/update', () => { throw lost('lost append'); });
    await expect(queue.enqueue('original-B', text('MARKER-B'), false, 'same-mode')).rejects.toThrow();
    overrides.delete('thread/queue/update');
    if (operation === 'suspend') await queue.suspend();
    else await queue.nativeMutation('thread/queue/delete', { threadId: 'thread', queuedSubmissionId: native[0].id });
    const expected = operation === 'suspend' ? 'released' : 'canceled';
    expect(queue.state('original-A')).toBe(expected);
    expect(queue.state('original-B')).toBe(expected);
    expect(calls.filter(call => call.method === 'thread/queue/delete')).toHaveLength(1);
});

it('never revives a canceled member when a later whole delete loses its ACK before suspend', async () => {
    const { queue, native, overrides, mirror } = await fixture();
    await queue.enqueue('original-A', text('MARKER-A'), false, 'same-mode');
    await queue.enqueue('original-B', text('MARKER-B'), false, 'same-mode');
    expect(await queue.cancel('original-A')).toBe(true);
    overrides.set('thread/queue/delete', () => { throw lost('lost delete'); });
    await expect(queue.nativeMutation('thread/queue/delete', { threadId: 'thread', queuedSubmissionId: native[0].id })).rejects.toThrow();
    expect(queue.state('original-A')).toBe('canceled');
    overrides.delete('thread/queue/delete');
    mirror.mockClear();
    await queue.suspend();
    expect(queue.state('original-A')).toBe('canceled');
    expect(queue.state('original-B')).toBe('released');
    expect(mirror).not.toHaveBeenCalledWith('original-A', text('MARKER-A'));
});

it.each(['gateway', 'snapshot', 'lost-edit-ack'] as const)('retains removal intents through %s after an indeterminate cancellation', async route => {
    for (const cancelApplied of [false, true]) {
        const f = await fixture();
        await f.queue.enqueue('original-A', text('A'), false, 'same');
        await f.queue.enqueue('original-B', text('B'), false, 'same');
        f.overrides.set('thread/queue/update', params => {
            if (cancelApplied) f.native[0].input = structuredClone(params.input as QueueInput);
            throw lost('cancel reply lost');
        });
        expect(await f.queue.cancel('original-A')).toBe('indeterminate');
        expect(f.queue.state('original-A')).toBe('unknown');
        f.overrides.delete('thread/queue/update');
        if (route === 'snapshot') {
            f.native[0].input = text('EDITED-X');
            await f.queue.reconcile();
        } else {
            if (route === 'lost-edit-ack') f.overrides.set('thread/queue/update', params => {
                f.native[0].input = structuredClone(params.input as QueueInput);
                throw lost('edit reply lost');
            });
            const edit = f.queue.nativeMutation('thread/queue/update', {
                threadId: 'thread', queuedSubmissionId: f.native[0].id, input: text('EDITED-X')
            });
            if (route === 'lost-edit-ack') await expect(edit).rejects.toThrow('edit reply lost');
            else await edit;
            f.overrides.delete('thread/queue/update');
        }
        const restored = new SharedCodexQueue(f.client, 'thread', join(f.directory, 'ledger.json'), f.consumed, f.uncertain, f.mirror);
        await restored.load();
        await restored.suspend();
        const resumed = new SharedCodexQueue(f.client, 'thread', join(f.directory, 'ledger.json'), f.consumed, f.uncertain, f.mirror);
        await resumed.load();
        // Only ledger-proven released originals are replayed by a resumed root.
        for (const id of ['original-A', 'original-B']) {
            if (resumed.state(id) === 'released') await resumed.enqueue(id, text(id), false, 'same');
        }
        expect(f.native.flatMap(item => item.input)).toEqual(text('EDITED-X'));
        expect(resumed.state('original-A')).toBe('canceled');
        expect(resumed.state('original-B')).toBe('queued');
        expect(f.mirror).toHaveBeenCalledWith('original-A', null);
        expect(f.consumed).not.toHaveBeenCalled();
    }
});

it('settles removal intents when edited content is accepted before the native edit response', async () => {
    const f = await fixture();
    await f.queue.enqueue('original-A', text('A'), false, 'same');
    await f.queue.enqueue('original-B', text('B'), false, 'same');
    f.overrides.set('thread/queue/update', () => { throw lost('cancel reply lost'); });
    expect(await f.queue.cancel('original-A')).toBe('indeterminate');
    const batchId = f.native[0].clientUserMessageId;
    f.overrides.set('thread/queue/update', async params => {
        f.native[0].input = structuredClone(params.input as QueueInput);
        expect(await f.queue.committed(batchId, params.input)).toEqual([{ id: 'original-B', input: text('EDITED-X') }]);
        expect(f.queue.state('original-A')).toBe('canceled');
        return { queuedSubmission: structuredClone(f.native[0]) };
    });
    await f.queue.nativeMutation('thread/queue/update', { threadId: 'thread', queuedSubmissionId: f.native[0].id, input: text('EDITED-X') });
    const restored = new SharedCodexQueue(f.client, 'thread', join(f.directory, 'ledger.json'), f.consumed, f.uncertain);
    await restored.load();
    expect(restored.state('original-A')).toBe('canceled');
    expect(restored.state('original-B')).toBe('consumed');
    expect(f.consumed).toHaveBeenCalledExactlyOnceWith(['original-B']);
});

it.each(['gateway', 'snapshot'] as const)('preserves detached steer removal intents through a %s whole edit and resume', async route => {
    const f = await fixture();
    await f.queue.enqueue('original-A', text('A'), false, 'same');
    await f.queue.enqueue('original-B', text('B'), false, 'same');
    f.overrides.set('turn/steer', () => { throw lost('steer reply lost'); });
    expect(await f.queue.steer('original-A', 'active-turn')).toEqual({ steered: false, indeterminate: true });
    if (route === 'snapshot') {
        f.native[0].input = text('EDITED-X');
        await f.queue.reconcile();
    } else await f.queue.nativeMutation('thread/queue/update', { threadId: 'thread', queuedSubmissionId: f.native[0].id, input: text('EDITED-X') });
    await f.queue.suspend();
    const restored = new SharedCodexQueue(f.client, 'thread', join(f.directory, 'ledger.json'), f.consumed, f.uncertain);
    await restored.load();
    expect(restored.state('original-A')).toBe('unknown');
    expect(restored.state('original-B')).toBe('released');
    await restored.enqueue('original-A', text('A'), false, 'same');
    await restored.enqueue('original-B', text('B'), false, 'same');
    expect(f.native.flatMap(item => item.input)).toEqual(text('EDITED-X'));
    expect(f.mirror).not.toHaveBeenCalledWith('original-A', null);
    expect(f.consumed).not.toHaveBeenCalled();
});

it('journals an external whole edit before the RPC and lets the first member own the edited input', async () => {
    const { queue, native, consumed, mirror } = await fixture();
    await queue.enqueue('original-A', text('MARKER-A'), false, 'same-mode');
    await queue.enqueue('original-B', text('MARKER-B'), false, 'same-mode');
    const batchId = native[0].clientUserMessageId;
    await queue.nativeMutation('thread/queue/update', { threadId: 'thread', queuedSubmissionId: native[0].id, input: text('EDITED') });
    expect(native[0].input).toEqual(text('EDITED'));
    expect(mirror).toHaveBeenCalledWith('original-A', text('EDITED'));
    expect(queue.state('original-B')).toBe('canceled');
    expect(await queue.committed(batchId, text('EDITED'))).toEqual([{ id: 'original-A', input: text('EDITED') }]);
    expect(consumed).toHaveBeenCalledWith(['original-A']);
});

it('mirrors accepted native edits before the consumed ACK when the event precedes the RPC response', async () => {
    const { queue, native, consumed, mirror, overrides } = await fixture();
    await queue.enqueue('original-A', text('MARKER-A'), false, 'same-mode');
    await queue.enqueue('original-B', text('MARKER-B'), false, 'same-mode');
    const batchId = native[0].clientUserMessageId;
    overrides.set('thread/queue/update', async params => {
        native[0].input = params.input as QueueInput;
        await queue.committed(batchId, params.input);
        return { queuedSubmission: structuredClone(native[0]) };
    });
    await queue.nativeMutation('thread/queue/update', { threadId: 'thread', queuedSubmissionId: native[0].id, input: text('EDITED') });
    expect(mirror).toHaveBeenCalledWith('original-A', text('EDITED'));
    const call = mirror.mock.calls.findIndex(([id, input]) => id === 'original-A' && JSON.stringify(input) === JSON.stringify(text('EDITED')));
    expect(mirror.mock.invocationCallOrder[call]).toBeLessThan(consumed.mock.invocationCallOrder[0]);
    expect(queue.state('original-A')).toBe('consumed');
    expect(queue.state('original-B')).toBe('canceled');
});

it('rejects native mutations outside the serialized queue surface', async () => {
    const { queue } = await fixture();
    await expect(queue.nativeMutation('thread/archive', { threadId: 'thread' })).rejects.toThrow('Unsupported native queue mutation');
});

it('replays an exact consumed version from a reloaded ledger', async () => {
    const { queue, client, directory, native, consumed } = await fixture();
    await queue.enqueue('original-A', text('MARKER-A'), false, 'same-mode');
    await queue.enqueue('original-B', text('MARKER-B'), false, 'same-mode');
    const batchId = native[0].clientUserMessageId;
    const content = combined('MARKER-A', 'MARKER-B');
    const aliases = [{ id: 'original-A', input: text('MARKER-A') }, { id: 'original-B', input: text('MARKER-B') }];
    expect(await queue.committed(batchId, content)).toEqual(aliases);
    const restarted = new SharedCodexQueue(client, 'thread', join(directory, 'ledger.json'), consumed, vi.fn());
    await restarted.load();
    expect(await restarted.committed(batchId, content)).toEqual(aliases);
});

it('does not revive a consumed version when the append ACK arrives after the event', async () => {
    const { queue, native, overrides } = await fixture();
    await queue.enqueue('original-A', text('MARKER-A'), false, 'same-mode');
    const batchId = native[0].clientUserMessageId;
    const content = combined('MARKER-A', 'MARKER-B');
    overrides.set('thread/queue/update', async params => {
        const submission = native.find(item => item.id === params.queuedSubmissionId);
        if (submission) submission.input = structuredClone(params.input as QueueInput);
        await queue.committed(batchId, structuredClone(params.input as QueueInput));
        return { queuedSubmission: structuredClone(submission) };
    });
    await queue.enqueue('original-B', text('MARKER-B'), false, 'same-mode');
    expect(queue.state('original-A')).toBe('consumed');
    expect(queue.state('original-B')).toBe('consumed');
    overrides.delete('thread/queue/update');
    // A reconcile of the same native content must not revive the consumed group...
    await queue.reconcile();
    expect(queue.state('original-A')).toBe('consumed');
    expect(queue.state('original-B')).toBe('consumed');
    // ...and a later message must start a fresh submission instead of extending it.
    await queue.enqueue('original-C', text('MARKER-C'), false, 'same-mode');
    expect(native).toHaveLength(2);
    expect(native[1].input).toEqual(text('MARKER-C'));
    expect(await queue.committed(batchId, content)).toEqual([
        { id: 'original-A', input: text('MARKER-A') }, { id: 'original-B', input: text('MARKER-B') }
    ]);
});

it('fails closed when a lost append leaves the group unresolved before cancel', async () => {
    const { queue, overrides, calls, consumed } = await fixture();
    await queue.enqueue('original-A', text('MARKER-A'), false, 'same-mode');
    overrides.set('thread/queue/update', () => { throw lost('lost append'); });
    await expect(queue.enqueue('original-B', text('MARKER-B'), false, 'same-mode')).rejects.toThrow();
    overrides.delete('thread/queue/update');
    expect(await queue.cancel('original-A')).toBe('indeterminate');
    expect(calls.filter(call => call.method === 'thread/queue/update')).toHaveLength(1);
    expect(calls.filter(call => call.method === 'thread/queue/delete')).toHaveLength(0);
    expect(consumed).not.toHaveBeenCalled();
});

it('fails closed when a lost append leaves the group unresolved before steer', async () => {
    const { queue, overrides, calls, consumed } = await fixture();
    await queue.enqueue('original-A', text('MARKER-A'), false, 'same-mode');
    overrides.set('thread/queue/update', () => { throw lost('lost append'); });
    await expect(queue.enqueue('original-B', text('MARKER-B'), false, 'same-mode')).rejects.toThrow();
    overrides.delete('thread/queue/update');
    expect(await queue.steer('original-A', 'turn-1')).toEqual({ steered: false, indeterminate: true });
    expect(calls.filter(call => call.method === 'thread/queue/update')).toHaveLength(1);
    expect(calls.filter(call => call.method === 'turn/steer')).toHaveLength(0);
    expect(consumed).not.toHaveBeenCalled();
});


it('settles an acknowledged-by-snapshot cancellation before suspend and reload', async () => {
    const f = await fixture();
    await f.queue.enqueue('original-A', text('A'), false, 'same');
    await f.queue.enqueue('original-B', text('B'), false, 'same');
    f.overrides.set('thread/queue/update', params => {
        f.native[0].input = structuredClone(params.input as QueueInput);
        throw lost('cancel reply lost');
    });
    expect(await f.queue.cancel('original-A')).toBe('indeterminate');
    f.overrides.delete('thread/queue/update');
    await f.queue.reconcile();
    expect(f.queue.state('original-A')).toBe('canceled');
    await f.queue.suspend();
    const restored = new SharedCodexQueue(f.client, 'thread', join(f.directory, 'ledger.json'), vi.fn(), vi.fn());
    await restored.load();
    expect(restored.state('original-A')).toBe('canceled');
    expect(restored.state('original-B')).toBe('released');
    expect(f.mirror).toHaveBeenCalledWith('original-A', null);
});

it.each(['native-delete', 'suspend'] as const)('keeps lost detached steering unknown after sibling %s and reload', async action => {
    const f = await fixture();
    await f.queue.enqueue('original-A', text('A'), false, 'same');
    await f.queue.enqueue('original-B', text('B'), false, 'same');
    f.overrides.set('turn/steer', () => { throw lost('steer reply lost'); });
    expect(await f.queue.steer('original-A', 'active-turn')).toEqual({ steered: false, indeterminate: true });
    const restored = new SharedCodexQueue(f.client, 'thread', join(f.directory, 'ledger.json'), vi.fn(), vi.fn(), f.mirror);
    await restored.load();
    if (action === 'suspend') await restored.suspend();
    else await restored.nativeMutation('thread/queue/delete', { threadId: 'thread', queuedSubmissionId: f.native[0].id });
    expect(restored.state('original-A')).toBe('unknown');
    expect(restored.state('original-B')).toBe(action === 'suspend' ? 'released' : 'canceled');
    expect(f.mirror).not.toHaveBeenCalledWith('original-A', null);
    const reloaded = new SharedCodexQueue(f.client, 'thread', join(f.directory, 'ledger.json'), vi.fn(), vi.fn());
    await reloaded.load();
    expect(reloaded.state('original-A')).toBe('unknown');
    const adds = f.calls.filter(call => call.method === 'thread/queue/add').length;
    await reloaded.enqueue('original-A', text('A'), false, 'same');
    expect(f.calls.filter(call => call.method === 'thread/queue/add')).toHaveLength(adds);
});

it('requeues only rejected steering input when the sibling batch has already drained', async () => {
    const f = await fixture();
    await f.queue.enqueue('original-A', text('A'), false, 'same');
    await f.queue.enqueue('original-B', text('B'), false, 'same');
    const batchId = f.native[0].clientUserMessageId;
    f.overrides.set('turn/steer', async () => {
        f.native.splice(0);
        await f.queue.committed(batchId, text('B'));
        throw new Error('expected active turn id mismatch');
    });
    expect((await f.queue.steer('original-A', 'active-turn')).steered).toBe(false);
    expect(f.queue.state('original-A')).toBe('queued');
    expect(f.queue.state('original-B')).toBe('consumed');
    expect(f.native).toHaveLength(1);
    expect(f.native[0].input).toEqual(text('A'));
    await f.queue.committed(f.native[0].clientUserMessageId, f.native[0].input);
    expect(f.queue.state('original-A')).toBe('consumed');
    expect(f.consumed).not.toHaveBeenCalledWith(['original-A', 'original-B']);
});


it('reconciles a lost restoration response without replacing the original aliases', async () => {
    const f = await fixture();
    await f.queue.enqueue('original-A', text('A'), false, 'same');
    await f.queue.enqueue('original-B', text('B'), false, 'same');
    f.overrides.set('turn/steer', () => {
        f.overrides.set('thread/queue/update', params => {
            f.native[0].input = structuredClone(params.input as QueueInput);
            throw lost('restoration response lost');
        });
        throw new Error('expected active turn id mismatch');
    });
    expect((await f.queue.steer('original-A', 'active-turn')).steered).toBe(false);
    expect(f.queue.state('original-A')).toBe('unknown');
    f.overrides.delete('thread/queue/update');
    await f.queue.reconcile();
    expect(f.queue.state('original-A')).toBe('queued');
    expect(f.queue.state('original-B')).toBe('queued');
    expect(f.mirror).not.toHaveBeenCalledWith('original-A', null);
    await f.queue.suspend();
    expect(f.queue.state('original-A')).toBe('released');
    expect(f.queue.state('original-B')).toBe('released');
});

it('keeps a lost fresh-add outcome unknown without replaying the consumed sibling', async () => {
    const f = await fixture();
    await f.queue.enqueue('original-A', text('A'), false, 'same');
    await f.queue.enqueue('original-B', text('B'), false, 'same');
    const batchId = f.native[0].clientUserMessageId;
    f.overrides.set('turn/steer', async () => {
        f.native.splice(0);
        await f.queue.committed(batchId, text('B'));
        f.overrides.set('thread/queue/add', params => {
            f.native.push({ id: 'restored-A', clientUserMessageId: params.clientUserMessageId as string, input: params.input as QueueInput });
            throw lost('fresh add response lost');
        });
        throw new Error('expected active turn id mismatch');
    });
    await f.queue.steer('original-A', 'active-turn');
    expect(f.queue.state('original-A')).toBe('unknown');
    expect(f.queue.state('original-B')).toBe('consumed');
    f.overrides.delete('thread/queue/add');
    const reloaded = new SharedCodexQueue(f.client, 'thread', join(f.directory, 'ledger.json'), vi.fn(), vi.fn());
    await reloaded.load();
    await reloaded.enqueue('original-A', text('A'), false, 'same');
    expect(f.native).toHaveLength(1);
    expect(f.native[0].input).toEqual(text('A'));
    expect(f.calls.filter(c => c.method === 'thread/queue/add')).toHaveLength(2);
});


it('recovers detached steering ownership from an older v2 ledger without the flag', async () => {
    const f = await fixture();
    await f.queue.enqueue('original-A', text('A'), false, 'same');
    await f.queue.enqueue('original-B', text('B'), false, 'same');
    f.overrides.set('turn/steer', () => { throw lost('steer reply lost'); });
    await f.queue.steer('original-A', 'active-turn');
    const file = join(f.directory, 'ledger.json');
    const saved = JSON.parse(await readFile(file, 'utf8'));
    delete saved.entries['original-A'].detachedSteer;
    await writeFile(file, JSON.stringify(saved));
    const reloaded = new SharedCodexQueue(f.client, 'thread', file, vi.fn(), vi.fn(), f.mirror);
    await reloaded.load();
    await reloaded.nativeMutation('thread/queue/delete', { threadId: 'thread', queuedSubmissionId: f.native[0].id });
    expect(reloaded.state('original-A')).toBe('unknown');
    expect(reloaded.state('original-B')).toBe('canceled');
});

it('preserves original identities when restoration is consumed before its update response', async () => {
    const f = await fixture();
    await f.queue.enqueue('original-A', text('A'), false, 'same');
    await f.queue.enqueue('original-B', text('B'), false, 'same');
    const batchId = f.native[0].clientUserMessageId;
    f.overrides.set('turn/steer', () => {
        f.overrides.set('thread/queue/update', async params => {
            f.native[0].input = structuredClone(params.input as QueueInput);
            await f.queue.committed(batchId, params.input);
            return { queuedSubmission: structuredClone(f.native[0]) };
        });
        throw new Error('expected active turn id mismatch');
    });
    await f.queue.steer('original-A', 'active-turn');
    expect(f.queue.state('original-A')).toBe('consumed');
    expect(f.queue.state('original-B')).toBe('consumed');
    expect(f.consumed).toHaveBeenCalledWith(['original-A', 'original-B']);
});

it.each([false, true])('does not retry an uncertain append with missing-submission text (applied: %s)', async applied => {
    const f = await fixture();
    await f.queue.enqueue('original-A', text('A'), false, 'same');
    f.overrides.set('thread/queue/update', params => {
        if (applied) f.native[0].input = structuredClone(params.input as QueueInput);
        throw lost('queued submission not found');
    });
    await expect(f.queue.enqueue('original-B', text('B'), false, 'same')).rejects.toThrow('queued submission not found');
    expect(f.queue.state('original-B')).toBe('unknown');
    expect(f.calls.filter(c => c.method === 'thread/queue/add')).toHaveLength(1);
    const restarted = new SharedCodexQueue(f.client, 'thread', join(f.directory, 'ledger.json'), f.consumed, f.uncertain);
    await restarted.load();
    f.overrides.delete('thread/queue/update');
    await restarted.enqueue('original-B', text('B'), false, 'same');
    expect(f.calls.filter(c => c.method === 'thread/queue/add')).toHaveLength(1);
    expect(f.calls.filter(c => c.method === 'thread/queue/update')).toHaveLength(1);
    expect(f.native).toHaveLength(1);
    expect(f.native[0].input).toEqual(applied ? [...text('A'), ...text('B')] : text('A'));
    expect(f.consumed).not.toHaveBeenCalled();
});

it('never retries restoration whose missing-submission response is itself uncertain', async () => {
    const f = await fixture();
    await f.queue.enqueue('original-A', text('A'), false, 'same');
    await f.queue.enqueue('original-B', text('B'), false, 'same');
    f.overrides.set('turn/steer', () => {
        f.overrides.set('thread/queue/update', () => { throw lost('queued submission not found'); });
        throw new Error('expected active turn id mismatch');
    });
    await f.queue.steer('original-A', 'active-turn');
    expect(f.queue.state('original-A')).toBe('unknown');
    expect(f.calls.filter(c => c.method === 'thread/queue/add')).toHaveLength(1);
});

it('does not reattach a restored standalone input when delayed sibling consumption arrives', async () => {
    const f = await fixture();
    await f.queue.enqueue('original-A', text('A'), false, 'same');
    await f.queue.enqueue('original-B', text('B'), false, 'same');
    const batchId = f.native[0].clientUserMessageId;
    f.overrides.set('turn/steer', () => {
        f.native.splice(0);
        throw new Error('expected active turn id mismatch');
    });
    await f.queue.steer('original-A', 'active-turn');
    await f.queue.committed(batchId, text('B'));
    expect(f.queue.state('original-A')).toBe('queued');
    await f.queue.suspend();
    expect(f.queue.state('original-A')).toBe('released');
    expect(f.queue.state('original-B')).toBe('consumed');
});


it('reports batch dequeues using original members only after the native submission disappears', async () => {
    const { queue, native, consumed, uncertain } = await fixture();
    await queue.enqueue('original-A', text('MARKER-A'), false, 'same-mode');
    await queue.enqueue('original-B', text('MARKER-B'), false, 'same-mode');
    expect(native).toHaveLength(1);
    expect(await queue.reconcile()).toEqual([]);
    expect(queue.state('original-A')).toBe('queued');
    expect(queue.state('original-B')).toBe('queued');
    expect(uncertain).not.toHaveBeenCalled();
    native.splice(0);
    expect(await queue.reconcile()).toEqual(['original-A', 'original-B']);
    expect(await queue.reconcile()).toEqual([]);
    expect(queue.state('original-A')).toBe('unknown');
    expect(queue.state('original-B')).toBe('unknown');
    expect(consumed).not.toHaveBeenCalled();
});
