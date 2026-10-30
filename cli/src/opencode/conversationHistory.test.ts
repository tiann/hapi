import { describe, expect, it, vi } from 'vitest';
import { OpencodeConversationHistory } from './conversationHistory';
import type { FetchLike } from './utils/opencodeCompactBridge';

const noSignal = new AbortController().signal;

describe('OpenCode v2 history transport', () => {
    const context = () => ({
        baseUrl: 'http://127.0.0.1:48273', sessionId: 'ses_v2', mode: 'v2' as const,
        headers: { authorization: 'Basic fixture' }
    });

    it('probes authenticated docs and forks current using the v2 response envelope', async () => {
        const fetchImpl: FetchLike = vi.fn(async (url, init) => {
            expect(init?.headers).toMatchObject({ authorization: 'Basic fixture' });
            if (init?.method === 'POST') {
                expect(url).toBe('http://127.0.0.1:48273/api/session/ses_v2/fork');
                expect(JSON.parse(init.body as string)).toEqual({});
                return jsonResponse({ data: { id: 'ses_child' } });
            }
            if (url.includes('/message?')) return jsonResponse({ data: [], cursor: {} });
            return jsonResponse({ paths: { '/api/session/{sessionID}/fork': { post: {} } } });
        });
        const history = new OpencodeConversationHistory(context, fetchImpl);
        await history.probeCapabilities();
        expect(history.getCapabilitiesForMetadata()?.conversationHistory?.forkAtMessage).toBe(true);
        await expect(history.fork()).resolves.toEqual({ nativeSessionId: 'ses_child' });
    });

    it('counts all paginated user messages and resolves an exclusive before boundary on a later page', async () => {
        const fetchImpl: FetchLike = vi.fn(async (url, init) => {
            expect(init?.headers).toMatchObject({ authorization: 'Basic fixture' });
            if (init?.method === 'POST') {
                expect(JSON.parse(init.body as string)).toEqual({ before: 'msg_second' });
                return jsonResponse({ data: { id: 'ses_child' } });
            }
            const parsed = new URL(url);
            expect(parsed.pathname).toBe('/api/session/ses_v2/message');
            expect(parsed.searchParams.has('type')).toBe(false);
            if (parsed.searchParams.has('cursor')) {
                expect(parsed.searchParams.get('cursor')).toBe('page-2');
                expect(parsed.searchParams.has('order')).toBe(false);
                return jsonResponse({ data: [{ id: 'msg_second', type: 'user', text: 'second' }], cursor: {} });
            }
            expect(parsed.searchParams.get('order')).toBe('asc');
            return jsonResponse({ data: [{ id: 'msg_first', type: 'user', text: 'first' }], cursor: { next: 'page-2' } });
        });
        const history = new OpencodeConversationHistory(context, fetchImpl);
        await history.reconcileHistory(undefined, { allowUnobservedAppend: true });
        await expect(history.getNativeUserMessageCount()).resolves.toBe(2);
        history.rememberPromptIndex('local-second', 1);
        await expect(history.fork('local-second')).resolves.toEqual({ nativeSessionId: 'ses_child' });
    });

    it('fails closed on pagination failure and never posts a guessed boundary', async () => {
        const fetchImpl = vi.fn(async () => jsonResponse({ data: [], cursor: { next: 'repeated' } }));
        const history = new OpencodeConversationHistory(context, fetchImpl);
        await expect(history.getNativeUserMessageCount()).resolves.toBeNull();
        history.rememberPromptIndex('local-one', 0);
        await expect(history.fork('local-one')).rejects.toThrow('repeated a message cursor');
        expect(fetchImpl.mock.calls.every((call) => (call as unknown[])[1] && ((call as unknown[])[1] as RequestInit).method === 'GET')).toBe(true);
    });
});

function jsonResponse(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' }
    });
}

function createContext(baseUrl: string | null, sessionId: string | null) {
    return () => ({ baseUrl, sessionId });
}

