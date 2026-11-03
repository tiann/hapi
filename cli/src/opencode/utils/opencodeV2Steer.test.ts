import { describe, expect, it, vi } from 'vitest';
import { admitOpencodeV2Steer, cancelOpencodeV2Steer, opencodeV2InputId, readOpencodeV2Input } from './opencodeV2Steer';

const context = { baseUrl: 'http://127.0.0.1:1234', password: 'test-only', sessionId: 'ses_native', inputId: 'msg_input' };
const item = { id: context.inputId, sessionID: context.sessionId, type: 'user', delivery: 'steer', payload: { text: 'correction' } };
const message = { id: context.inputId, sessionID: context.sessionId, type: 'user', text: 'correction' };

describe('OpenCode v2 steer receipts', () => {
    it('uses a stable input identity scoped to both sessions, local id and text', () => {
        const scope = { hapiSessionId: 'hapi', sessionId: 'ses_native', localId: 'local', text: 'correction' };
        const id = opencodeV2InputId(scope);
        expect(id).toMatch(/^msg_/);
        expect(opencodeV2InputId(scope)).toBe(id);
        for (const key of Object.keys(scope) as Array<keyof typeof scope>) {
            expect(opencodeV2InputId({ ...scope, [key]: scope[key] + '-other' })).not.toBe(id);
        }
    });

    it('posts durable native steer with exact identity and Basic auth', async () => {
        const fetchImpl = vi.fn(async () => Response.json({ data: item }));
        await expect(admitOpencodeV2Steer({ ...context, text: 'correction', fetchImpl })).resolves.toBe('admitted');
        const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
        expect(url).toBe('http://127.0.0.1:1234/api/session/ses_native/prompt');
        expect(init.method).toBe('POST');
        expect(JSON.parse(String(init.body))).toEqual({ id: 'msg_input', text: 'correction', delivery: 'steer' });
        expect(init.headers).toMatchObject({ authorization: 'Basic ' + Buffer.from('opencode:test-only').toString('base64') });
    });

    it('promotes an existing parked item instead of duplicating admission', async () => {
        const fetchImpl = vi.fn().mockResolvedValueOnce(Response.json({ data: { ...item, delivery: 'queue' } }))
            .mockResolvedValueOnce(new Response(null, { status: 204 }));
        await expect(admitOpencodeV2Steer({ ...context, text: 'correction', fetchImpl })).resolves.toBe('admitted');
        expect(fetchImpl.mock.calls[1][1]).toMatchObject({ method: 'PATCH', body: JSON.stringify({ delivery: 'steer' }) });
    });

    it.each([400, 401, 403, 404, 422])('distinguishes definite admission rejection HTTP%s', async status => {
        await expect(admitOpencodeV2Steer({ ...context, text: 'correction', fetchImpl: async () => new Response(null, { status }) }))
            .resolves.toBe('rejected');
    });

    it.each([{}, { data: { ...item, id: 'other' } }, { data: { ...item, sessionID: 'other' } }, { data: { ...item, payload: { text: 'other' } } }])('holds an unverified admission unknown: %j', async data => {
        await expect(admitOpencodeV2Steer({ ...context, text: 'correction', fetchImpl: async () => Response.json(data) }))
            .resolves.toBe('unknown');
    });

    it('retains a lost response as unknown without automatically posting again', async () => {
        const fetchImpl = vi.fn(async () => { throw new Error('response lost'); });
        await expect(admitOpencodeV2Steer({ ...context, text: 'correction', fetchImpl })).resolves.toBe('unknown');
        expect(fetchImpl).toHaveBeenCalledTimes(1);
    });

    it('keeps admitted inbox work pending, separate from actual delivery', async () => {
        await expect(readOpencodeV2Input({ ...context, fetchImpl: async () => Response.json({ data: [item] }) })).resolves.toBe('pending');
    });

    it('recovers a missed delivered event only from the exact projected user id', async () => {
        const fetchImpl = vi.fn().mockResolvedValueOnce(Response.json({ data: [] })).mockResolvedValueOnce(Response.json({ data: message }));
        await expect(readOpencodeV2Input({ ...context, fetchImpl })).resolves.toBe('delivered');
        expect(fetchImpl.mock.calls[1][0]).toContain('/message/msg_input');
    });

    it('does not treat missing inbox work alone as delivered or cancelled', async () => {
        const fetchImpl = vi.fn().mockResolvedValueOnce(Response.json({ data: [] })).mockResolvedValueOnce(new Response(null, { status: 404 }));
        await expect(readOpencodeV2Input({ ...context, fetchImpl })).resolves.toBe('missing');
    });

    it.each([{ data: {} }, { data: [{ ...item, sessionID: 'other' }] }])('rejects malformed or cross-session inbox readback: %j', async data => {
        await expect(readOpencodeV2Input({ ...context, fetchImpl: async () => Response.json(data) })).resolves.toBe('unknown');
    });

    it('confirms cancellation with ordered inbox and projection readback after DELETE', async () => {
        const fetchImpl = vi.fn().mockResolvedValueOnce(new Response(null, { status: 204 }))
            .mockResolvedValueOnce(Response.json({ data: [] })).mockResolvedValueOnce(new Response(null, { status: 404 }));
        await expect(cancelOpencodeV2Steer({ ...context, fetchImpl })).resolves.toBe('cancelled');
        expect(fetchImpl.mock.calls.map(call => call[1]?.method ?? 'GET')).toEqual(['DELETE', 'GET', 'GET']);
    });

    it('does not mistake native no-op DELETE204 for successful cancellation after delivery', async () => {
        const fetchImpl = vi.fn().mockResolvedValueOnce(new Response(null, { status: 204 }))
            .mockResolvedValueOnce(Response.json({ data: [] })).mockResolvedValueOnce(Response.json({ data: message }));
        await expect(cancelOpencodeV2Steer({ ...context, fetchImpl })).resolves.toBe('delivered');
    });

    it('holds uncertain cancellation unknown', async () => {
        await expect(cancelOpencodeV2Steer({ ...context, fetchImpl: async () => { throw new Error('lost cancel'); } })).resolves.toBe('unknown');
    });
});
