import { describe, expect, it, vi } from 'vitest';
import { logger } from '@/ui/logger';
import { OPENCODE_PROVIDER_TEXT_MAX_LENGTH, truncateOpencodeProviderText } from './opencodeErrorText';
import {
    formatOpencodeRetryStatus,
    subscribeToOpencodeEvents
} from './opencodeEventStream';

vi.mock('@/ui/logger', () => ({
    logger: { debug: vi.fn(), warn: vi.fn(), info: vi.fn() }
}));

const NOW = 1_786_154_400_000;
const SESSION_CWD = '/home/user/projects/thing';
const EXPECTED_URL = `http://127.0.0.1:48273/event?directory=${encodeURIComponent(SESSION_CWD)}`;

function createSseStream() {
    let controller: ReadableStreamDefaultController<Uint8Array> | null = null;
    const stream = new ReadableStream<Uint8Array>({
        start(c) {
            controller = c;
        }
    });
    const encoder = new TextEncoder();
    // Writes are tolerated after the stream is gone: closing the
    // subscription cancels its reader, which closes this controller. A
    // caller writing into that is exactly the "frame arrives after close"
    // case, and it must not blow up the test.
    const write = (text: string) => {
        try {
            controller?.enqueue(encoder.encode(text));
        } catch {
            // Stream already closed.
        }
    };
    return {
        stream,
        /** Writes one SSE frame, the framing opencode's /event endpoint uses. */
        push(event: unknown) {
            write(`data: ${JSON.stringify(event)}\n\n`);
        },
        pushRaw(text: string) {
            write(text);
        },
        close() {
            try {
                controller?.close();
            } catch {
                // Already closed — cancelling the reader closes it too.
            }
        }
    };
}

function retryEvent(attempt: number, sessionId = 'ses_ours') {
    return {
        id: `evt_${attempt}`,
        type: 'session.status',
        properties: {
            sessionID: sessionId,
            status: {
                type: 'retry',
                attempt,
                message: 'Rate limit exceeded: free-models-per-day.',
                next: NOW + 30_000
            }
        }
    };
}

function statusEvent(type: 'busy' | 'idle', sessionId = 'ses_ours') {
    return {
        id: `evt_${type}`,
        type: 'session.status',
        properties: { sessionID: sessionId, status: { type } }
    };
}

function subscribe(options: {
    fetchImpl: (url: string, init?: RequestInit) => Promise<Response>;
    onRetry?: (retry: { attempt: number; message: string }) => void;
    /** Records the backoff schedule instead of waiting it out. */
    delays?: number[];
    /**
     * Closes the subscription once this many delays are recorded. Reconnects
     * are unbounded by design, so a test that stubs the wait to nothing must
     * stop the loop itself.
     */
    stopAfterDelays?: number;
}) {
    let subscription: { close: () => void } | null = null;
    subscription = subscribeToOpencodeEvents({
        baseUrl: 'http://127.0.0.1:48273',
        directory: SESSION_CWD,
        sessionId: 'ses_ours',
        onRetry: options.onRetry ?? (() => {}),
        fetchImpl: options.fetchImpl,
        sleep: async (ms: number) => {
            options.delays?.push(ms);
            if (options.stopAfterDelays && (options.delays?.length ?? 0) >= options.stopAfterDelays) {
                subscription?.close();
            }
            // Yield a real macrotask so assertions can run between attempts.
            await new Promise((resolve) => setTimeout(resolve, 0));
        }
    });
    return subscription;
}