describe('OpencodeConversationHistory probeCapabilities', () => {
    it('marks fork capabilities supported when the openapi doc contains the fork path', async () => {
        const fetchImpl: FetchLike = vi.fn(async (url: string) => {
            expect(url).toBe('http://127.0.0.1:48273/doc');
            return new Response('<html>session/{id}/fork POST</html>', { status: 200 });
        });

        const history = new OpencodeConversationHistory(createContext('http://127.0.0.1:48273', 'ses_1'), fetchImpl);
        await history.probeCapabilities();

        const capabilities = history.getCapabilitiesForMetadata()?.conversationHistory;
        expect(capabilities).toEqual({ forkCurrent: true, forkAtMessage: true });
    });

    it('falls through to /openapi.json when /doc serves a 200 body without the fork path', async () => {
        const fetchImpl: FetchLike = vi.fn(async (url: string) => {
            if (url.endsWith('/doc')) return new Response('<html>app shell</html>', { status: 200 });
            expect(url).toBe('http://127.0.0.1:48273/openapi.json');
            return jsonResponse({
                paths: {
                    '/session/{id}/fork': { post: {} }
                }
            });
        });

        const history = new OpencodeConversationHistory(createContext('http://127.0.0.1:48273', 'ses_1'), fetchImpl);
        await history.probeCapabilities();

        expect(history.getCapabilitiesForMetadata()?.conversationHistory?.forkAtMessage).toBe(true);
    });

    it('marks fork unsupported when the docs contain no fork path', async () => {
        const fetchImpl: FetchLike = vi.fn(async () => jsonResponse({ paths: { '/session/{id}/message': { get: {} } } }));

        const history = new OpencodeConversationHistory(createContext('http://127.0.0.1:48273', 'ses_1'), fetchImpl);
        await history.probeCapabilities();

        expect(history.getCapabilitiesForMetadata()?.conversationHistory).toBeUndefined();
        await expect(history.fork()).rejects.toThrow(/not supported/);
    });

    it('gracefully hides all fork capabilities on network failure', async () => {
        const fetchImpl: FetchLike = vi.fn(async () => {
            throw new Error('ECONNREFUSED');
        });

        const history = new OpencodeConversationHistory(createContext('http://127.0.0.1:48273', 'ses_1'), fetchImpl);
        await expect(history.probeCapabilities()).resolves.toBeUndefined();
        expect(history.getCapabilitiesForMetadata()?.conversationHistory).toBeUndefined();
    });

    it('falls back to /openapi.json when /doc returns 404', async () => {
        const fetchImpl: FetchLike = vi.fn(async (url: string) => {
            if (url.endsWith('/doc')) return new Response('not found', { status: 404 });
            expect(url).toBe('http://127.0.0.1:48273/openapi.json');
            return jsonResponse({
                paths: {
                    '/session/{sessionID}/fork': { post: {} }
                }
            });
        });

        const history = new OpencodeConversationHistory(createContext('http://127.0.0.1:48273', 'ses_1'), fetchImpl);
        await history.probeCapabilities();

        expect(history.getCapabilitiesForMetadata()?.conversationHistory).toEqual({ forkCurrent: true, forkAtMessage: true });
    });
});

describe('OpencodeConversationHistory.getNativeUserMessageCount', () => {
    it('counts user messages from the native session', async () => {
        const fetchImpl: FetchLike = vi.fn(async (url: string) => {
            expect(url).toBe('http://127.0.0.1:48273/session/ses_1/message');
            return jsonResponse([
                { info: { id: 'msg_1', role: 'user' } },
                { info: { id: 'msg_2', role: 'assistant' } },
                { info: { id: 'msg_3', role: 'user' } }
            ]);
        });

        const history = new OpencodeConversationHistory(createContext('http://127.0.0.1:48273', 'ses_1'), fetchImpl);
        await history.reconcileHistory(undefined, { allowUnobservedAppend: true });
        await expect(history.getNativeUserMessageCount()).resolves.toBe(2);
    });

    it('returns null on request failure instead of throwing', async () => {
        const fetchImpl: FetchLike = vi.fn(async () => new Response('nope', { status: 500 }));

        const history = new OpencodeConversationHistory(createContext('http://127.0.0.1:48273', 'ses_1'), fetchImpl);
        await expect(history.getNativeUserMessageCount()).resolves.toBeNull();
    });
});

