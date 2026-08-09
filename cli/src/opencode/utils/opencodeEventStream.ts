import { asNumber, asString, isObject } from '@hapi/protocol';
import { logger } from '@/ui/logger';
import type { FetchLike } from './opencodeCompactBridge';
import { collapseWhitespace, truncateOpencodeProviderText } from './opencodeErrorText';

/**
 * `session.status` with `type: "retry"` — OpenCode announcing that it hit an
 * upstream failure and will try again.
 *
 * The payload also carries `next` (the absolute timestamp of the following
 * attempt) and an optional `action` (a title/message/label/link hint).
 * Neither is modelled. `next` would only invite a countdown, which must not
 * be rendered — see formatOpencodeRetryStatus. `action` has never been
 * observed on a live retry, and rendering it meant concatenating four more
 * unbounded provider strings into one timeline line: past the length this
 * session promises for provider text, with a `link` that truncation turns
 * from a long URL into a wrong one presented as if it were clickable.
 */
export type OpencodeRetryStatus = {
    attempt: number;
    message: string;
};

export type OpencodeEventStreamOptions = {
    baseUrl: string;
    /**
     * The session's working directory. Required, not optional: the endpoint
     * scopes its events by it, and without it the stream is silently useless
     * (see subscribeToOpencodeEvents).
     */
    directory: string;
    /** Only events for this ACP session id (`ses_…`) are reported. */
    sessionId: string;
    /**
     * A retry announcement. Structured rather than pre-rendered because the
     * launcher reports retries as progress (an `api_error` system message the
     * web timeline folds), not as a failure — see its call site.
     */
    onRetry: (retry: OpencodeRetryStatus) => void;
    fetchImpl?: FetchLike;
    sleep?: (ms: number) => Promise<void>;
};

export type OpencodeEventSubscription = {
    /** Idempotent. Aborts the in-flight request and stops reconnecting. */
    close: () => void;
};

const RECONNECT_BASE_DELAY_MS = 500;
const RECONNECT_MAX_DELAY_MS = 30_000;

/** Every attempt up to this number is reported; past it, only powers of two are. */
const RETRY_REPORT_DENSE_THRESHOLD = 3;

/**
 * How many connection attempts may produce nothing before saying so out
 * loud once. Below this the endpoint is merely being restarted or is not up
 * yet, which is routine and belongs at debug level.
 */
const UNPRODUCTIVE_ATTEMPTS_BEFORE_WARNING = 5;

/**
 * Whether an attempt number is worth a row in the user's timeline.
 *
 * Each report becomes a message the hub persists to SQLite and rebroadcasts
 * over SSE to every connected client, and it is kept in session exports.
 * `foldApiErrorEvents` collapses a run of them when a client renders, but
 * that is a view concern — the rows, the traffic and the export are not
 * folded. OpenCode never gives up and its backoff tops out at 30 seconds,
 * so an unfiltered subscription writes about two rows a minute for as long
 * as the provider keeps refusing: the measured 40-minute stall alone would
 * have been 85 of them, and a session left overnight is four figures.
 *
 * Sampling on the attempt number rather than on elapsed time keeps this a
 * pure function of what the agent itself published — so it is decidable the
 * moment an event arrives, needs no clock, and is testable without fake
 * timers. A time-based sampler would also keep emitting rows through a long
 * backoff during which nothing new has happened.
 *
 * Early attempts are what a watching user actually reads, so the first few
 * come through unfiltered and the rest grow logarithmically: 1, 2, 3, 4, 8,
 * 16, 32 … Progress stays legible without the row count tracking wall time.
 */
function isReportableRetryAttempt(attempt: number): boolean {
    if (attempt <= RETRY_REPORT_DENSE_THRESHOLD) {
        return true;
    }
    // log2 rather than a bitwise trick: attempt is provider-supplied and
    // `x & (x - 1)` silently truncates anything past 32 bits.
    return Number.isInteger(Math.log2(attempt));
}