describe('formatOpencodeRetryStatus', () => {
    it('states the provider message and the attempt number', () => {
        const text = formatOpencodeRetryStatus({
            attempt: 2,
            message: 'Rate limit exceeded: free-models-per-day.'
        });

        expect(text).toBe('Rate limit exceeded: free-models-per-day. (attempt 2)');
    });

    it('does not render a countdown, which would outlive the turn it describes', () => {
        // This becomes a timeline block. Anything time-relative here would
        // still be claiming a retry is due while sitting above a reply that
        // arrived minutes ago.
        const text = formatOpencodeRetryStatus({
            attempt: 4,
            message: 'Overloaded.'
        });

        expect(text).toBe('Overloaded. (attempt 4)');
        expect(text).not.toMatch(/retry|retrying in|\ds\b|shortly/i);
    });

    it('stays on one line and within the provider-text budget', () => {
        // It renders into a plain span with no `whitespace-pre-line`, and
        // the cap this session promises for provider text is a per-message
        // promise, not a per-field one.
        const text = formatOpencodeRetryStatus({
            attempt: 7,
            message: truncateOpencodeProviderText('m'.repeat(20_210))
        });

        expect(text).not.toContain('\n');
        expect(text.length).toBeLessThanOrEqual(OPENCODE_PROVIDER_TEXT_MAX_LENGTH + ' (attempt 7)'.length);
    });
});


