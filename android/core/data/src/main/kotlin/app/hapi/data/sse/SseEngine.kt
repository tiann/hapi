package app.hapi.data.sse

import app.hapi.protocol.wire.SyncEvent
import app.hapi.protocol.wire.SyncEvents
import kotlin.coroutines.cancellation.CancellationException
import kotlin.coroutines.coroutineContext
import kotlin.random.Random
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.drop
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch

/**
 * Supplies the JWT for the SSE URL. Deliberately minimal so `sse/` stays
 * decoupled from the auth layer — `:app` adapts the real auth manager to it.
 */
fun interface SseTokenProvider {
    /**
     * Returns a token expected to be valid now, or null when none is
     * obtainable (not paired / hub unreachable for the auth exchange).
     *
     * @param forceRefresh true when the hub just rejected the previous token
     *   with 401 — the implementation must re-exchange instead of returning
     *   its cache.
     */
    suspend fun freshToken(forceRefresh: Boolean): String?
}

/** What [SseEngine] emits downstream, per subscription key. */
sealed interface EngineEvent {
    /** The hub's resume verdict (`sse.md#handshake-and-resume`). */
    enum class Resume {
        /** The replay that follows contains every missed event — skip the REST resync. */
        Ok,

        /** Continuity unproven (or field absent — older hubs): full REST resync. */
        Gap,
    }

    /**
     * The `connection-changed {status:connected}` handshake was received.
     * [subscriptionId] feeds `POST /api/visibility` reporting (it changes on
     * every reconnect).
     */
    data class Handshake(
        val subscriptionId: String?,
        val resume: Resume,
    ) : EngineEvent

    /**
     * A post-handshake protocol event. Never `heartbeat`/`connection-changed`
     * (consumed by the engine) and never `Unknown` (dropped, mirroring web).
     */
    data class Sync(val event: SyncEvent) : EngineEvent
}

/**
 * The SSE connection manager: at most one connection per subscription key
 * (`global` / `session:<id>`), each driven by its own retry loop implementing
 * the normative reconnect policy (`docs/api/client-contract/sse.md`,
 * reference `web/src/hooks/useSSE.ts`):
 *
 * - token fetch → connect → handshake gate (`connection-changed
 *   {status:connected}`) with a 10 s connect deadline → live streaming;
 * - resume cursor = last non-null frame id, kept **per key** (a cursor
 *   replayed under a different filter set would verify against the wrong
 *   filter), advanced only **after** the downstream emit returns — i.e. after
 *   every collector has accepted the event into its collect loop. A busy
 *   collector therefore holds back acknowledgement of every later event
 *   (at-least-once; per the contract, handlers must be idempotent);
 * - 90 s staleness watchdog ticking every 10 s (any frame counts, heartbeats
 *   included; checks skipped while backgrounded);
 * - exponential backoff 1 s → 30 s (300 s after 8 attempts) + jitter, first
 *   retry immediate, attempt counter reset on every successful handshake;
 * - one silent token refresh per cycle on 401, costing no backoff attempt;
 * - [setLifecycleForeground]: backgrounding defers retries but keeps a live
 *   connection open (OS-imposed teardown grace is the caller's concern);
 *   foregrounding releases deferred retries immediately and force-reconnects
 *   a connection whose last activity is older than 45 s.
 *
 * All waiting uses `kotlinx.coroutines` [delay] on the provided [scope], so
 * `runTest` virtual time drives the whole state machine ([nowMs] must then be
 * the test scheduler's clock).
 *
 * Usage: collect [events] **before** [subscribe] — emissions with no
 * collector are dropped (zero-replay [SharedFlow]).
 */