/**
 * Delay before the next connection attempt, keyed on how many attempts in a
 * row produced nothing at all.
 *
 * A connection only counts as productive if it actually delivered an SSE
 * frame — not merely if the server answered with headers. A server that
 * accepts the request and closes the body immediately would otherwise look
 * like a clean end of stream forever, reconnecting twice a second without
 * even logging it.
 *
 * There is no attempt ceiling on purpose. This is the only channel carrying
 * upstream retry reports, a reconnect costs a loopback request, and a
 * session can outlive a transient outage by hours — giving up for good
 * would silently leave the user back where this feature started. (Only a
 * 404 stops it, since that answer will not change.)
 */
function reconnectDelayMs(unproductiveAttempts: number): number {
    if (unproductiveAttempts <= 0) {
        return RECONNECT_BASE_DELAY_MS;
    }
    return Math.min(
        RECONNECT_BASE_DELAY_MS * 2 ** (unproductiveAttempts - 1),
        RECONNECT_MAX_DELAY_MS
    );
}

/**
 * Renders a retry announcement: what went wrong and which attempt this is.
 *
 * Deliberately no countdown, though the payload carries the next attempt's
 * timestamp. This becomes a timeline block that outlives the turn, so
 * "retrying in 30s" would still be sitting above a long-since successful
 * reply, asserting something that stopped being true a minute later.
 * Progress reads from the attempt number climbing instead, and because
 * consecutive retries fold into one block the user sees a single line whose
 * count goes up — then simply stops when the agent gets through, with the
 * assistant's reply as the recovery signal.
 *
 * No agent-name prefix either: this renders inside that agent's own session
 * timeline, where saying so again is noise. One line, no newlines: this is
 * rendered into a plain span with no `whitespace-pre-line`, so a line break
 * here would collapse into a space anyway.
 */
export function formatOpencodeRetryStatus(status: OpencodeRetryStatus): string {
    return `${status.message} (attempt ${status.attempt})`;
}

/**
 * Reads one `session.status` retry payload.
 *
 * Every string here is provider-authored and unbounded, exactly like the
 * `session/prompt` error message, so it is capped at the parse boundary —
 * the one place this text enters — rather than at each place it is
 * rendered. See OPENCODE_PROVIDER_TEXT_MAX_LENGTH for the measurement
 * behind that.
 */
function parseRetryStatus(status: unknown): OpencodeRetryStatus | null {
    if (!isObject(status) || status.type !== 'retry') return null;
    // A counting number or nothing. `typeof === 'number'` would let
    // JSON.parse's Infinity (from an overflowing literal) through, and
    // asNumber alone still admits 0, -1 and 0.5 — all of which satisfy the
    // dense-reporting branch below and would be rendered verbatim as
    // "(attempt 0.5)". Zero is worse than cosmetic: it is the same value
    // the turn-boundary reset uses as its sentinel, so accepting it merges
    // "saw a retry" with "this turn has had none".
    const attempt = asNumber(status.attempt);
    // Collapsed before it is judged, not after: a provider message of "  \n  "
    // is truthy but says nothing, and embedded newlines would survive into a
    // status line this module promises to keep to one line. Truncating alone
    // does neither.
    const message = collapseWhitespace(asString(status.message) ?? '');
    // Only what is actually rendered is required: dropping a retry because a
    // field we never show is missing or malformed would hide the very report
    // this exists to deliver.
    if (attempt === null || !Number.isInteger(attempt) || attempt < 1 || !message) return null;

    return { attempt, message: truncateOpencodeProviderText(message) };
}

