import { describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import type { Metadata } from '@/api/types';
import { observeLocalHistory, createLocalHistoryPublisher } from './localHistory';
import { OpencodeConversationHistory } from './conversationHistory';
import { monotonicTimeMs } from '@/utils/time';

vi.mock('@/utils/time', async (original) => ({
    ...await original<typeof import('@/utils/time')>(), monotonicTimeMs: () => Date.now()
}));

const base: Metadata = { path: '/tmp/project', host: 'fixture',
    capabilities: { conversationHistory: { forkCurrent: true } },
    opencodeHistoryCheckpoint: { sessionId: 'ses_1', messageIds: ['msg_c'], userMessageIds: ['msg_c'], localMessageIds: [] } };

function historyFor(metadata: Metadata, ids: string[]) {
    const history = new OpencodeConversationHistory(() => ({ baseUrl: 'http://fixture', sessionId: 'ses_1' }),
        async () => new Response(JSON.stringify(ids.map((id) => ({ info: { id, role: 'user' } })))));
    history.restoreCheckpoint(metadata.opencodeHistoryCheckpoint);
    return history;
}

describe('local publication identity observations', () => {
    it('refuses unobserved native conversation growth after a publisher crash', async () => {
        await expect(historyFor(base, ['msg_c', 'msg_unpublished']).reconcileHistory()).rejects.toThrow('diverged');
    });

    it('does not trust a local publication that was not committed before the wrapper exited', async () => {
        const pending = { ...base, opencodeHistoryCheckpoint: { ...base.opencodeHistoryCheckpoint!,
            localMessageIds: ['msg_a'], localPublicationPending: true as const } };
        await expect(historyFor(pending, ['msg_c', 'msg_a']).reconcileHistory()).rejects.toThrow('diverged');
    });

    it('detects local A -> undo A -> B even though the remote checkpoint prefix C survives', async () => {
        const observedA = observeLocalHistory(base, 'ses_1', 'msg_a');
        const observedB = observeLocalHistory(observedA, 'ses_1', 'msg_b');
        expect(observedB.opencodeHistoryCheckpoint?.localMessageIds).toEqual(['msg_a', 'msg_b']);
        const history = historyFor(observedB, ['msg_c', 'msg_b']);
        await expect(history.reconcileHistory()).rejects.toThrow('diverged');
        expect(history.isDiverged()).toBe(true);
    });

    it('adopts append-only local publications and absorbs their observations into the new snapshot', async () => {
        const a = observeLocalHistory(base, 'ses_1', 'msg_a');
        const b = observeLocalHistory(observeLocalHistory(a, 'ses_1', 'msg_a'), 'ses_1', 'msg_b');
        expect(b.opencodeHistoryCheckpoint?.localMessageIds).toEqual(['msg_a', 'msg_b']);
        const history = historyFor(b, ['msg_c', 'msg_a', 'msg_b']);
        await expect(history.reconcileHistory()).resolves.toBe(3);
        expect(history.getCheckpoint()?.localMessageIds).toEqual([]);
        expect(history.isDiverged()).toBe(false);
    });

    it('tracks local-only turns even when no remote checkpoint existed yet', async () => {
        const a = observeLocalHistory({ path: '/tmp/project', host: 'fixture' }, 'ses_1', 'msg_a');
        const b = observeLocalHistory(a, 'ses_1', 'msg_b');
        await expect(historyFor(b, ['msg_b']).reconcileHistory()).rejects.toThrow('diverged');
    });

    it.each([null, 'different-session'])('fails closed when the publication cannot be tied to the native session (%s)', (sessionId) => {
        const observed = observeLocalHistory(base, sessionId, 'msg_a');
        expect(observed.conversationHistoryDiverged).toBe(true);
        expect(observed.capabilities?.conversationHistory).toBeUndefined();
        expect(observed.opencodeHistoryCheckpoint).toBeUndefined();
    });

    it('fails closed for content without a native message id and never clears persisted divergence', () => {
        const unknown = observeLocalHistory(base, 'ses_1', null);
        expect(unknown.conversationHistoryDiverged).toBe(true);
        expect(observeLocalHistory(unknown, 'ses_1', 'msg_a')).toBe(unknown);
    });

    it('does not silently upgrade an older checkpoint whose local publications were not tracked', async () => {
        const { localMessageIds, ...legacy } = base.opencodeHistoryCheckpoint!;
        const old: Metadata = { ...base, opencodeHistoryCheckpoint: legacy };
        expect(observeLocalHistory(old, 'ses_1', 'msg_b').conversationHistoryDiverged).toBe(true);
        await expect(historyFor(old, ['msg_c', 'msg_b']).reconcileHistory()).rejects.toThrow('diverged');
    });
});

describe('durable local publication journal', () => {
    it('does not close admission when a healthy prepare finishes after its caller lease expired', async () => {
        vi.useFakeTimers()
        let release!: () => void;
        let metadata: Metadata = structuredClone(base);
        const guard = new Promise<void>((resolve) => { release = resolve; });
        const sent: string[] = [];
        const publisher = createLocalHistoryPublisher({
            updateMetadata(handler) { metadata = handler(metadata); }, materialize: async () => true,
            flushMetadata: async () => { await guard; return true; }, flush: async () => true
        }, vi.fn());
        try {
            publisher.publish('ses_1', 'a', () => { sent.push('a'); });
            const preparing = publisher.prepare({ id: 'first', expiresAt: monotonicTimeMs() + 30000 });
            await vi.advanceTimersByTimeAsync(31000);
            release();
            expect(await preparing).toBe(false);
            publisher.publish('ses_1', 'b', () => { sent.push('b'); });
            await publisher.flush();
            expect(sent).toEqual(['a', 'b']);
        } finally { publisher.stop(); vi.useRealTimers(); }
    });

    it('restores publications held after a prepared reply when no caller commits termination', async () => {
        vi.useFakeTimers();
        let metadata: Metadata = structuredClone(base);
        const sent: string[] = [];
        const publisher = createLocalHistoryPublisher({
            updateMetadata(handler) { metadata = handler(metadata); }, materialize: async () => true,
            flushMetadata: async () => true, flush: async () => true
        }, vi.fn());
        try {
            publisher.publish('ses_1', 'a', () => { sent.push('a'); });
            expect(await publisher.prepare({ id: 'first', expiresAt: monotonicTimeMs() + 30000 })).toBe(true);
            publisher.publish('ses_1', 'b', () => { sent.push('b'); });
            expect(sent).toEqual(['a']);
            expect(await publisher.prepare({ id: 'other', expiresAt: monotonicTimeMs() + 30000 })).toBe(false);
            await vi.advanceTimersByTimeAsync(30001);
            publisher.publish('ses_1', 'c', () => { sent.push('c'); });
            await publisher.flush();
            expect(sent).toEqual(['a', 'b', 'c']);
            expect(metadata.conversationHistoryDiverged).toBe(true);
        } finally { publisher.stop(); vi.useRealTimers(); }
    });

    it('retains ownership and retries unsent rows after an unconfirmed cooperative stop', async () => {
        let metadata: Metadata = structuredClone(base);
        let online = false;
        let release!: () => void;
        let flushes = 0;
        const guard = new Promise<void>((resolve) => { release = resolve; });
        const sent: string[] = [];
        const publisher = createLocalHistoryPublisher({
            updateMetadata(handler) { metadata = handler(metadata); },
            materialize: async () => true,
            flushMetadata: async () => { if (++flushes === 1) await guard; return online; },
            flush: async () => online
        }, vi.fn());
        try {
            publisher.publish('ses_1', 'msg_a', () => { sent.push('a'); });
            const preparing = publisher.prepare();
            await vi.waitFor(() => expect(flushes).toBe(1));
            // A local completion can arrive while a reversible preparation is
            // waiting for metadata. It must not be deduplicated without send.
            publisher.publish('ses_1', 'msg_b', () => { sent.push('b'); });
            release();
            expect(await preparing).toBe(false);
            expect(sent).toEqual([]);
            online = true;
            expect(await publisher.prepare()).toBe(true);
            expect(sent).toEqual(['a', 'b']);
            expect(metadata.conversationHistoryDiverged).toBe(true);
        } finally { publisher.stop(); }
    });

    it('finishes the frozen queue after an in-flight attempt fails but the next metadata flush succeeds', async () => {
        let metadata: Metadata = structuredClone(base);
        let flushes = 0;
        const client = {
            updateMetadata(handler: (value: Metadata) => Metadata) { metadata = handler(metadata); },
            materialize: async () => true,
            flushMetadata: async () => ++flushes > 1,
            flush: async () => true
        };
        const sent: string[] = [];
        const publisher = createLocalHistoryPublisher(client, vi.fn());
        publisher.publish('ses_1', 'msg_a', () => { sent.push('a'); });
        publisher.publish('ses_1', 'msg_b', () => { sent.push('b'); });
        await expect(publisher.finish()).resolves.toBe(true);
        expect(sent).toEqual(['a', 'b']);
        expect(metadata.conversationHistoryDiverged).toBe(true);
    });

    it('reports unconfirmed shutdown instead of waiting forever for offline materialization', async () => {
        vi.useFakeTimers();
        let metadata: Metadata = structuredClone(base);
        const client = {
            updateMetadata(handler: (value: Metadata) => Metadata) { metadata = handler(metadata); },
            materialize: async () => new Promise<boolean>(() => {}),
            flushMetadata: async () => false,
            flush: async () => false
        };
        const sent: string[] = [];
        const publisher = createLocalHistoryPublisher(client, vi.fn());
        try {
            publisher.publish('ses_1', 'msg_a', () => { sent.push('a'); });
            const finishing = publisher.finish();
            await vi.advanceTimersByTimeAsync(10000);
            await expect(finishing).resolves.toBe(false);
            expect(sent).toEqual([]);
            expect(metadata.conversationHistoryDiverged).toBe(true);
            expect(vi.getTimerCount()).toBe(0);
        } finally {
            publisher.stop();
            vi.useRealTimers();
        }
    });

    it('waits for the identity guard ACK before content and retains it until content is acknowledged', async () => {
        let guardAck!: () => void;
        let contentAck!: () => void;
        const guard = new Promise<void>((resolve) => { guardAck = resolve; });
        const content = new Promise<void>((resolve) => { contentAck = resolve; });
        let metadata: Metadata = structuredClone(base);
        const changes: Array<(value: Metadata) => Metadata> = [];
        let flushes = 0;
        const client = {
            updateMetadata(handler: (value: Metadata) => Metadata) { changes.push(handler); },
            materialize: async () => true,
            flushMetadata: vi.fn(async () => {
                if (++flushes === 1) await guard;
                for (const handler of changes.splice(0)) metadata = handler(metadata);
                return true;
            }),
            flush: vi.fn(async () => { await content; return true; })
        };
        const errors = vi.fn();
        const publisher = createLocalHistoryPublisher(client, errors);
        const sent: string[] = [];
        publisher.publish('ses_1', 'msg_a', () => {
            sent.push('a');
        });
        await vi.waitFor(() => expect(changes).toHaveLength(1));
        await new Promise<void>((resolve) => setImmediate(resolve));
        expect(sent).toEqual([]);
        expect(client.flushMetadata).toHaveBeenCalledTimes(1);
        guardAck();
        await vi.waitFor(() => expect(sent).toEqual(['a']));
        expect(metadata.opencodeHistoryCheckpoint?.localPublicationPending).toBe(true);
        await expect(historyFor(metadata, ['msg_c', 'msg_a']).reconcileHistory()).rejects.toThrow('diverged');
        contentAck();
        await publisher.flush();
        expect(errors).not.toHaveBeenCalled();
        expect(metadata.opencodeHistoryCheckpoint?.localPublicationPending).toBeUndefined();
        await expect(historyFor(metadata, ['msg_c', 'msg_a']).reconcileHistory()).resolves.toBe(2);
    });

    it.each(['metadata', 'content'])('recovers queued and future forwarding after reconnect without restoring fork trust (%s timeout)', async (failure) => {
        let metadata: Metadata = structuredClone(base);
        let connected = failure === 'content';
        let disconnectOnSend = failure === 'content';
        const events = new EventEmitter();
        const changes: Array<(value: Metadata) => Metadata> = [];
        const client = {
            updateMetadata(handler: (value: Metadata) => Metadata) { changes.push(handler); },
            materialize: async () => true,
            flushMetadata: async () => {
                if (!connected) return false;
                for (const handler of changes.splice(0)) metadata = handler(metadata);
                return true;
            },
            flush: async () => connected,
            on: events.on.bind(events), off: events.off.bind(events)
        };
        const errors = vi.fn();
        const publisher = createLocalHistoryPublisher(client, errors);
        const sent: string[] = [];
        publisher.publish('ses_1', 'msg_a', () => {
            sent.push('a');
            if (disconnectOnSend) { connected = false; disconnectOnSend = false; }
        });
        publisher.publish('ses_1', 'msg_b', () => { sent.push('b'); });
        try {
            await publisher.flush();
            expect(sent).toEqual(failure === 'metadata' ? [] : ['a']);
            expect(errors).toHaveBeenCalledTimes(1);
            await expect(historyFor(metadata, ['msg_c', 'msg_a']).reconcileHistory()).rejects.toThrow('diverged');
            connected = true;
            events.emit('connected');
            await vi.waitFor(() => expect(sent).toEqual(['a', 'b']));
            await publisher.flush();
            expect(metadata.conversationHistoryDiverged).toBe(true);
            publisher.publish('ses_1', 'msg_d', () => { sent.push('d'); });
            await publisher.flush();
            expect(sent).toEqual(['a', 'b', 'd']);
            expect(metadata.conversationHistoryDiverged).toBe(true);
        } finally {
            publisher.stop();
            expect(events.listenerCount('connected')).toBe(0);
            events.removeAllListeners();
        }
    });

    it('retries an isolated timeout without requiring another publication or connect event', async () => {
        vi.useFakeTimers();
        let metadata: Metadata = structuredClone(base);
        let online = false;
        const client = {
            updateMetadata(handler: (value: Metadata) => Metadata) { metadata = handler(metadata); },
            materialize: async () => true,
            flushMetadata: async () => online,
            flush: async () => online
        };
        const sent: string[] = [];
        const publisher = createLocalHistoryPublisher(client, vi.fn());
        try {
            publisher.publish('ses_1', 'msg_a', () => { sent.push('a'); });
            await publisher.flush();
            expect(sent).toEqual([]);
            online = true;
            await vi.advanceTimersByTimeAsync(1000);
            expect(sent).toEqual(['a']);
            expect(metadata.conversationHistoryDiverged).toBe(true);
        } finally {
            publisher.stop();
            expect(vi.getTimerCount()).toBe(0);
            vi.useRealTimers();
        }
    });

    it('does not lose a reconnect that arrives while the old guard attempt is timing out', async () => {
        let finish!: (value: boolean) => void;
        const oldGuard = new Promise<boolean>((resolve) => { finish = resolve; });
        const events = new EventEmitter();
        let metadata: Metadata = structuredClone(base);
        let calls = 0;
        const client = {
            updateMetadata(handler: (value: Metadata) => Metadata) { metadata = handler(metadata); },
            materialize: async () => true,
            flushMetadata: vi.fn(async () => ++calls === 1 ? await oldGuard : true),
            flush: async () => true,
            on: events.on.bind(events), off: events.off.bind(events)
        };
        const sent: string[] = [];
        const publisher = createLocalHistoryPublisher(client, vi.fn());
        try {
            publisher.publish('ses_1', 'msg_a', () => { sent.push('a'); });
            await vi.waitFor(() => expect(client.flushMetadata).toHaveBeenCalledTimes(1));
            events.emit('connected');
            finish(false);
            await vi.waitFor(() => expect(sent).toEqual(['a']));
            expect(metadata.conversationHistoryDiverged).toBe(true);
        } finally {
            finish(false);
            publisher.stop();
        }
    });

    it('bounds mode handoff while lazy materialization is offline and retains the pending publication', async () => {
        vi.useFakeTimers();
        let materialized!: (value: boolean) => void;
        const materialization = new Promise<boolean>((resolve) => { materialized = resolve; });
        let metadata: Metadata = structuredClone(base);
        const client = {
            updateMetadata(handler: (value: Metadata) => Metadata) { metadata = handler(metadata); },
            materialize: async () => materialization,
            flushMetadata: async () => true,
            flush: async () => true
        };
        const sent: string[] = [];
        const publisher = createLocalHistoryPublisher(client, vi.fn());
        try {
            publisher.publish('ses_1', 'msg_a', () => { sent.push('a'); });
            const handoff = publisher.flush();
            await vi.advanceTimersByTimeAsync(5000);
            await handoff;
            expect(sent).toEqual([]);
            expect(metadata.conversationHistoryDiverged).toBe(true);
            materialized(true);
            await publisher.flush();
            expect(sent).toEqual(['a']);
            expect(metadata.conversationHistoryDiverged).toBe(true);
        } finally {
            materialized(true);
            publisher.stop();
            vi.useRealTimers();
        }
    });
});
