import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking  // URLSession types live here on Linux
#endif
import HapiProtocol

/// Which events this subscription receives (sse.md "Dual-subscription
/// model"). The reference client holds one `.global` client for the whole
/// app session plus one `.session` client per open chat.
public enum SSEScope: Equatable, Hashable, Sendable {
    /// `all=true` — every event in the token's namespace.
    case global
    /// `sessionId=<id>` — events for one session.
    case session(String)
}

public struct SSEClientConfiguration: Sendable {
    /// Hub origin, e.g. `https://hub.example`. The path is always replaced
    /// with `/api/events` (mirrors `new URL(path, baseUrl)` on the web).
    public var baseUrl: URL
    /// Called before every connection attempt; expected to return a fresh
    /// JWT (refreshing when its cached one is stale) or `nil` when the
    /// client cannot authenticate right now (the attempt fails into
    /// backoff). Re-asked once, without counting a backoff attempt, when a
    /// connect fails with 401.
    public var tokenProvider: @Sendable () async -> String?
    public var scope: SSEScope
    /// Initial `?visibility=` value: `"visible"` or `"hidden"` (anything
    /// else reads as hidden hub-side). Later changes go through
    /// `POST /api/visibility` with the handshake's `subscriptionId`.
    public var visibility: String
    /// When true, sends `Accept-Encoding: identity` so the hub skips gzip.
    ///
    /// TODO(gzip): sse.md requires verifying on-device that URLSession
    /// surfaces gzip-decoded bytes incrementally (one visible frame per
    /// server flush) rather than buffering until EOF. Until that M1
    /// verification runs against a real hub, this flag is the escape hatch:
    /// flip it to `true` if frames only arrive in bulk on disconnect.
    public var acceptEncodingIdentity: Bool
    public var reconnectPolicy: ReconnectPolicy
    /// Jitter draw added to every backoff delay. Injectable so tests are
    /// deterministic; defaults to uniform over the policy's jitter range.
    public var jitterMs: @Sendable () -> Int

    public init(
        baseUrl: URL,
        tokenProvider: @escaping @Sendable () async -> String?,
        scope: SSEScope,
        visibility: String = "visible",
        acceptEncodingIdentity: Bool = false,
        reconnectPolicy: ReconnectPolicy = ReconnectPolicy(),
        jitterMs: (@Sendable () -> Int)? = nil
    ) {
        self.baseUrl = baseUrl
        self.tokenProvider = tokenProvider
        self.scope = scope
        self.visibility = visibility
        self.acceptEncodingIdentity = acceptEncodingIdentity
        self.reconnectPolicy = reconnectPolicy
        let range = reconnectPolicy.jitterRangeMs
        self.jitterMs = jitterMs ?? { Int.random(in: range) }
    }
}

public enum SSEConnectionState: Equatable, Sendable {
    case idle
    case connecting
    /// Entered only on the first decoded
    /// `connection-changed {status: "connected"}` frame — a 200 response
    /// alone is not "up" (the hub's handshake is the source of truth).
    case connected
    /// Waiting `reconnectPolicy` delay before attempt `attempt` retries
    /// (0-based; attempt 0 retries immediately, jitter only).
    case backoff(attempt: Int)
    /// Parked by `suspend()` with no live connection; retries are deferred
    /// until `resume(...)`.
    case suspended
}

public enum SSEClientEvent: Equatable, Sendable {
    /// The hub's subscribe handshake. `resume == .ok` ⇒ the replay that
    /// follows contains every missed event, skip the REST resync; `.gap`
    /// (including an absent/unknown wire verdict) ⇒ full refetch.
    /// `subscriptionId` is needed for `POST /api/visibility` and is new on
    /// every reconnect.
    case handshake(resume: ResumeVerdict, subscriptionId: String?)
    /// A decoded broadcast frame, in arrival order. Heartbeats are consumed
    /// internally (watchdog) and never surface; unknown event types surface
    /// as `SyncEvent.unknown` and never kill the stream.
    case event(SyncEvent)
    case stateChanged(SSEConnectionState)
}