describe('subscribeToOpencodeEvents', () => {
    it('scopes the subscription to the session directory, without which it would receive nothing', async () => {
        // Measured: the unscoped stream delivers heartbeats and nothing
        // else — no error, no 404, just a subscription that never reports.
        const sse = createSseStream();
        const fetchImpl = vi.fn(async (_url: string, _init?: RequestInit) => new Response(sse.stream, { status: 200 }));
        const subscription = subscribe({ fetchImpl });

        await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(1));
        expect(fetchImpl.mock.calls[0][0]).toBe(EXPECTED_URL);

        subscription.close();
        sse.close();
    });

    it('reports every new retry attempt once, ignoring repeats of the same attempt', async () => {
        const sse = createSseStream();
        const fetchImpl = vi.fn(async (_url: string, _init?: RequestInit) => new Response(sse.stream, { status: 200 }));
        const retries: number[] = [];
        const subscription = subscribe({ fetchImpl, onRetry: (retry) => retries.push(retry.attempt) });

        await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(1));

        sse.push(retryEvent(1));
        sse.push(retryEvent(1));
        sse.push(retryEvent(2));
        sse.push(retryEvent(3));

        await vi.waitFor(() => expect(retries).toHaveLength(3));
        expect(retries).toEqual([1, 2, 3]);

        subscription.close();
        sse.close();
    });

    it('reports a request that restarts its attempt count inside the same turn', async () => {
        // A turn is not one provider request: every tool-call round trip
        // starts a fresh completion whose attempt counter begins at 1
        // again, with no idle/busy in between. Suppressing anything at or
        // below the highest attempt seen would freeze the timeline on the
        // first request's last number while the agent kept retrying — the
        // exact silence this feature removes. A falling attempt number is
        // news, not a duplicate.
        const sse = createSseStream();
        const fetchImpl = vi.fn(async (_url: string, _init?: RequestInit) => new Response(sse.stream, { status: 200 }));
        const retries: number[] = [];
        const subscription = subscribe({ fetchImpl, onRetry: (retry) => retries.push(retry.attempt) });
        await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(1));

        sse.push(retryEvent(1));
        sse.push(retryEvent(2));
        sse.push(retryEvent(1));

        await vi.waitFor(() => expect(retries).toEqual([1, 2, 1]));

        subscription.close();
        sse.close();
    });

    it('thins a long run of retries instead of writing one row a minute forever', async () => {
        // Each report is persisted by the hub and rebroadcast to every
        // client; folding happens only when one of them renders.
        const sse = createSseStream();
        const fetchImpl = vi.fn(async (_url: string, _init?: RequestInit) => new Response(sse.stream, { status: 200 }));
        const retries: number[] = [];
        const subscription = subscribe({ fetchImpl, onRetry: (retry) => retries.push(retry.attempt) });
        await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(1));

        for (let attempt = 1; attempt <= 20; attempt += 1) {
            sse.push(retryEvent(attempt));
        }

        await vi.waitFor(() => expect(retries).toEqual([1, 2, 3, 4, 8, 16]));

        subscription.close();
        sse.close();
    });

    it('drops an attempt number that is not a counting number', async () => {
        // Infinity comes from JSON.parse on an overflowing literal; the
        // rest satisfy the dense-reporting branch and would be rendered
        // verbatim, and 0 collides with the turn-boundary sentinel.
        const sse = createSseStream();
        const fetchImpl = vi.fn(async (_url: string, _init?: RequestInit) => new Response(sse.stream, { status: 200 }));
        const retries: number[] = [];
        const subscription = subscribe({ fetchImpl, onRetry: (retry) => retries.push(retry.attempt) });
        await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(1));

        sse.pushRaw(
            'data: {"type":"session.status","properties":{"sessionID":"ses_ours",'
            + '"status":{"type":"retry","attempt":1e999,"message":"Rate limit exceeded."}}}\n\n'
        );
        for (const attempt of [0, -1, 0.5, 2.5]) {
            sse.push({
                id: `evt_${attempt}`,
                type: 'session.status',
                properties: {
                    sessionID: 'ses_ours',
                    status: { type: 'retry', attempt, message: 'Rate limit exceeded.', next: NOW }
                }
            });
        }
        sse.push(retryEvent(1));

        await vi.waitFor(() => expect(retries).toEqual([1]));

        subscription.close();
        sse.close();
    });


    it('drops a message that only looks like text, and flattens one that is not a single line', async () => {
        const sse = createSseStream();
        const fetchImpl = vi.fn(async (_url: string, _init?: RequestInit) => new Response(sse.stream, { status: 200 }));
        const messages: string[] = [];
        const subscription = subscribe({ fetchImpl, onRetry: (retry) => messages.push(retry.message) });
        await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(1));

        // Whitespace only: truthy, but nothing a user could read.
        sse.push({
            id: 'evt_blank',
            type: 'session.status',
            properties: { sessionID: 'ses_ours', status: { type: 'retry', attempt: 1, message: '  \n  ', next: NOW } }
        });
        sse.push({
            id: 'evt_multiline',
            type: 'session.status',
            properties: {
                sessionID: 'ses_ours',
                status: { type: 'retry', attempt: 2, message: 'Rate limit exceeded.\n\n  Try again later.', next: NOW }
            }
        });

        await vi.waitFor(() => expect(messages).toEqual(['Rate limit exceeded. Try again later.']));

        subscription.close();
        sse.close();
    });

    it('keeps reading when a consumer throws, and does not file that as a parse failure', async () => {
        const sse = createSseStream();
        const fetchImpl = vi.fn(async (_url: string, _init?: RequestInit) => new Response(sse.stream, { status: 200 }));
        const retries: number[] = [];
        const subscription = subscribe({
            fetchImpl,
            onRetry: (retry) => {
                retries.push(retry.attempt);
                if (retry.attempt === 1) throw new Error('hub client exploded');
            }
        });
        await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(1));

        sse.push(retryEvent(1));
        sse.push(retryEvent(2));

        await vi.waitFor(() => expect(retries).toEqual([1, 2]));

        subscription.close();
        sse.close();
    });

    it('stops dispatching the rest of a chunk once closed mid-frame', async () => {
        // One read can carry several frames, and close() lands synchronously
        // from the launcher's cleanup — so re-checking only once per chunk
        // would drain the remainder into a session that is already gone.
        const sse = createSseStream();
        const fetchImpl = vi.fn(async (_url: string, _init?: RequestInit) => new Response(sse.stream, { status: 200 }));
        const retries: number[] = [];
        let subscription: { close: () => void } | null = null;
        subscription = subscribeToOpencodeEvents({
            baseUrl: 'http://127.0.0.1:48273',
            directory: SESSION_CWD,
            sessionId: 'ses_ours',
            fetchImpl,
            sleep: async () => {},
            onRetry: (retry) => {
                retries.push(retry.attempt);
                subscription?.close();
            }
        });

        await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(1));

        // Two frames arriving as one chunk; handling the first closes it.
        sse.pushRaw(`data: ${JSON.stringify(retryEvent(1))}\n\ndata: ${JSON.stringify(retryEvent(2))}\n\n`);

        await new Promise((resolve) => setTimeout(resolve, 20));
        expect(retries).toEqual([1]);

        sse.close();
    });

    it('warns once when no connection attempt ever produces a usable stream', async () => {
        // Every other failure here is debug-level, but a subscription that
        // never works is indistinguishable from a session that simply never
        // retried — and silence is the bug this exists to remove.
        vi.mocked(logger.warn).mockClear();
        const fetchImpl = vi.fn(async (_url: string, _init?: RequestInit): Promise<Response> => {
            throw new Error('connection refused');
        });
        const delays: number[] = [];
        const subscription = subscribe({ fetchImpl, delays, stopAfterDelays: 9 });

        await vi.waitFor(() => expect(delays.length).toBeGreaterThanOrEqual(8));
        expect(vi.mocked(logger.warn)).toHaveBeenCalledTimes(1);
        expect(vi.mocked(logger.warn).mock.calls[0][0]).toContain('will not be reported');

        subscription.close();
    });

    it('warns again about a later outage after a connection that worked', async () => {
        // "Once" means once per outage. A session that stumbles at startup
        // and then loses the subprocess hours later must still report the
        // second failure, which is the one that actually costs the user
        // their retry reports.
        vi.mocked(logger.warn).mockClear();
        const healthy = createSseStream();
        let call = 0;
        const fetchImpl = vi.fn(async (_url: string, _init?: RequestInit): Promise<Response> => {
            call += 1;
            if (call === 6) return new Response(healthy.stream, { status: 200 });
            throw new Error('connection refused');
        });
        const delays: number[] = [];
        const subscription = subscribe({ fetchImpl, delays, stopAfterDelays: 30 });

        await vi.waitFor(() => expect(vi.mocked(logger.warn)).toHaveBeenCalledTimes(1));

        // The sixth attempt delivers a frame and then ends, which is what
        // clears both the counter and the warning latch.
        healthy.push(retryEvent(1));
        healthy.close();

        await vi.waitFor(() => expect(vi.mocked(logger.warn)).toHaveBeenCalledTimes(2));

        subscription.close();
    });

    it('treats the next turn as new information after the session goes idle and busy again', async () => {
        const sse = createSseStream();
        const fetchImpl = vi.fn(async (_url: string, _init?: RequestInit) => new Response(sse.stream, { status: 200 }));
        const retries: number[] = [];
        const subscription = subscribe({ fetchImpl, onRetry: (retry) => retries.push(retry.attempt) });
        await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(1));

        sse.push(retryEvent(1));
        await vi.waitFor(() => expect(retries).toHaveLength(1));

        // Turn boundary. Measured: both are published twice within the same
        // millisecond, so the reset must be idempotent.
        sse.push(statusEvent('idle'));
        sse.push(statusEvent('idle'));
        sse.push(statusEvent('busy'));
        sse.push(statusEvent('busy'));
        sse.push(retryEvent(1));

        await vi.waitFor(() => expect(retries).toHaveLength(2));
        expect(retries).toEqual([1, 1]);

        subscription.close();
        sse.close();
    });

    it('ignores status events belonging to another session', async () => {
        const sse = createSseStream();
        const fetchImpl = vi.fn(async (_url: string, _init?: RequestInit) => new Response(sse.stream, { status: 200 }));
        const retries: number[] = [];
        const subscription = subscribe({ fetchImpl, onRetry: (retry) => retries.push(retry.attempt) });
        await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(1));

        sse.push(retryEvent(1, 'ses_someone_else'));
        // Nor may another session's turn boundary clear our dedupe state.
        sse.push(statusEvent('idle', 'ses_someone_else'));
        // A frame for our own session proves the stream was being read at all.
        sse.push(retryEvent(2));
        sse.push(retryEvent(2));

        await vi.waitFor(() => expect(retries).toHaveLength(1));
        expect(retries).toEqual([2]);

        subscription.close();
        sse.close();
    });

    it('ignores a status event that cannot be attributed to any session', async () => {
        const sse = createSseStream();
        const fetchImpl = vi.fn(async (_url: string, _init?: RequestInit) => new Response(sse.stream, { status: 200 }));
        const retries: number[] = [];
        const subscription = subscribe({ fetchImpl, onRetry: (retry) => retries.push(retry.attempt) });
        await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(1));

        sse.push({
            id: 'evt_orphan',
            type: 'session.status',
            properties: { status: { type: 'retry', attempt: 9, message: 'nope', next: NOW + 1_000 } }
        });
        sse.push(retryEvent(1));

        await vi.waitFor(() => expect(retries).toEqual([1]));

        subscription.close();
        sse.close();
    });

    it('never reads session.error, which carries the provider credentials verbatim', async () => {
        // Measured against a stub that answered with Authorization,
        // Set-Cookie and a 4KB body: this payload reproduces all of it. The
        // same failure reaches the user through the ACP prompt error, which
        // carries only the message.
        const sse = createSseStream();
        const fetchImpl = vi.fn(async (_url: string, _init?: RequestInit) => new Response(sse.stream, { status: 200 }));
        const retries: unknown[] = [];
        const subscription = subscribe({ fetchImpl, onRetry: (retry) => retries.push(retry) });
        await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(1));

        sse.push({
            id: 'evt_err',
            type: 'session.error',
            properties: {
                sessionID: 'ses_ours',
                error: {
                    name: 'APIError',
                    data: {
                        message: 'Unauthorized',
                        responseHeaders: {
                            authorization: 'Bearer sk-live-do-not-relay',
                            'set-cookie': 'session=do-not-relay'
                        },
                        responseBody: 'do-not-relay'
                    }
                }
            }
        });
        // Reaching a later frame proves the stream kept being read.
        sse.push(retryEvent(1));

        await vi.waitFor(() => expect(retries).toHaveLength(1));
        expect(JSON.stringify(retries)).not.toContain('do-not-relay');

        subscription.close();
        sse.close();
    });

    it('caps a retry message no provider bounds', async () => {
        const sse = createSseStream();
        const fetchImpl = vi.fn(async (_url: string, _init?: RequestInit) => new Response(sse.stream, { status: 200 }));
        const messages: string[] = [];
        const subscription = subscribe({ fetchImpl, onRetry: (retry) => messages.push(retry.message) });
        await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(1));

        sse.push({
            id: 'evt_long',
            type: 'session.status',
            properties: {
                sessionID: 'ses_ours',
                status: { type: 'retry', attempt: 1, message: 'w'.repeat(20_210), next: NOW }
            }
        });

        await vi.waitFor(() => expect(messages).toHaveLength(1));
        expect(messages[0]).toHaveLength(OPENCODE_PROVIDER_TEXT_MAX_LENGTH);
        expect(messages[0].endsWith('…')).toBe(true);

        subscription.close();
        sse.close();
    });

    it('still reports a retry whose next-attempt timestamp is missing or malformed', async () => {
        // `next` is not rendered, so it must not gate anything. Dropping a
        // retry over a field nobody reads would hide exactly the report this
        // feature exists to deliver.
        const sse = createSseStream();
        const fetchImpl = vi.fn(async (_url: string, _init?: RequestInit) => new Response(sse.stream, { status: 200 }));
        const retries: number[] = [];
        const subscription = subscribe({ fetchImpl, onRetry: (retry) => retries.push(retry.attempt) });
        await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(1));

        const retryWithoutNext = (attempt: number, next?: unknown) => ({
            id: `evt_${attempt}`,
            type: 'session.status',
            properties: {
                sessionID: 'ses_ours',
                status: { type: 'retry', attempt, message: 'Rate limit exceeded.', ...(next === undefined ? {} : { next }) }
            }
        });

        sse.push(retryWithoutNext(1));
        sse.push(retryWithoutNext(2, 'not-a-timestamp'));
        sse.push(retryWithoutNext(3, null));

        await vi.waitFor(() => expect(retries).toEqual([1, 2, 3]));

        subscription.close();
        sse.close();
    });

    it('does not let an unreadable retry reset the duplicate suppression', async () => {
        // A retry whose message is empty cannot be rendered, but it is still
        // a retry — not a turn boundary. Treating it as one would clear the
        // dedupe state and let the agent's next repeat of the same attempt
        // through as if it were new.
        const sse = createSseStream();
        const fetchImpl = vi.fn(async (_url: string, _init?: RequestInit) => new Response(sse.stream, { status: 200 }));
        const retries: number[] = [];
        const subscription = subscribe({ fetchImpl, onRetry: (retry) => retries.push(retry.attempt) });
        await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(1));

        sse.push(retryEvent(1));
        await vi.waitFor(() => expect(retries).toEqual([1]));

        sse.push({
            id: 'evt_blank',
            type: 'session.status',
            properties: {
                sessionID: 'ses_ours',
                status: { type: 'retry', attempt: 1, message: '', next: NOW + 30_000 }
            }
        });
        // OpenCode repeats the same attempt while a backoff is pending.
        sse.push(retryEvent(1));
        sse.push(retryEvent(2));

        await vi.waitFor(() => expect(retries).toEqual([1, 2]));

        subscription.close();
        sse.close();
    });

    it('ignores heartbeats and unparsable frames without dropping the stream', async () => {
        const sse = createSseStream();
        const fetchImpl = vi.fn(async (_url: string, _init?: RequestInit) => new Response(sse.stream, { status: 200 }));
        const retries: number[] = [];
        const subscription = subscribe({ fetchImpl, onRetry: (retry) => retries.push(retry.attempt) });
        await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(1));

        sse.push({ id: 'evt_hb', type: 'server.heartbeat', properties: {} });
        sse.pushRaw('data: {not json\n\n');
        sse.pushRaw(': a comment line\n\n');
        sse.push(retryEvent(1));

        await vi.waitFor(() => expect(retries).toHaveLength(1));

        subscription.close();
        sse.close();
    });

    it('resubscribes when the stream ends', async () => {
        const streams = [createSseStream(), createSseStream()];
        let call = 0;
        const fetchImpl = vi.fn(async (_url: string, _init?: RequestInit) => new Response(streams[call++]?.stream ?? null, { status: 200 }));
        const retries: number[] = [];
        const subscription = subscribe({ fetchImpl, onRetry: (retry) => retries.push(retry.attempt) });

        await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(1));
        streams[0].close();

        await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(2));
        streams[1].push(retryEvent(1));
        await vi.waitFor(() => expect(retries).toHaveLength(1));

        subscription.close();
        streams[1].close();
    });

    it('stops for good on a build whose HTTP API has no /event endpoint', async () => {
        const fetchImpl = vi.fn(async (_url: string, _init?: RequestInit) => new Response(null, { status: 404 }));
        const subscription = subscribe({ fetchImpl });

        await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(1));
        // A 404 is a permanent answer: retrying it would just fill the log.
        await new Promise((resolve) => setTimeout(resolve, 20));
        expect(fetchImpl).toHaveBeenCalledTimes(1);

        subscription.close();
    });

    it('backs off instead of spinning when the server accepts and closes the body immediately', async () => {
        // A 200 whose body ends without a single frame is not a working
        // stream, however clean the end looks. Counting it as success is
        // what would produce a silent twice-a-second reconnect loop.
        const fetchImpl = vi.fn(async (_url: string, _init?: RequestInit) => {
            const sse = createSseStream();
            sse.close();
            return new Response(sse.stream, { status: 200 });
        });
        const delays: number[] = [];
        const subscription = subscribe({ fetchImpl, delays, stopAfterDelays: 6 });

        await vi.waitFor(() => expect(delays.length).toBeGreaterThanOrEqual(4));
        expect(delays.slice(0, 4)).toEqual([500, 1_000, 2_000, 4_000]);

        subscription.close();
    });

    it('reconnects promptly after a stream that did deliver events', async () => {
        // The counter is about productivity, so a stream that worked and
        // then dropped starts again from the base delay rather than
        // inheriting an earlier backoff.
        const streams = [createSseStream(), createSseStream(), createSseStream()];
        let call = 0;
        const fetchImpl = vi.fn(async (_url: string, _init?: RequestInit) => {
            const sse = streams[call++];
            if (!sse) return new Response(null, { status: 500 });
            if (call === 1) {
                // First attempt: no frames at all, so the next wait backs off.
                sse.close();
            }
            return new Response(sse.stream, { status: 200 });
        });
        const delays: number[] = [];
        const subscription = subscribe({ fetchImpl, delays, stopAfterDelays: 4 });

        await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(2));
        expect(delays).toEqual([500]);

        // Second attempt delivers a frame, then drops.
        const retries: number[] = [];
        streams[1].push(retryEvent(1));
        streams[1].close();

        await vi.waitFor(() => expect(delays.length).toBeGreaterThanOrEqual(2));
        // Back to the base delay rather than continuing on to 1000ms.
        expect(delays[1]).toBe(500);
        expect(retries).toEqual([]);

        subscription.close();
        streams[2].close();
    });

    it('keeps retrying a refused connection rather than giving up on the session', async () => {
        // Capped, never abandoned: a session can outlive a transient outage
        // by hours, and this is the only channel carrying retry reports.
        const fetchImpl = vi.fn(async (_url: string, _init?: RequestInit): Promise<Response> => {
            throw new Error('connection refused');
        });
        const delays: number[] = [];
        const subscription = subscribe({ fetchImpl, delays, stopAfterDelays: 10 });

        await vi.waitFor(() => expect(delays.length).toBeGreaterThanOrEqual(8));
        expect(delays.slice(0, 3)).toEqual([500, 1_000, 2_000]);
        expect(Math.max(...delays)).toBeLessThanOrEqual(30_000);

        subscription.close();
    });

    it('hands back the response body on the paths that will never read it', async () => {
        const cancel = vi.fn(async () => {});
        const makeBody = () => ({ cancel, getReader: () => { throw new Error('never read'); } });
        let call = 0;
        const fetchImpl = vi.fn(async (_url: string, _init?: RequestInit) => {
            call += 1;
            return {
                status: call === 1 ? 503 : 404,
                ok: false,
                body: makeBody()
            } as unknown as Response;
        });
        const delays: number[] = [];
        const subscription = subscribe({ fetchImpl, delays, stopAfterDelays: 5 });

        // 503 -> body released, backs off, retries. 404 -> body released and
        // the subscription stops for good.
        await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(2));
        await vi.waitFor(() => expect(cancel).toHaveBeenCalledTimes(2));
        await new Promise((resolve) => setTimeout(resolve, 20));
        expect(fetchImpl).toHaveBeenCalledTimes(2);

        subscription.close();
    });

    it('replays the last event id when reconnecting', async () => {
        const streams = [createSseStream(), createSseStream()];
        let call = 0;
        const fetchImpl = vi.fn(async (_url: string, _init?: RequestInit) => {
            const sse = streams[call++];
            return new Response(sse?.stream ?? null, { status: 200 });
        });
        const subscription = subscribe({ fetchImpl });

        await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(1));
        expect(fetchImpl.mock.calls[0][1]?.headers).not.toHaveProperty('last-event-id');

        streams[0].pushRaw(`id: evt_42\ndata: ${JSON.stringify(retryEvent(1))}\n\n`);
        await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(1));
        streams[0].close();

        await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(2));
        expect(fetchImpl.mock.calls[1][1]?.headers).toMatchObject({ 'last-event-id': 'evt_42' });

        subscription.close();
        streams[1].close();
    });

    it('stops reading once closed', async () => {
        const sse = createSseStream();
        const fetchImpl = vi.fn(async (_url: string, _init?: RequestInit) => new Response(sse.stream, { status: 200 }));
        const retries: number[] = [];
        const subscription = subscribe({ fetchImpl, onRetry: (retry) => retries.push(retry.attempt) });
        await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(1));

        subscription.close();
        subscription.close();
        sse.push(retryEvent(1));
        sse.close();

        await new Promise((resolve) => setTimeout(resolve, 20));
        expect(retries).toEqual([]);
        // Closing must not trigger another subscription attempt.
        expect(fetchImpl).toHaveBeenCalledTimes(1);
    });
});