/**
 * Subscribes to an `opencode acp` subprocess's server event stream
 * (`GET {baseUrl}/event`, Server-Sent Events) and reports this session's
 * upstream retries.
 *
 * This exists because that is the *only* channel that carries them.
 * Measured against opencode 1.18.15 with a provider stubbed to always answer
 * 429: over 40 minutes and 85 retries the ACP channel produced zero
 * `session/update` notifications and zero stderr output while
 * `session/prompt` stayed pending, yet this stream emitted a
 * `session.status` retry event — carrying the provider's own message and
 * attempt number — throughout. Without it the user sees a session that
 * appears to be thinking and never learns that it is rate limited.
 *
 * **The `directory` query parameter is not optional.** Subscribing to the
 * same server with and without it from one process and comparing: the
 * unscoped stream delivered `server.connected` and `server.heartbeat` and
 * nothing else for 100 seconds, while the scoped one delivered every
 * `session.status`. Omitting it produces no error and no 404 — just a
 * subscription that reports nothing, forever.
 *
 * The stream's `session.error` event is deliberately **not** read. It looks
 * like the richer report and is the opposite: probed with a stub that
 * answered with `Authorization: Bearer …`, `Set-Cookie: …`, an
 * `x-request-id` and a 4KB body, that payload carried all of it verbatim in
 * `responseHeaders` and `responseBody`. Relaying it would write the user's
 * provider credentials into their session timeline and the hub's message
 * database, permanently. The same failure arrives on the ACP channel already
 * stripped to a message, which is what the launcher's prompt catch reports.
 *
 * Strictly supplementary: every failure path here is a debug log and a
 * degraded-but-working session. A build whose HTTP API predates `/event`
 * answers 404, which stops the subscription for good rather than retrying.
 *
 * Read as `fetch` + a hand-rolled frame reader rather than through the
 * `EventSource` the runtime provides, because the endpoint is unauthenticated
 * loopback but the tests are not: injecting `fetchImpl` and `sleep` is what
 * lets the reconnect schedule and every failure branch be asserted
 * deterministically, without a live server or fake timers. Everything
 * `EventSource` would have handled — frame framing, reconnect backoff,
 * `Last-Event-ID` replay — is implemented here and covered by those tests.
 *
 * **Known limitation: delegated turns are not covered.** An OpenCode
 * task/subagent runs in its own child `ses_…`, and its retries carry that
 * child's id, so the exact-match filter here drops them while the parent
 * session simply stays `busy`. A rate limit hit inside a delegated turn is
 * therefore still silent, and that silence is indistinguishable from the
 * bug this subscription exists to fix. Deliberately not addressed here:
 * following child sessions means tracking their lifetimes and deciding
 * whose timeline they belong in, which is a larger change than this one.
 */