describe('OpencodeConversationHistory fork', () => {
    it('forks the current session with an empty body and returns the native id', async () => {
        const fetchImpl: FetchLike = vi.fn(async (url: string, init?: RequestInit) => {
            if (init?.method === 'GET') return jsonResponse([]);
            expect(url).toBe('http://127.0.0.1:48273/session/ses_1/fork');
            expect(init?.method).toBe('POST');
            expect(JSON.parse(init?.body as string)).toEqual({});
            return jsonResponse({ id: 'ses_forked' });
        });

        const history = new OpencodeConversationHistory(createContext('http://127.0.0.1:48273', 'ses_1'), fetchImpl);
        const result = await history.fork();

        expect(result).toEqual({ nativeSessionId: 'ses_forked' });
        expect(history.getCapabilitiesForMetadata()?.conversationHistory?.forkCurrent).toBe(true);
    });

    it('marks forkCurrent unsupported when the current fork request fails', async () => {
        const fetchImpl: FetchLike = vi.fn(async () => new Response('nope', { status: 404 }));

        const history = new OpencodeConversationHistory(createContext('http://127.0.0.1:48273', 'ses_1'), fetchImpl);
        await expect(history.fork()).rejects.toThrow();
        expect(history.getCapabilitiesForMetadata()?.conversationHistory).toBeUndefined();
    });

    it('selects the right user message by prompt index and forks at that message', async () => {
        const messages = [
            { info: { id: 'msg_u0', role: 'user' }, parts: [{ type: 'text', text: 'first' }] },
            { info: { id: 'msg_a0', role: 'assistant' }, parts: [] },
            { info: { id: 'msg_u1', role: 'user' }, parts: [{ type: 'text', text: 'second' }] },
            { info: { id: 'msg_a1', role: 'assistant' }, parts: [] },
            { info: { id: 'msg_u2', role: 'user' }, parts: [{ type: 'text', text: 'third' }] }
        ];
        let forkBody: unknown;
        const fetchImpl: FetchLike = vi.fn(async (url: string, init?: RequestInit) => {
            if (init?.method === 'GET') {
                expect(url).toBe('http://127.0.0.1:48273/session/ses_1/message');
                return jsonResponse(messages);
            }
            forkBody = JSON.parse(init?.body as string);
            expect(url).toBe('http://127.0.0.1:48273/session/ses_1/fork');
            return jsonResponse({ id: 'ses_forked_at' });
        });

        const history = new OpencodeConversationHistory(createContext('http://127.0.0.1:48273', 'ses_1'), fetchImpl);
        await history.reconcileHistory(undefined, { allowUnobservedAppend: true });
        history.rememberPromptIndex('local-second', 1);

        const result = await history.fork('local-second');

        expect(forkBody).toEqual({ messageID: 'msg_u1' });
        expect(result).toEqual({ nativeSessionId: 'ses_forked_at' });
        const capabilities = history.getCapabilitiesForMetadata()?.conversationHistory;
        expect(capabilities?.forkCurrent).toBe(true);
        expect(capabilities?.forkAtMessage).toBe(true);
    });

    it('throws for a localId with no remembered prompt index', async () => {
        const fetchImpl: FetchLike = vi.fn();
        const history = new OpencodeConversationHistory(createContext('http://127.0.0.1:48273', 'ses_1'), fetchImpl);

        await expect(history.fork('local-unknown')).rejects.toThrow('No native history point for message local-unknown');
        expect(fetchImpl).not.toHaveBeenCalled();
    });

    it('throws when historical fork is unsupported', async () => {
        const fetchImpl: FetchLike = vi.fn(async () => jsonResponse({ paths: {} }));
        const history = new OpencodeConversationHistory(createContext('http://127.0.0.1:48273', 'ses_1'), fetchImpl);
        await history.probeCapabilities();
        history.rememberPromptIndex('local-a', 0);

        await expect(history.fork('local-a')).rejects.toThrow('Historical fork is not supported');
    });
});