/// SSE subscription client: one actor instance per subscription
/// (scope + hub + namespace). Owns the whole reconnect state machine:
///
///     idle → connecting → connected
///                ↑            │ transport error / staleness / path change
///                └─ backoff(n) ┘        (suspended parks between attempts)
///
/// Behavior follows `docs/api/client-contract/sse.md` and the web reference
/// `web/src/hooks/useSSE.ts`:
///
/// - Handshake-gated: `.connected` only after the first decoded
///   `connection-changed {status: "connected"}`; its `resume` verdict is
///   surfaced as `.handshake`.
/// - Sticky cursor: only non-empty frame `id`s move `lastEventId`; id-less
///   heartbeats can never blank it. The cursor is scoped to this instance —
///   a client for a different subscription must be a new instance, so a
///   cursor can never replay against the wrong filter set.
/// - At-least-once: the cursor advances only after the event was yielded to
///   the consumer stream. (`AsyncStream` buffers, so "yielded" means handed
///   to the consumer's buffer — consumers needing durable handling must
///   drain promptly and treat redelivery as idempotent.)
/// - Watchdog: 10 s ticks; connect attempts that have not opened within
///   10 s are abandoned; 90 s without any bytes tears the connection down.
///   Checks are skipped while suspended.
/// - Backoff per `ReconnectPolicy`; the attempt counter resets on every
///   successful open, so the first retry after a healthy connection is
///   immediate.
/// - `suspend()`/`resume(staleThresholdCheck:)` for app lifecycle: retries
///   are deferred while suspended; on resume a surviving connection that
///   has been silent ≥ 45 s is torn down and rebuilt immediately.
/// - 401 connect failures re-ask the token provider once per connect cycle
///   without counting a backoff attempt (the provider refreshes); a second
///   consecutive 401 backs off normally.
///
/// Lifecycle: `start()` once, consume the returned stream, `stop()` when
/// done. A stopped client is finished — build a new instance to resubscribe.
public actor SSEClient {
    private enum AttemptExit: Equatable, Sendable {
        case unauthorized
        case failed
        case stopped
    }

    public let configuration: SSEClientConfiguration
    private let transport: any SSETransport
    private let clock: any SSEClock
    private let pathObserver: (any NetworkPathObserving)?
    private let decoder = JSONDecoder()

    public private(set) var state: SSEConnectionState = .idle
    /// Sticky resume cursor for THIS subscription (nil until the first
    /// id-carrying frame). Callers may persist it keyed by
    /// (hub, namespace, filter set) and seed a future instance via
    /// `seedCursor(_:)` before `start()`.
    public private(set) var lastEventId: String?
    /// From the latest handshake; new on every reconnect. Needed for
    /// `POST /api/visibility`.
    public private(set) var subscriptionId: String?

    private var continuation: AsyncStream<SSEClientEvent>.Continuation?
    private var consumerGeneration = 0
    private var runTask: Task<Void, Never>?
    private var pathTask: Task<Void, Never>?
    private var currentAttemptTask: Task<AttemptExit, Never>?
    private var sleepTask: Task<Void, Never>?
    private var resumeWaiters: [CheckedContinuation<Void, Never>] = []

    private var stopped = false
    private var suspended = false
    private var connectAttempt = 0
    private var authRetryUsed = false

    // Per-attempt bookkeeping, read by the watchdog and lifecycle checks.
    // Internal (not private) so @testable tests can synchronize on them.
    private(set) var transportOpen = false
    private(set) var handshakeSeen = false
    private(set) var connectStartedAtMs = 0
    private(set) var lastActivityAtMs = 0

    public init(
        configuration: SSEClientConfiguration,
        transport: any SSETransport = URLSessionSSETransport(),
        clock: any SSEClock = SystemSSEClock(),
        pathObserver: (any NetworkPathObserving)? = nil
    ) {
        self.configuration = configuration
        self.transport = transport
        self.clock = clock
        self.pathObserver = pathObserver
    }

    // MARK: - Lifecycle

    /// Starts the connection loop (first call) and returns the event stream.
    /// Calling again replaces the consumer stream; calling after `stop()`
    /// returns an immediately finished stream.
    public func start() -> AsyncStream<SSEClientEvent> {
        let (stream, continuation) = AsyncStream.makeStream(of: SSEClientEvent.self)
        if stopped {
            continuation.finish()
            return stream
        }
        self.continuation?.finish()
        self.continuation = continuation
        consumerGeneration += 1
        let generation = consumerGeneration
        continuation.onTermination = { [weak self] _ in
            // Nobody is listening anymore: shut the connection down (guarded
            // by generation so replacing the consumer does not stop us).
            Task { await self?.consumerFinished(generation: generation) }
        }
        if runTask == nil {
            runTask = Task { await self.run() }
            if let pathObserver {
                pathTask = Task { await self.observePath(pathObserver) }
            }
        }
        return stream
    }

    /// Permanently stops the client: tears down the connection, cancels any
    /// pending retry, and finishes the event stream. Idempotent.
    public func stop() {
        stopped = true
        suspended = false
        drainResumeWaiters()
        sleepTask?.cancel()
        currentAttemptTask?.cancel()
        pathTask?.cancel()
        pathTask = nil
        runTask?.cancel()
        setState(.idle)
        finishStream()
    }

    /// App went to background: defer retries. A live connection is kept
    /// (the OS may or may not preserve it); watchdog checks pause so a
    /// frozen app cannot mis-detect staleness on wake.
    public func suspend() {
        guard !stopped, !suspended else { return }
        suspended = true
        // A pending backoff sleep is abandoned; the run loop parks at the
        // top until resume() and then retries immediately.
        sleepTask?.cancel()
    }

    /// App returned to foreground. A parked retry runs immediately. When a
    /// connection survived suspension, `staleThresholdCheck` distrusts it if
    /// it has been silent for ≥ 45 s (`SSETimings.foregroundResumeStalenessMs`)
    /// — an OS suspend can kill the socket without any error surfacing — and
    /// reconnects immediately.
    public func resume(staleThresholdCheck: Bool = true) {
        guard !stopped, suspended else { return }
        suspended = false
        drainResumeWaiters()
        if staleThresholdCheck, transportOpen,
           clock.nowMs() - lastActivityAtMs >= SSETimings.foregroundResumeStalenessMs {
            currentAttemptTask?.cancel()
        }
    }

    /// Seeds the resume cursor before `start()` (e.g. one persisted from a
    /// previous process, keyed to this same subscription filter set — never
    /// seed a cursor recorded under a different scope/hub/namespace).
    public func seedCursor(_ id: String?) {
        guard runTask == nil, !stopped else { return }
        lastEventId = id
    }

    private func consumerFinished(generation: Int) {
        guard generation == consumerGeneration else { return }
        stop()
    }

    private func finishStream() {
        continuation?.finish()
        continuation = nil
    }

    // MARK: - Run loop

    private func run() async {
        while !stopped {
            if suspended {
                await parkUntilResumed()
                continue
            }
            setState(.connecting)
            let token = await configuration.tokenProvider()
            if stopped { break }
            if suspended { continue }
            guard let token, let request = makeRequest(token: token) else {
                // Cannot authenticate right now; the provider may recover
                // (refresh in flight, credentials being restored) — retry on
                // the normal schedule.
                await scheduleBackoff()
                continue
            }
            let exit = await performAttempt(request: request)
            if stopped { break }
            if exit == .stopped { continue } // loop condition exits
            if exit == .unauthorized, !authRetryUsed {
                // The token was rejected: ask the provider again (it
                // refreshes) and retry immediately. Not a backoff attempt,
                // and capped at once per connect cycle so a hub that keeps
                // 401-ing still backs off.
                authRetryUsed = true
                continue
            }
            if suspended { continue } // parks at loop top; retry deferred
            await scheduleBackoff()
        }
        setState(.idle)
        finishStream()
    }

    private func parkUntilResumed() async {
        setState(.suspended)
        while suspended, !stopped {
            await withCheckedContinuation { (waiter: CheckedContinuation<Void, Never>) in
                if !suspended || stopped {
                    waiter.resume()
                } else {
                    resumeWaiters.append(waiter)
                }
            }
        }
    }

    private func drainResumeWaiters() {
        let waiters = resumeWaiters
        resumeWaiters.removeAll()
        for waiter in waiters {
            waiter.resume()
        }
    }

    private func scheduleBackoff() async {
        let attempt = connectAttempt
        connectAttempt += 1
        setState(.backoff(attempt: attempt))
        let delay = configuration.reconnectPolicy.exponentialDelayMs(forAttempt: attempt)
            + max(0, configuration.jitterMs())
        await backoffSleep(ms: delay)
    }

    private func backoffSleep(ms: Int) async {
        guard ms > 0, !suspended, !stopped else { return }
        let clock = self.clock
        let task = Task { _ = try? await clock.sleep(ms: ms) }
        sleepTask = task
        await task.value
        sleepTask = nil
    }

    // MARK: - One connection attempt

    private func performAttempt(request: URLRequest) async -> AttemptExit {
        connectStartedAtMs = clock.nowMs()
        lastActivityAtMs = connectStartedAtMs
        transportOpen = false
        handshakeSeen = false
        let attemptTask = Task { await self.readAttempt(request: request) }
        currentAttemptTask = attemptTask
        let watchdogTask = Task { await self.runWatchdog(killing: attemptTask) }
        let exit = await attemptTask.value
        watchdogTask.cancel()
        currentAttemptTask = nil
        transportOpen = false
        handshakeSeen = false
        return exit
    }

    private func readAttempt(request: URLRequest) async -> AttemptExit {
        let stream = transport.connect(request)
        var parser = SSELineParser()
        do {
            for try await transportEvent in stream {
                if Task.isCancelled { return cancellationExit() }
                switch transportEvent {
                case .connected(let response):
                    let status = response.statusCode
                    if status == 401 { return .unauthorized }
                    guard (200...299).contains(status) else { return .failed }
                    transportOpen = true
                    // Mirrors the web client's onopen: the backoff counter
                    // resets on every successful open, and the one free
                    // auth retry re-arms for the next cycle.
                    connectAttempt = 0
                    authRetryUsed = false
                    lastActivityAtMs = clock.nowMs()
                case .bytes(let data):
                    // Any received bytes — heartbeats, comments, partial
                    // frames — count as activity for the staleness clock.
                    lastActivityAtMs = clock.nowMs()
                    for frame in parser.consume(data) {
                        handleFrame(frame)
                    }
                }
            }
            // Server closed the stream (or iteration ended on cancellation).
            return Task.isCancelled ? cancellationExit() : .failed
        } catch {
            if Task.isCancelled || error is CancellationError {
                return cancellationExit()
            }
            return .failed
        }
    }

    private func cancellationExit() -> AttemptExit {
        stopped ? .stopped : .failed
    }

    private func handleFrame(_ frame: SSEFrame) {
        let decoded: SyncEvent
        do {
            decoded = try decoder.decode(SyncEvent.self, from: Data(frame.data.utf8))
        } catch {
            // Known event type with a malformed payload (unknown types decode
            // to .unknown and never throw). Mirror the web client: drop the
            // frame, keep the stream alive, and leave the cursor BEHIND it —
            // never advance past something that was not handled.
            return
        }

        switch decoded {
        case .heartbeat:
            // Pure liveness; activity was already stamped per-chunk. Carries
            // no id, so the sticky cursor is untouched by construction.
            return
        case .connectionChanged(_, let payload):
            if !handshakeSeen, payload?.status == "connected" {
                handshakeSeen = true
                subscriptionId = payload?.subscriptionId
                setState(.connected)
                // Absent verdict = older hub = cannot prove continuity: gap.
                continuation?.yield(.handshake(
                    resume: payload?.resume ?? .gap,
                    subscriptionId: payload?.subscriptionId
                ))
            } else {
                continuation?.yield(.event(decoded))
            }
        default:
            continuation?.yield(.event(decoded))
        }

        // At-least-once: the cursor moves only after the yield above, and
        // only for frames that actually carried an id (sticky otherwise).
        if let id = frame.id, !id.isEmpty {
            lastEventId = id
        }
    }

    private func runWatchdog(killing attemptTask: Task<AttemptExit, Never>) async {
        while !Task.isCancelled {
            try? await clock.sleep(ms: SSETimings.watchdogTickMs)
            if Task.isCancelled { return }
            if suspended { continue } // checks are skipped while backgrounded
            let now = clock.nowMs()
            if !transportOpen {
                // Likely hung on a dead pooled socket; abandon the attempt
                // and retry on a fresh connection.
                if now - connectStartedAtMs >= SSETimings.connectTimeoutMs {
                    attemptTask.cancel()
                    return
                }
            } else if now - lastActivityAtMs >= SSETimings.stalenessThresholdMs {
                attemptTask.cancel()
                return
            }
        }
    }

    private func observePath(_ observer: any NetworkPathObserving) async {
        // The first element is the baseline emitted on subscription, not a
        // change — see NetworkPathObserving.
        var isBaseline = true
        for await _ in observer.pathUpdates() {
            if Task.isCancelled { return }
            if isBaseline {
                isBaseline = false
                continue
            }
            // A path change while connected: the socket is almost certainly
            // bound to a route that no longer exists. Treat it as a transport
            // error; the attempt counter was reset on open, so the reconnect
            // is immediate.
            if !stopped, !suspended, transportOpen {
                currentAttemptTask?.cancel()
            }
        }
    }

    // MARK: - Request building

    private func makeRequest(token: String) -> URLRequest? {
        guard var components = URLComponents(url: configuration.baseUrl, resolvingAgainstBaseURL: false) else {
            return nil
        }
        components.path = "/api/events"
        // Query-param auth, exactly like the web reference (buildEventsUrl):
        // token, visibility, all|sessionId, lastEventId.
        var items = [
            URLQueryItem(name: "token", value: token),
            URLQueryItem(name: "visibility", value: configuration.visibility),
        ]
        switch configuration.scope {
        case .global:
            items.append(URLQueryItem(name: "all", value: "true"))
        case .session(let sessionId):
            items.append(URLQueryItem(name: "sessionId", value: sessionId))
        }
        if let lastEventId, !lastEventId.isEmpty {
            items.append(URLQueryItem(name: "lastEventId", value: lastEventId))
        }
        components.queryItems = items
        guard let url = components.url else { return nil }
        var request = URLRequest(url: url)
        request.httpMethod = "GET"
        request.setValue("text/event-stream", forHTTPHeaderField: "Accept")
        request.setValue("no-cache", forHTTPHeaderField: "Cache-Control")
        if configuration.acceptEncodingIdentity {
            // See SSEClientConfiguration.acceptEncodingIdentity (gzip TODO).
            request.setValue("identity", forHTTPHeaderField: "Accept-Encoding")
        }
        return request
    }

    // MARK: - State

    private func setState(_ newState: SSEConnectionState) {
        guard state != newState else { return }
        state = newState
        continuation?.yield(.stateChanged(newState))
    }
}
