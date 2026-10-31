import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SharedCodexQueue } from './queue';

const input = [{ type: 'text', text: 'hello' }];
const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
async function fixture() {
    const dir = await mkdtemp(join(tmpdir(), 'hapi-queue-')); directories.push(dir);
    const rpc = vi.fn<(method: string, params: unknown) => Promise<unknown>>();
    const client = { request: async <T>(method: string, params?: unknown) => await rpc(method, params) as T };
    const consumed = vi.fn(); const uncertain = vi.fn();
    const queue = new SharedCodexQueue(client, 'thread', join(dir, 'ledger.json'), consumed, uncertain);
    await queue.load();
    return { queue, rpc, consumed, uncertain, client, dir };
}
describe('shared native queue', () => {
    it('does not restore potentially stale input when the shutdown snapshot is unavailable', async () => {
        const { queue, rpc, uncertain } = await fixture();
        rpc.mockResolvedValueOnce({ queuedSubmission: { id: 'n', input, clientUserMessageId: 'local' } }); await queue.enqueue('local', input);
        rpc.mockRejectedValueOnce(new Error('snapshot lost')); await queue.suspend();
        expect(queue.state('local')).toBe('unknown'); expect(uncertain).toHaveBeenCalledWith(['local']);
        expect(rpc.mock.calls.some(([method]) => method === 'thread/queue/delete')).toBe(false);
    });
    it('returns only confirmed-deleted input to ordinary cold-resume delivery, preserving native edits', async () => {
        const { queue, rpc, client, dir, consumed, uncertain } = await fixture();
        rpc.mockResolvedValueOnce({ queuedSubmission: { id: 'n', input, clientUserMessageId: 'local' } });
        await queue.enqueue('local', input);
        const edited = [{ type: 'text', text: 'edited in native queue' }];
        rpc.mockResolvedValueOnce({ data: [{ id: 'n', input: edited, clientUserMessageId: 'local' }] })
            .mockResolvedValueOnce({ deleted: true });
        await queue.suspend();
        expect(queue.state('local')).toBe('released'); expect(consumed).not.toHaveBeenCalled();
        const requeued = vi.fn(async () => true);
        const restarted = new SharedCodexQueue(client, 'thread', join(dir, 'ledger.json'), consumed, uncertain, undefined, requeued);
        await restarted.load(); rpc.mockResolvedValueOnce({ data: [] }); await restarted.reconcile();
        expect(requeued).toHaveBeenCalledWith(['local']);
        rpc.mockResolvedValueOnce({ queuedSubmission: { id: 'new-n', input: edited, clientUserMessageId: 'local' } });
        await restarted.enqueue('local', input);
        expect(rpc).toHaveBeenLastCalledWith('thread/queue/add', { threadId: 'thread', input: edited, clientUserMessageId: 'local' });
        await restarted.committed('local'); await restarted.enqueue('local', input);
        expect(rpc.mock.calls.filter(([method]) => method === 'thread/queue/add')).toHaveLength(2);
    });
    it.each(['consumed', 'missing', 'lost ACK'] as const)('does not replay a suspended submission whose delete outcome is %s', async outcome => {
        const { queue, rpc, client, dir, consumed, uncertain } = await fixture();
        const queued = { id: 'n', input, clientUserMessageId: 'local' };
        rpc.mockResolvedValueOnce({ queuedSubmission: queued }); await queue.enqueue('local', input);
        rpc.mockResolvedValueOnce({ data: [queued] }).mockImplementationOnce(async () => {
            if (outcome === 'lost ACK') throw new Error('connection lost');
            if (outcome === 'consumed') await queue.committed('local');
            return { deleted: false };
        });
        await queue.suspend(); expect(queue.state('local')).toBe(outcome === 'consumed' ? 'consumed' : 'unknown');
        const restarted = new SharedCodexQueue(client, 'thread', join(dir, 'ledger.json'), consumed, uncertain);
        await restarted.load(); rpc.mockResolvedValue({ data: [] }); await restarted.enqueue('local', input);
        expect(rpc.mock.calls.filter(([method]) => method === 'thread/queue/add')).toHaveLength(1);
    });
    it('never repeats a completed or uncertain slash-command mutation after execution replacement', async () => {
        const { queue, client, dir, consumed, uncertain } = await fixture();
        const create = vi.fn(async () => null);
        await queue.command('clear', create);
        await expect(queue.command('unknown', async () => { throw new Error('lost binding ACK'); })).rejects.toThrow();
        const restarted = new SharedCodexQueue(client, 'thread', join(dir, 'ledger.json'), consumed, uncertain); await restarted.load();
        await restarted.command('clear', create);
        await expect(restarted.command('unknown', create)).rejects.toThrow('not replaying');
        expect(create).toHaveBeenCalledOnce(); expect(consumed).toHaveBeenCalledWith(['clear']);
    });
    it('remembers cold-history acceptance before redelivery from the hub', async () => {
        const { queue, rpc, client, dir, consumed, uncertain } = await fixture();
        await queue.committed('history-only');
        const restarted = new SharedCodexQueue(client, 'thread', join(dir, 'ledger.json'), consumed, uncertain); await restarted.load();
        await restarted.enqueue('history-only', input);
        expect(rpc).not.toHaveBeenCalled(); expect(consumed).toHaveBeenCalledWith(['history-only']);
    });
    it('adopts native queued input, mirrors edits and withdraws only after a proven native delete', async () => {
        const { rpc, client, dir, consumed, uncertain } = await fixture(); const mirror = vi.fn();
        const queue = new SharedCodexQueue(client, 'thread', join(dir, 'native.json'), consumed, uncertain, mirror); await queue.load();
        rpc.mockResolvedValue({ data: [{ id: 'n', clientUserMessageId: 'native', input }], nextCursor: null });
        await queue.reconcile(); expect(mirror).toHaveBeenCalledWith('native', input);
        rpc.mockResolvedValue({ data: [], nextCursor: null }); await queue.reconcile();
        expect(queue.state('native')).toBe('unknown'); expect(mirror).not.toHaveBeenCalledWith('native', null);
        await queue.deleted('n'); expect(mirror).toHaveBeenCalledWith('native', null);
    });
    it('treats a failed reconciliation during cancel as indeterminate, not a failed ACK', async () => {
        const { queue, rpc } = await fixture();
        rpc.mockResolvedValueOnce({ queuedSubmission: { id: 'n', input, clientUserMessageId: 'local' } }); await queue.enqueue('local', input);
        rpc.mockRejectedValue(new Error('disconnected'));
        expect(await queue.cancel('local')).toBe('indeterminate');
    });
    it('uses queue/add only, with no enqueue-time model/settings or second drainer', async () => {
        const { queue, rpc } = await fixture();
        rpc.mockResolvedValue({ queuedSubmission: { id: 'native', input, clientUserMessageId: 'local' } });
        await queue.enqueue('local', input);
        expect(rpc.mock.calls).toEqual([['thread/queue/add', { threadId: 'thread', input, clientUserMessageId: 'local' }]]);
    });
    it('does not downgrade a committed event arriving before the queue ACK', async () => {
        const { queue, rpc, consumed } = await fixture();
        rpc.mockImplementation(async () => { await queue.committed('local'); return { queuedSubmission: { id: 'native', input, clientUserMessageId: 'local' } }; });
        await queue.enqueue('local', input);
        expect(queue.state('local')).toBe('consumed'); expect(consumed).toHaveBeenCalledWith(['local']);
    });
    it('persists uncertainty before dispatch and never blindly re-enqueues after a crash', async () => {
        const { queue, rpc, client, dir, consumed, uncertain } = await fixture();
        rpc.mockResolvedValueOnce({ invalidResponse: true });
        await expect(queue.enqueue('local', input)).rejects.toThrow();
        const restarted = new SharedCodexQueue(client, 'thread', join(dir, 'ledger.json'), consumed, uncertain); await restarted.load();
        rpc.mockResolvedValue({ data: [], nextCursor: null });
        await restarted.enqueue('local', input);
        expect(restarted.state('local')).toBe('unknown');
        expect(rpc.mock.calls.filter(([method]) => method === 'thread/queue/add')).toHaveLength(1);
    });
    it('waits for a definitive native delete before acknowledging cancellation', async () => {
        const { queue, rpc } = await fixture();
        rpc.mockResolvedValueOnce({ queuedSubmission: { id: 'native', input, clientUserMessageId: 'local' } }); await queue.enqueue('local', input);
        rpc.mockResolvedValueOnce({ data: [{ id: 'native', input, clientUserMessageId: 'local' }], nextCursor: null }).mockResolvedValueOnce({ deleted: false });
        expect(await queue.cancel('local')).toBe('indeterminate');
    });
    it('pins steer to one turn and restores only on explicit rejection', async () => {
        const { queue, rpc } = await fixture();
        const queued = { id: 'native', input, clientUserMessageId: 'local' };
        rpc.mockResolvedValueOnce({ queuedSubmission: queued }); await queue.enqueue('local', input);
        rpc.mockResolvedValueOnce({ data: [queued], nextCursor: null }).mockResolvedValueOnce({ deleted: true })
            .mockRejectedValueOnce(new Error('expected active turn id mismatch')).mockResolvedValueOnce({ queuedSubmission: { ...queued, id: 'restored' } });
        expect(await queue.steer('local', 'turn-a')).toMatchObject({ steered: false });
        expect(rpc.mock.calls[3]).toEqual(['turn/steer', { threadId: 'thread', expectedTurnId: 'turn-a', input, clientUserMessageId: 'local' }]);
        expect(queue.state('local')).toBe('queued');
    });
});