export function subscribeToOpencodeEvents(options: OpencodeEventStreamOptions): OpencodeEventSubscription {
    const {
        baseUrl,
        directory,
        sessionId,
        onRetry,
        fetchImpl = fetch as FetchLike,
        sleep = (ms: number) => new Promise<void>((resolve) => {
            const timer = setTimeout(resolve, ms);
            timer.unref?.();
        })
    } = options;

    const url = `${baseUrl}/event?directory=${encodeURIComponent(directory)}`;
    const controller = new AbortController();
    let closed = false;
    // Structurally typed to just what close() needs: the global and
    // node:stream/web ReadableStreamDefaultReader types are not assignable
    // to each other under this tsconfig.
    let activeReader: { cancel: () => Promise<void> } | null = null;
    // The attempt number of the last retry seen, not of the last one
    // reported: this exists purely to drop the republished copies OpenCode
    // emits while a backoff is pending, and `isReportableRetryAttempt`
    // separately decides which of the distinct ones are worth a row.
    // Reset at a turn boundary so the next turn's attempt 1 is new again.
    //
    // The attempt number alone is the whole key, deliberately. Widening it
    // with `next` would catch the one case this drops — a turn whose
    // requests each retry exactly once, arriving as 1, 1, 1 — but the user
    // sees no difference either way: `foldApiErrorEvents` collapses a run
    // of consecutive api_error blocks into a single line showing the latest
    // attempt, so publishing attempt 1 three times renders exactly as
    // publishing it once. Reading `next` to buy nothing would also undo the
    // decision not to model it at all (see OpencodeRetryStatus): once it is
    // in hand, rendering a countdown from it is one line away.
    let lastSeenAttempt = 0;
    // Whether this subscription has ever been handed a status it could
    // attribute to this session. See its one use: proving the subscription
    // is actually live is otherwise impossible to distinguish from a
    // healthy session that simply never retried.
    let sawAttributedStatus = false;
    // Last SSE `id:` seen, replayed as `last-event-id` on reconnect. Harmless
    // if the server does not support resuming; if it does, it closes the gap
    // where a retry announcement lands while we are reconnecting.
    let lastEventId: string | null = null;
    // Frames delivered by the connection currently being read. A connection
    // that delivers nothing is not a healthy stream, however cleanly it ends.
    let framesThisConnection = 0;

    const handleEvent = (event: unknown): void => {
        if (!isObject(event)) return;
        if (event.type !== 'session.status') return;
        const properties = isObject(event.properties) ? event.properties : null;
        if (!properties) return;
        // Status is per-session bookkeeping and drives the dedupe state
        // below, so an event that cannot be attributed must not touch it.
        if (asString(properties.sessionID) !== sessionId) return;

        if (!sawAttributedStatus) {
            sawAttributedStatus = true;
            // The one positive confirmation that this subscription is wired
            // to the right session and directory. Without it, a wrong
            // baseUrl and a session that simply never retried look
            // identical in the logs — and this whole feature exists
            // because silence was the bug.
            logger.debug('[opencode-events] receiving status for this session; retry reporting is live');
        }

        const isRetry = isObject(properties.status) && properties.status.type === 'retry';
        if (!isRetry) {
            // idle or busy: a turn boundary. Deliberately not surfaced —
            // turn state already has its own channel, and the hub layers
            // its own queue rules on top of what this session reports —
            // but it does mean the next turn's attempt 1 is new
            // information again. Both are honoured rather than just idle:
            // a reconnect that lands between the two would otherwise leave
            // the following turn's retries suppressed as duplicates.
            lastSeenAttempt = 0;
            return;
        }

        const retry = parseRetryStatus(properties.status);
        if (!retry) {
            // A retry we could not read (empty message, schema drift) is
            // still a retry: treating it as a turn boundary would reset
            // the dedupe state and let the agent's next repeat of the
            // same attempt through as if it were new.
            logger.debug('[opencode-events] ignoring unreadable retry status', properties.status);
            return;
        }

        // Equality, not a high-water mark. A turn is not one provider
        // request: every tool-call round trip starts a fresh completion,
        // and the attempt counter restarts at 1 with it. Suppressing
        // anything at or below the highest number seen would mean a turn
        // whose first request reached attempt 3 goes permanently quiet for
        // every request after it — the agent still retrying, the timeline
        // frozen on "attempt 3". So a *decreasing* attempt is not a
        // duplicate at all: it is the news that a new request has started
        // failing. Only an exact repeat is dropped, which is what OpenCode
        // republishes while a backoff is pending.
        if (retry.attempt === lastSeenAttempt) return;
        lastSeenAttempt = retry.attempt;

        if (!isReportableRetryAttempt(retry.attempt)) return;
        onRetry(retry);
    };

    /** Emits one complete SSE frame's `data:` payload, per the text/event-stream framing rules. */
    const handleFrame = (frame: string): void => {
        framesThisConnection += 1;
        const lines = frame.split(/\r?\n/);
        const id = lines.find((line) => line.startsWith('id:'));
        if (id) {
            lastEventId = id.slice('id:'.length).trim();
        }
        const data = lines
            .filter((line) => line.startsWith('data:'))
            .map((line) => line.slice('data:'.length).trim())
            .join('\n');
        if (!data) return;
        let payload: unknown;
        try {
            payload = JSON.parse(data);
        } catch (error) {
            logger.debug('[opencode-events] ignoring unparsable event payload', error);
            return;
        }
        // Dispatched outside the parse guard on purpose: everything
        // downstream of handleEvent is HAPI's own code (the launcher's
        // report, the hub client), and a throw from there is a bug in this
        // process — not provider noise. Sharing one catch labelled
        // "unparsable payload" would file it as the latter and lose it.
        try {
            handleEvent(payload);
        } catch (error) {
            logger.debug('[opencode-events] reporting a retry threw; continuing to read the stream', error);
        }
    };

    const consumeStream = async (body: ReadableStream<Uint8Array>): Promise<void> => {
        const reader = body.getReader();
        activeReader = reader;
        const decoder = new TextDecoder();
        let buffer = '';
        while (!closed) {
            const { done, value } = await reader.read();
            // Re-check after awaiting: close() can land while a read is
            // pending, and a frame that arrives with it belongs to a session
            // that is already gone.
            if (closed || done) return;
            buffer += decoder.decode(value, { stream: true });
            for (;;) {
                // Re-checked per frame, not merely per chunk: one read can
                // deliver several frames, and close() lands synchronously
                // from cleanup(). Without this the rest of a chunk would
                // still be dispatched after the session is gone.
                if (closed) return;
                const separator = /\r?\n\r?\n/.exec(buffer);
                if (!separator) break;
                const frame = buffer.slice(0, separator.index);
                buffer = buffer.slice(separator.index + separator[0].length);
                handleFrame(frame);
            }
        }
    };

    const run = async (): Promise<void> => {
        let unproductiveAttempts = 0;
        let warnedUnreachable = false;

        /**
         * Counts another connection attempt that delivered nothing, and
         * says so out loud once when they stop looking transient.
         *
         * Everything else in this module is debug-level on purpose, but a
         * subscription that never works is invisible by construction: a
         * wrong baseUrl, a firewalled port or an upstream that stopped
         * serving this endpoint all present as a session that simply never
         * retried. Since silence is the exact bug this feature exists to
         * remove, that one case gets a warning. Once per outage, not once
         * per attempt and not once per subscription: the flag clears again
         * on the next connection that actually delivers something, so a
         * session that stumbles at startup and then loses the subprocess
         * hours later still reports the second, more serious failure.
         */
        const noteUnproductiveAttempt = (): number => {
            unproductiveAttempts += 1;
            if (!warnedUnreachable && unproductiveAttempts >= UNPRODUCTIVE_ATTEMPTS_BEFORE_WARNING) {
                warnedUnreachable = true;
                logger.warn(
                    `[opencode-events] no usable event stream after ${unproductiveAttempts} attempts at ${url};`
                    + ' upstream retries and rate limits will not be reported for this session'
                );
            }
            return unproductiveAttempts;
        };

        while (!closed) {
            let response: Response;
            try {
                response = await fetchImpl(url, {
                    signal: controller.signal,
                    headers: {
                        accept: 'text/event-stream',
                        ...(lastEventId ? { 'last-event-id': lastEventId } : {})
                    }
                });
            } catch (error) {
                if (closed || controller.signal.aborted) return;
                const delay = reconnectDelayMs(noteUnproductiveAttempt());
                logger.debug(
                    `[opencode-events] could not reach the event stream (attempt ${unproductiveAttempts}); retrying in ${delay}ms`,
                    error
                );
                await sleep(delay);
                continue;
            }

            if (response.status === 404) {
                // Permanent: this build's HTTP API predates /event. Release
                // the connection and stop, so close() afterwards is a no-op.
                void response.body?.cancel().catch(() => {});
                controller.abort();
                logger.debug('[opencode-events] this OpenCode build has no /event endpoint; retry reporting disabled');
                return;
            }

            if (!response.ok || !response.body) {
                // Nothing will read this body, so hand it back rather than
                // leaving the connection open until the session tears down.
                void response.body?.cancel().catch(() => {});
                const delay = reconnectDelayMs(noteUnproductiveAttempt());
                logger.debug(
                    `[opencode-events] event stream answered ${response.status} (attempt ${unproductiveAttempts}); retrying in ${delay}ms`,
                    null
                );
                await sleep(delay);
                continue;
            }

            framesThisConnection = 0;
            try {
                await consumeStream(response.body);
            } catch (error) {
                if (closed || controller.signal.aborted) return;
                logger.debug('[opencode-events] event stream dropped', error);
            } finally {
                activeReader = null;
            }
            if (closed) return;

            // Counted on what the connection actually delivered, not on the
            // response status: a stream that produced frames and then ended
            // reconnects promptly, one that produced none backs off.
            if (framesThisConnection > 0) {
                unproductiveAttempts = 0;
                // Armed again: this connection worked, so a later outage is
                // a new fact rather than a continuation of an old one.
                warnedUnreachable = false;
                await sleep(reconnectDelayMs(unproductiveAttempts));
            } else {
                await sleep(reconnectDelayMs(noteUnproductiveAttempt()));
            }
        }
    };

    void run().catch((error) => {
        logger.debug('[opencode-events] event stream subscription ended unexpectedly', error);
    });

    return {
        close: () => {
            if (closed) return;
            closed = true;
            controller.abort();
            // Releases a read that is parked waiting for the next frame, so
            // no request is left dangling when the session goes away.
            void activeReader?.cancel().catch(() => {});
        }
    };
}
