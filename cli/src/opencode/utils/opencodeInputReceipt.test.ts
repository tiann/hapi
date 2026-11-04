import { describe, expect, it, vi } from 'vitest';
import { fetchOpencodeUserMessages } from './opencodeInputReceipt';

const context = { baseUrl: 'http://127.0.0.1:1234', sessionId: 'session/one' };
const user = { info: { id: 'user-1', role: 'user' }, parts: [{ type: 'text', text: 'correction' }] };

describe('fetchOpencodeUserMessages', () => {
    it('reads native ids and joins text parts, excluding assistant output', async () => {
        const fetchImpl = vi.fn(async (_url: string, _init?: RequestInit) => Response.json([
            { ...user, parts: [{ type: 'text', text: 'mid-' }, { type: 'text', text: 'turn' }] },
            { info: { role: 'assistant' }, parts: [{ type: 'text', text: 'mid-turn' }] }
        ]));
        await expect(fetchOpencodeUserMessages({ ...context, fetchImpl })).resolves.toEqual([{ id: 'user-1', text: 'mid-turn' }]);
        expect(fetchImpl).toHaveBeenCalledWith('http://127.0.0.1:1234/session/session%2Fone/message', expect.objectContaining({ method: 'GET', signal: expect.any(AbortSignal) }));
    });

    it.each([
        null, {}, [null], [{ info: null }],
        [{ ...user, info: { role: 'user' } }],
        [{ ...user, info: { id: '', role: 'user' } }],
        [{ ...user, parts: undefined }],
        [{ ...user, parts: [null] }],
        [{ ...user, parts: [{ type: 'text', text: 42 }] }],
        [{ ...user, parts: [{ type: 'text', text: 'correction', synthetic: 'true' }] }],
        [{ ...user, parts: [{ type: 'text', text: 'correction', ignored: {} }] }],
        [user, user]
    ])('does not treat malformed or duplicate history as an input receipt: %j', async data => {
        await expect(fetchOpencodeUserMessages({ ...context, fetchImpl: async () => Response.json(data) })).resolves.toBeNull();
    });

    it.each([
        { parts: [{ type: 'file', mime: 'image/png', filename: 'image.png' }] },
        { parts: [] }
    ])('does not infer text receipt identity from media replay or incomplete user history', async ({ parts }) => {
        await expect(fetchOpencodeUserMessages({ ...context, fetchImpl: async () => Response.json([{ ...user, parts }]) }))
            .resolves.toBeNull();
    });

    it('returns unknown for an unavailable native endpoint', async () => {
        await expect(fetchOpencodeUserMessages({ ...context, fetchImpl: async () => new Response(null, { status: 404 }) })).resolves.toBeNull();
        await expect(fetchOpencodeUserMessages({ ...context, fetchImpl: async () => { throw new Error('offline'); } })).resolves.toBeNull();
    });

    it.each(['synthetic', 'ignored'])('retains an internal %s row identity without using its text as input proof', async flag => {
        const helper = { ...user, parts: [{ type: 'text', text: 'correction', [flag]: true }] };
        await expect(fetchOpencodeUserMessages({ ...context, fetchImpl: async () => Response.json([helper]) }))
            .resolves.toEqual([{ id: 'user-1', text: null }]);
    });

    it('reads only submitted text beside synthetic or ignored helper parts', async () => {
        const mixed = { ...user, parts: [
            { type: 'text', text: 'helper', synthetic: true },
            { type: 'text', text: 'correction' },
            { type: 'text', text: 'display only', ignored: true }
        ] };
        await expect(fetchOpencodeUserMessages({ ...context, fetchImpl: async () => Response.json([mixed]) }))
            .resolves.toEqual([{ id: 'user-1', text: 'correction' }]);
    });

    it.each([
        { parts: [{ type: 'compaction', auto: true }, { type: 'text', text: 'correction' }] },
        { parts: [{ type: 'text', text: 'correction', metadata: { compaction_continue: true } }] }
    ])('does not use native compaction controls or continuations as input proof', async ({ parts }) => {
        await expect(fetchOpencodeUserMessages({ ...context, fetchImpl: async () => Response.json([{ ...user, parts }]) }))
            .resolves.toEqual([{ id: 'user-1', text: null }]);
    });

    it('does not send without a native session context', async () => {
        const fetchImpl = vi.fn();
        await expect(fetchOpencodeUserMessages({ ...context, baseUrl: null, fetchImpl })).resolves.toBeNull();
        await expect(fetchOpencodeUserMessages({ ...context, sessionId: null, fetchImpl })).resolves.toBeNull();
        expect(fetchImpl).not.toHaveBeenCalled();
    });

    it('propagates caller cancellation and conservatively returns unknown', async () => {
        const controller = new AbortController();
        const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
        }));
        const receipt = fetchOpencodeUserMessages({ ...context, signal: controller.signal, fetchImpl });
        controller.abort();
        await expect(receipt).resolves.toBeNull();
    });
});