describe('OpencodeConversationHistory guards', () => {
    it.each([undefined, 'local-second'])('rejects current and historical forks after native identity replacement (%s)', async (localId) => {
        const fetchImpl = vi.fn(async (_url: string, _init?: RequestInit) => jsonResponse([
            { info: { id: 'msg_first', role: 'user' } },
            { info: { id: 'msg_new_assistant', role: 'assistant' } },
            { info: { id: 'msg_second', role: 'user' } }
        ]));
        const history = new OpencodeConversationHistory(createContext('http://127.0.0.1:48273', 'ses_1'), fetchImpl);
        history.restorePromptIndexes({ 'local-second': 1 });
        history.restoreCheckpoint({ sessionId: 'ses_1', messageIds: ['msg_first', 'msg_old_assistant', 'msg_second'],
            userMessageIds: ['msg_first', 'msg_second'], localMessageIds: [] });
        await expect(history.fork(localId)).rejects.toThrow('diverged');
        expect(history.isDiverged()).toBe(true);
        expect(history.getHistoryPoints()).toEqual({});
        expect(fetchImpl.mock.calls.every(([, init]) => init?.method === 'GET')).toBe(true);
    });

    it('reconciles expected remote prompt growth including automatic compaction', async () => {
        const history = new OpencodeConversationHistory(createContext('http://127.0.0.1:48273', 'ses_1'),
            async () => jsonResponse([
                { info: { id: 'msg_first', role: 'user' } }, { info: { id: 'msg_answer', role: 'assistant' } },
                { info: { id: 'msg_marker', role: 'user' } }, { info: { id: 'msg_continue', role: 'user' } }
            ]));
        history.restorePromptIndexes({ 'local-first': 0 });
        history.restoreCheckpoint({ sessionId: 'ses_1', messageIds: ['msg_first', 'msg_answer'], userMessageIds: ['msg_first'], localMessageIds: [] });
        await expect(history.reconcileHistory(undefined, { allowUnobservedAppend: true })).resolves.toBe(3);
        expect(history.isDiverged()).toBe(false);
        expect(history.getHistoryPoints()).toEqual({ 'local-first': true });
        expect(history.getCheckpoint()?.messageIds).toEqual(['msg_first', 'msg_answer', 'msg_marker', 'msg_continue']);
    });

    it('does not trust legacy numeric locators without an identity checkpoint', async () => {
        const history = new OpencodeConversationHistory(createContext('http://127.0.0.1:48273', 'ses_1'),
            async () => jsonResponse([{ info: { id: 'msg_unknown', role: 'user' } }]));
        history.restorePromptIndexes({ 'local-old': 0 });
        await expect(history.reconcileHistory()).rejects.toThrow('diverged');
        expect(history.isDiverged()).toBe(true);
    });

    it.each([200, 404, 405])('never republishes capabilities from a late %i fork response after teardown', async (status) => {
        let complete!: (response: Response) => void;
        const fetchImpl: FetchLike = vi.fn(async (_url, init) => init?.method === 'GET'
            ? jsonResponse([]) : await new Promise<Response>((resolve) => { complete = resolve; }));
        const history = new OpencodeConversationHistory(createContext('http://127.0.0.1:48273', 'ses_1'), fetchImpl);
        const publish = vi.fn(async () => {});
        history.setPublishCapabilities(publish);
        const pending = history.fork();
        await vi.waitFor(() => expect(complete).toBeTypeOf('function'));
        await history.disableFork();
        complete(jsonResponse({ id: 'ses_late' }, status));
        await expect(pending).rejects.toThrow(status === 200 ? 'teardown' : `(${status})`);
        expect(history.getCapabilitiesForMetadata()?.conversationHistory).toBeUndefined();
        expect(publish).toHaveBeenCalledTimes(1);
    });

    it('does not issue a historical POST when teardown occurs during message lookup', async () => {
        let complete!: (response: Response) => void;
        const fetchImpl = vi.fn((_url: string, _init?: RequestInit) => new Promise<Response>((resolve) => { complete = resolve; }));
        const history = new OpencodeConversationHistory(createContext('http://127.0.0.1:48273', 'ses_1'), fetchImpl);
        history.rememberPromptIndex('local-one', 0);
        const pending = history.fork('local-one');
        await history.disableFork();
        complete(jsonResponse([{ info: { id: 'msg_one', role: 'user' } }]));
        await expect(pending).rejects.toThrow('teardown');
        expect(fetchImpl).toHaveBeenCalledTimes(1);
    });

    it('rejects fork while busy', async () => {
        const fetchImpl: FetchLike = vi.fn();
        const history = new OpencodeConversationHistory(createContext('http://127.0.0.1:48273', 'ses_1'), fetchImpl);
        history.setBusy(true);

        await expect(history.fork()).rejects.toThrow('Session is busy');
        expect(fetchImpl).not.toHaveBeenCalled();
    });

    it('rejects fork without context', async () => {
        const fetchImpl: FetchLike = vi.fn();
        const history = new OpencodeConversationHistory(createContext(null, null), fetchImpl);

        await expect(history.fork()).rejects.toThrow('OpenCode session is not ready');
    });

    it('restores prompt indexes from durable metadata and exposes them', async () => {
        const history = new OpencodeConversationHistory(createContext('http://127.0.0.1:48273', 'ses_1'), vi.fn());
        history.restorePromptIndexes({ 'local-restored': 4 });
        expect(history.getHistoryIndexes()).toEqual({ 'local-restored': 4 });
        expect(history.getHistoryPoints()).toEqual({ 'local-restored': true });
    });
});