class SseEngine(
    private val baseUrl: String,
    private val transport: SseTransport,
    private val tokenProvider: SseTokenProvider,
    private val scope: CoroutineScope,
    private val nowMs: () -> Long = { System.nanoTime() / 1_000_000 },
    private val random: Random = Random.Default,
) {
    private val lock = Any()
    private val subscriptions = mutableMapOf<String, Subscription>()

    /**
     * Resume cursors, keyed by subscription key. Deliberately retained across
     * [unsubscribe]/[subscribe] cycles: a cursor stays valid for its own
     * filter set and turns the next handshake into `resume: ok`.
     */
    private val cursors = mutableMapOf<String, String>()
    private val foreground = MutableStateFlow(true)

    private class Subscription {
        /**
         * Zero replay, zero buffer: `emit` resumes only once every collector
         * has taken the value into its collect loop (no buffering), which is
         * what lets the engine order the cursor update after the downstream
         * hand-off — an event still queued behind a busy collector is never
         * acknowledged.
         */
        val events = MutableSharedFlow<EngineEvent>()
        var job: Job? = null
    }

    /** The per-key event stream. Stable across subscribe/unsubscribe cycles. */
    fun events(key: SseSubscriptionKey): SharedFlow<EngineEvent> = subscription(key).events

    /** Starts the connection loop for [key]. No-op when already running. */
    fun subscribe(key: SseSubscriptionKey) {
        val sub = subscription(key)
        synchronized(lock) {
            if (sub.job?.isActive == true) {
                return
            }
            sub.job = scope.launch { runSubscriptionLoop(key, sub) }
        }
    }

    /** Tears down [key]'s connection (the cursor is retained for resumes). */
    fun unsubscribe(key: SseSubscriptionKey) {
        val job = synchronized(lock) {
            val sub = subscriptions[key.key] ?: return
            sub.job.also { sub.job = null }
        }
        job?.cancel()
    }

    /**
     * Lifecycle input. Background: in-flight retries and new failures wait
     * (no retry is scheduled at all — mirroring web's hidden-tab deferral),
     * but an already-live connection stays open. Foreground: deferred retries
     * run immediately, and a live-but-stale connection (no activity for 45 s)
     * is torn down and rebuilt — an OS suspend can kill the socket without
     * any error surfacing.
     */
    fun setLifecycleForeground(foreground: Boolean) {
        this.foreground.value = foreground
    }

    private fun subscription(key: SseSubscriptionKey): Subscription = synchronized(lock) {
        subscriptions.getOrPut(key.key) { Subscription() }
    }

    private fun cursorFor(key: SseSubscriptionKey): String? = synchronized(lock) { cursors[key.key] }

    private fun setCursor(key: SseSubscriptionKey, id: String) {
        synchronized(lock) { cursors[key.key] = id }
    }

    private suspend fun runSubscriptionLoop(key: SseSubscriptionKey, sub: Subscription) {
        var attempt = 0
        var authRetriedThisCycle = false
        var forceTokenRefresh = false
        while (coroutineContext.isActive) {
            val token = tokenProvider.freshToken(forceTokenRefresh)
            forceTokenRefresh = false
            if (token == null) {
                attempt = backoffThenAwaitForeground(attempt)
                continue
            }

            val outcome = runAttempt(key, sub, token)

            if (outcome.handshakeReached) {
                // "Reset the attempt counter to 0 on every successful open."
                attempt = 0
                authRetriedThisCycle = false
            }
            if (outcome.failureCode == 401 && !authRetriedThisCycle) {
                // One silent re-auth per cycle: reconnect immediately with a
                // forced token refresh, consuming no backoff attempt. A second
                // 401 in the same cycle falls through to normal backoff.
                authRetriedThisCycle = true
                forceTokenRefresh = true
                awaitForeground()
                continue
            }
            attempt = backoffThenAwaitForeground(attempt)
        }
    }

    /**
     * The post-failure wait. Visible: consume one backoff attempt and delay.
     * Backgrounded (at failure time or mid-delay): park until foreground and
     * retry immediately then — a retry that fell due while backgrounded costs
     * no attempt, exactly like the web reference's hidden-tab deferral.
     */
    private suspend fun backoffThenAwaitForeground(attempt: Int): Int {
        if (!foreground.value) {
            awaitForeground()
            return attempt
        }
        val next = attempt + 1
        delay(ReconnectPolicy.delayForAttempt(attempt, random))
        awaitForeground()
        return next
    }

    private suspend fun awaitForeground() {
        foreground.first { it }
    }

    private class AttemptState {
        @Volatile var handshakeReached = false
        @Volatile var lastActivityAtMs = 0L
        @Volatile var failureCode: Int? = null
    }

    private suspend fun runAttempt(
        key: SseSubscriptionKey,
        sub: Subscription,
        token: String,
    ): AttemptState = coroutineScope {
        val state = AttemptState()
        state.lastActivityAtMs = nowMs()
        val cursor = cursorFor(key)
        val url = buildEventsUrl(
            baseUrl = baseUrl,
            token = token,
            subscription = key,
            visibility = if (foreground.value) "visible" else "hidden",
            lastEventId = cursor,
        )

        val collector = launch {
            try {
                transport.open(url, cursor).collect { transportEvent ->
                    when (transportEvent) {
                        TransportEvent.Connected -> state.lastActivityAtMs = nowMs()
                        is TransportEvent.Event -> handleRawEvent(key, sub, transportEvent.event, state)
                        is TransportEvent.Failure -> state.failureCode = transportEvent.code
                    }
                }
            } catch (cancellation: CancellationException) {
                throw cancellation
            } catch (_: Throwable) {
                // SseTransport's contract is to materialize errors as Failure
                // events; a throwing transport degrades to a codeless failure.
            }
        }
        val watchdog = launch { runWatchdog(state, collector) }
        val resumeCheck = launch { runForegroundResumeCheck(state, collector) }

        collector.join()
        watchdog.cancel()
        resumeCheck.cancel()
        state
    }

    /**
     * Phase 1: the handshake must arrive within [ReconnectPolicy.CONNECT_TIMEOUT_MS]
     * of the attempt starting (an attempt hung on a dead pooled socket never
     * errors on its own). Phase 2: staleness — no frame of any kind for
     * [ReconnectPolicy.STALE_MS] kills the connection; checked every
     * [ReconnectPolicy.WATCHDOG_TICK_MS], skipped while backgrounded.
     */
    private suspend fun runWatchdog(state: AttemptState, collector: Job) {
        val connectDeadline = nowMs() + ReconnectPolicy.CONNECT_TIMEOUT_MS
        while (!state.handshakeReached) {
            val remaining = connectDeadline - nowMs()
            if (remaining <= 0) {
                collector.cancel()
                return
            }
            delay(remaining)
        }
        while (true) {
            delay(ReconnectPolicy.WATCHDOG_TICK_MS)
            if (!foreground.value) {
                continue
            }
            if (nowMs() - state.lastActivityAtMs >= ReconnectPolicy.STALE_MS) {
                collector.cancel()
                return
            }
        }
    }

    /**
     * On background→foreground, distrust a connection whose last frame is
     * older than [ReconnectPolicy.RESUME_STALE_MS] and rebuild it right away
     * (the watchdog skipped its checks while backgrounded).
     */
    private suspend fun runForegroundResumeCheck(state: AttemptState, collector: Job) {
        foreground.drop(1).collect { isForeground ->
            if (isForeground && nowMs() - state.lastActivityAtMs >= ReconnectPolicy.RESUME_STALE_MS) {
                collector.cancel()
            }
        }
    }

    private suspend fun handleRawEvent(
        key: SseSubscriptionKey,
        sub: Subscription,
        raw: SseRawEvent,
        state: AttemptState,
    ) {
        state.lastActivityAtMs = nowMs()
        val parsed = SyncEvents.parse(raw.data)

        if (!state.handshakeReached) {
            // The hub guarantees connection-changed{status:connected} first.
            // Nothing is processed before the handshake (the web reference
            // never observes pre-handshake frames); dropped frames do NOT
            // advance the cursor, so a misbehaving hub would redeliver them.
            val handshake = parsed as? SyncEvent.ConnectionChanged ?: return
            val data = handshake.data
            if (data?.status != "connected") {
                return
            }
            state.handshakeReached = true
            sub.events.emit(EngineEvent.Handshake(data.subscriptionId, resumeVerdict(data.resume)))
            return
        }

        when (parsed) {
            is SyncEvent.Heartbeat -> {
                // Watchdog food only (activity recorded above); no emission.
            }
            is SyncEvent.ConnectionChanged -> {
                // One handshake per connection normally; surface a repeat the
                // way web re-fires onConnect on every connection-changed.
                val data = parsed.data
                if (data?.status == "connected") {
                    sub.events.emit(EngineEvent.Handshake(data.subscriptionId, resumeVerdict(data.resume)))
                }
            }
            is SyncEvent.Unknown -> {
                if (parsed.raw == null) {
                    // Undecodable frame: web bails out before its cursor
                    // update — don't advance past it.
                    return
                }
                // Unknown-but-well-formed type: skipped without emission
                // (redelivery cannot help), cursor advances below.
            }
            else -> sub.events.emit(EngineEvent.Sync(parsed))
        }

        // At-least-once: the cursor moves past an event only after the
        // downstream emit returned (every collector accepted it; with the
        // zero-buffer flow a busy collector suspends the emit, keeping later
        // events unacknowledged). Frames without an id (heartbeat,
        // connection-changed) leave it untouched — SSE cursors are sticky.
        if (raw.id != null) {
            setCursor(key, raw.id)
        }
    }

    private fun resumeVerdict(resume: String?): EngineEvent.Resume =
        if (resume == "ok") EngineEvent.Resume.Ok else EngineEvent.Resume.Gap
}
