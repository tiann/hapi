import Foundation
import HapiProtocol
import Testing
@testable import HapiClient

/// State-machine tests for `SSEClient`, all against a fake transport and a
/// manually advanced clock (no real timers, no sockets). Real-time waits
/// appear only in bounded polls that synchronize with the actor's async
/// processing.
@Suite("SSEClient state machine")
struct SSEClientTests {
    typealias Harness = (
        client: SSEClient,
        transport: FakeTransport,
        clock: ManualClock,
        tokens: TokenSource,
        box: EventBox
    )

    private func makeHarness(
        scope: SSEScope = .global,
        visibility: String = "visible",
        tokens: [String?] = ["tok-1"],
        pathObserver: FakePathObserver? = nil,
        transport: FakeTransport = FakeTransport(),
        clock: ManualClock = ManualClock()
    ) async -> Harness {
        let tokenSource = TokenSource(tokens)
        let configuration = SSEClientConfiguration(
            baseUrl: URL(string: "https://hub.test")!,
            tokenProvider: { tokenSource.next() },
            scope: scope,
            visibility: visibility,
            jitterMs: { 0 }
        )
        let client = SSEClient(
            configuration: configuration,
            transport: transport,
            clock: clock,
            pathObserver: pathObserver
        )
        let stream = await client.start()
        let (box, _) = collect(stream)
        return (client, transport, clock, tokenSource, box)
    }

    /// Advances the manual clock once the watchdog (or any sleeper) has
    /// actually parked — the watchdog registers its sleep asynchronously, so
    /// blind advances could set a deadline the test never crosses.
    private func advanceOnceSleeperParked(_ clock: ManualClock, byMs delta: Int) async {
        #expect(await waitUntil { clock.activeSleeperCount() >= 1 })
        clock.advance(byMs: delta)
    }

    // MARK: - Handshake

    @Test func handshakeGatesConnectedState() async throws {
        let h = await makeHarness()
        let connection = try #require(await h.transport.nextConnection())
        // Query-param auth, exactly like the web reference client.
        #expect(connection.queryItems["token"] == "tok-1")
        #expect(connection.queryItems["visibility"] == "visible")
        #expect(connection.queryItems["all"] == "true")
        #expect(connection.queryItems["sessionId"] == nil)
        #expect(connection.queryItems["lastEventId"] == nil)
        #expect(connection.request.value(forHTTPHeaderField: "Accept") == "text/event-stream")
        #expect(connection.request.value(forHTTPHeaderField: "Accept-Encoding") == nil)

        h.clock.advance(byMs: 5)
        connection.open()
        #expect(await waitUntil { await h.client.transportOpen })
        // A 200 alone is not "up": the state machine stays .connecting until
        // the hub's connection-changed handshake, heartbeats included.
        h.clock.advance(byMs: 1)
        connection.sendHeartbeat()
        #expect(await waitUntil { await h.client.lastActivityAtMs == 6 })
        #expect(await h.client.state == .connecting)
        #expect(h.box.handshakes.isEmpty)
        #expect(!h.box.states.contains(.connected))

        connection.sendHandshake(resume: "ok", subscriptionId: "sub-9")
        #expect(await waitUntil { !h.box.handshakes.isEmpty })
        #expect(h.box.handshakes == [.handshake(resume: .ok, subscriptionId: "sub-9")])
        #expect(await h.client.state == .connected)
        #expect(await h.client.subscriptionId == "sub-9")
        // stateChanged(.connected) precedes the handshake yield.
        let events = h.box.snapshot
        let connectedIndex = try #require(events.firstIndex(of: .stateChanged(.connected)))
        let handshakeIndex = try #require(events.firstIndex(of: .handshake(resume: .ok, subscriptionId: "sub-9")))
        #expect(connectedIndex < handshakeIndex)
        await h.client.stop()
    }

    @Test func resumeVerdictSurfacesGapWhenAbsent() async throws {
        let h = await makeHarness()
        let connection = try #require(await h.transport.nextConnection())
        connection.open()
        connection.sendHandshake(resume: nil, subscriptionId: "sub-2")
        #expect(await waitUntil { !h.box.handshakes.isEmpty })
        // Older hubs omit the verdict; absence must read as gap (full resync).
        #expect(h.box.handshakes == [.handshake(resume: .gap, subscriptionId: "sub-2")])
        await h.client.stop()
    }

    // MARK: - Cursor

    @Test func cursorSentOnReconnectAndIsolatedPerSubscription() async throws {
        let h = await makeHarness()
        let first = try #require(await h.transport.nextConnection())
        first.open()
        first.sendHandshake()
        first.sendEvent(
            "{\"type\":\"session-removed\",\"namespace\":\"ns\",\"sessionId\":\"s-9\"}",
            id: "018f:41:aa"
        )
        #expect(await waitUntil { !h.box.syncEvents.isEmpty })
        #expect(h.box.syncEvents == [.sessionRemoved(namespace: "ns", sessionId: "s-9")])
        #expect(await h.client.lastEventId == "018f:41:aa")

        // Server closes; attempt counter was reset on open, so the reconnect
        // is immediate and replays the cursor of THIS subscription.
        first.finish()
        let second = try #require(await h.transport.nextConnection())
        #expect(second.queryItems["lastEventId"] == "018f:41:aa")
        #expect(second.queryItems["all"] == "true")

        // A different subscription must never inherit that cursor: fresh
        // client, session scope, same hub.
        let other = await makeHarness(
            scope: .session("s-42"),
            visibility: "hidden",
            tokens: ["tok-B"],
            transport: h.transport,
            clock: h.clock
        )
        let otherConnection = try #require(await other.transport.nextConnection())
        #expect(otherConnection.queryItems["sessionId"] == "s-42")
        #expect(otherConnection.queryItems["all"] == nil)
        #expect(otherConnection.queryItems["visibility"] == "hidden")
        #expect(otherConnection.queryItems["token"] == "tok-B")
        #expect(otherConnection.queryItems["lastEventId"] == nil)
        await h.client.stop()
        await other.client.stop()
    }

    @Test func heartbeatKeepsWatchdogAliveButDoesNotMoveCursor() async throws {
        let h = await makeHarness()
        let connection = try #require(await h.transport.nextConnection())
        connection.open()
        connection.sendHandshake()
        connection.sendEvent(
            "{\"type\":\"scheduled-matured\",\"namespace\":\"ns\",\"sessionId\":\"s-1\"}",
            id: "018f:7:aa"
        )
        #expect(await waitUntil { await h.client.lastEventId == "018f:7:aa" })

        // 50 s of silence, then a heartbeat: watchdog stays quiet and the
        // cursor keeps the last real id (heartbeat frames carry no id).
        await advanceOnceSleeperParked(h.clock, byMs: 50_000)
        connection.sendHeartbeat()
        #expect(await waitUntil { await h.client.lastActivityAtMs == 50_000 })
        await advanceOnceSleeperParked(h.clock, byMs: 50_000) // 100 s total, only 50 s since the heartbeat
        #expect(await h.transport.expectNoConnection())
        #expect(h.transport.totalConnections() == 1)
        #expect(await h.client.state == .connected)
        #expect(await h.client.lastEventId == "018f:7:aa")

        // Full silence from here: the 90 s threshold tears it down and the
        // reconnect replays the heartbeat-untouched cursor.
        await advanceOnceSleeperParked(h.clock, byMs: 90_000)
        let second = try #require(await h.transport.nextConnection())
        #expect(second.queryItems["lastEventId"] == "018f:7:aa")
        #expect(connection.isTerminated)
        await h.client.stop()
    }

    // MARK: - Watchdog

    @Test func ninetySecondsOfSilenceTriggersReconnect() async throws {
        let h = await makeHarness()
        let first = try #require(await h.transport.nextConnection())
        first.open()
        first.sendHandshake()
        #expect(await waitUntil { !h.box.handshakes.isEmpty })
        await advanceOnceSleeperParked(h.clock, byMs: 90_000)
        _ = try #require(await h.transport.nextConnection())
        #expect(await waitUntil { h.box.states.contains(.backoff(attempt: 0)) })
        #expect(first.isTerminated)
        await h.client.stop()
    }

    @Test func hungConnectAttemptIsAbandonedAfterTimeout() async throws {
        let h = await makeHarness()
        let first = try #require(await h.transport.nextConnection())
        // Never reaches OPEN; the 10 s connect deadline abandons it.
        await advanceOnceSleeperParked(h.clock, byMs: 10_000)
        _ = try #require(await h.transport.nextConnection())
        #expect(await waitUntil { h.box.states.contains(.backoff(attempt: 0)) })
        #expect(first.isTerminated)
        await h.client.stop()
    }

    // MARK: - Suspend / resume

    @Test func suspendDefersRetriesAndResumeRunsThemImmediately() async throws {
        let h = await makeHarness()
        let first = try #require(await h.transport.nextConnection())
        first.finish() // attempt 0 fails → immediate retry
        let second = try #require(await h.transport.nextConnection())
        second.finish() // attempt 1 → 1 s backoff
        #expect(await waitUntil { h.box.states.contains(.backoff(attempt: 1)) })

        await h.client.suspend()
        #expect(await waitUntil { await h.client.state == .suspended })

        // Arbitrary time passes; a suspended client schedules nothing.
        h.clock.advance(byMs: 600_000)
        #expect(await h.transport.expectNoConnection())
        #expect(h.transport.totalConnections() == 2)

        await h.client.resume()
        _ = try #require(await h.transport.nextConnection())
        #expect(h.transport.totalConnections() == 3)
        await h.client.stop()
    }

    @Test func resumeWithStaleConnectionReconnectsImmediately() async throws {
        let h = await makeHarness()
        let first = try #require(await h.transport.nextConnection())
        first.open()
        first.sendHandshake()
        #expect(await waitUntil { !h.box.handshakes.isEmpty })

        await h.client.suspend()
        // 50 s pass while suspended — beyond the 45 s foreground threshold.
        // The watchdog itself must stay quiet (checks skip while suspended).
        h.clock.advance(byMs: 50_000)
        #expect(await h.transport.expectNoConnection())

        await h.client.resume()
        _ = try #require(await h.transport.nextConnection())
        #expect(first.isTerminated)
        await h.client.stop()
    }

    @Test func resumeWithFreshConnectionKeepsIt() async throws {
        let h = await makeHarness()
        let first = try #require(await h.transport.nextConnection())
        first.open()
        first.sendHandshake()
        #expect(await waitUntil { !h.box.handshakes.isEmpty })

        await h.client.suspend()
        h.clock.advance(byMs: 10_000) // well under the 45 s threshold
        await h.client.resume()
        #expect(await h.transport.expectNoConnection())
        #expect(!first.isTerminated)
        #expect(await h.client.state == .connected)
        await h.client.stop()
    }

    // MARK: - Event delivery

    @Test func eventsAreYieldedInArrivalOrder() async throws {
        let h = await makeHarness()
        let connection = try #require(await h.transport.nextConnection())
        connection.open()
        connection.sendHandshake()
        connection.send(
            "id: e-1\ndata: {\"type\":\"session-removed\",\"sessionId\":\"s-1\"}\n\n"
                + "id: e-2\ndata: {\"type\":\"messages-invalidated\",\"sessionId\":\"s-2\"}\n\n"
                + "id: e-3\ndata: {\"type\":\"scheduled-matured\",\"sessionId\":\"s-3\"}\n\n"
        )
        #expect(await waitUntil { h.box.syncEvents.count == 3 })
        #expect(h.box.syncEvents == [
            .sessionRemoved(namespace: nil, sessionId: "s-1"),
            .messagesInvalidated(namespace: nil, sessionId: "s-2"),
            .scheduledMatured(namespace: nil, sessionId: "s-3"),
        ])
        #expect(await h.client.lastEventId == "e-3")
        await h.client.stop()
    }

    @Test func unknownEventTypesPassThroughWithoutKillingTheStream() async throws {
        let h = await makeHarness()
        let connection = try #require(await h.transport.nextConnection())
        connection.open()
        connection.sendHandshake()
        connection.sendEvent(
            "{\"type\":\"quantum-flux\",\"namespace\":\"ns\",\"data\":{\"weird\":true}}",
            id: "e-8"
        )
        connection.sendEvent(
            "{\"type\":\"session-removed\",\"namespace\":\"ns\",\"sessionId\":\"s-1\"}",
            id: "e-9"
        )
        #expect(await waitUntil { h.box.syncEvents.count == 2 })
        #expect(h.box.syncEvents == [
            .unknown(type: "quantum-flux", namespace: "ns"),
            .sessionRemoved(namespace: "ns", sessionId: "s-1"),
        ])
        #expect(await h.client.lastEventId == "e-9")
        #expect(await h.client.state == .connected)
        await h.client.stop()
    }

    @Test func malformedKnownEventIsSkippedWithoutAdvancingCursor() async throws {
        let h = await makeHarness()
        let connection = try #require(await h.transport.nextConnection())
        connection.open()
        connection.sendHandshake()
        connection.sendEvent(
            "{\"type\":\"session-removed\",\"namespace\":\"ns\",\"sessionId\":\"s-1\"}",
            id: "good-1"
        )
        #expect(await waitUntil { await h.client.lastEventId == "good-1" })
        // Known type, missing required field: dropped, stream stays up, and
        // the cursor stays BEHIND the unhandled frame (at-least-once).
        connection.sendEvent("{\"type\":\"session-removed\",\"namespace\":\"ns\"}", id: "bad-1")
        let moved = await waitUntil(timeoutMs: 300) { await h.client.lastEventId == "bad-1" }
        #expect(!moved)
        connection.sendEvent("{\"type\":\"messages-invalidated\",\"sessionId\":\"s-2\"}", id: "good-2")
        #expect(await waitUntil { await h.client.lastEventId == "good-2" })
        #expect(h.box.syncEvents.count == 2)
        #expect(await h.client.state == .connected)
        await h.client.stop()
    }

    // MARK: - Auth

    @Test func unauthorizedConnectGetsOneTokenRefreshBypassPerCycle() async throws {
        let h = await makeHarness(tokens: ["tok-1", "tok-2", "tok-3"])
        let first = try #require(await h.transport.nextConnection())
        #expect(first.queryItems["token"] == "tok-1")
        first.open(status: 401)

        // Free retry: the provider is asked again (it refreshes) and the
        // reconnect is immediate, without counting a backoff attempt.
        let second = try #require(await h.transport.nextConnection())
        #expect(second.queryItems["token"] == "tok-2")

        // The bypass is capped at once per connect cycle: a second
        // consecutive 401 fails into normal backoff.
        second.open(status: 401)
        let third = try #require(await h.transport.nextConnection())
        #expect(third.queryItems["token"] == "tok-3")
        #expect(await waitUntil { h.box.states.contains(.backoff(attempt: 0)) })

        // Any other non-2xx fails into backoff too (503: hub not ready).
        third.open(status: 503)
        #expect(await waitUntil { h.box.states.contains(.backoff(attempt: 1)) })

        // Exactly two backoffs total — none between the first 401 and its
        // free retry.
        let backoffs = h.box.states.filter {
            if case .backoff = $0 { return true }
            return false
        }
        #expect(backoffs == [.backoff(attempt: 0), .backoff(attempt: 1)])
        #expect(h.tokens.callCount() == 3)
        await h.client.stop()
    }

    // MARK: - Network path

    @Test func networkPathChangeWhileConnectedForcesReconnect() async throws {
        let observer = FakePathObserver()
        let h = await makeHarness(pathObserver: observer)
        let first = try #require(await h.transport.nextConnection())
        first.open()
        first.sendHandshake()
        #expect(await waitUntil { !h.box.handshakes.isEmpty })

        #expect(await waitUntil { observer.subscriberCount() >= 1 })
        observer.emitChange(isSatisfied: true) // e.g. wifi → cellular
        _ = try #require(await h.transport.nextConnection())
        #expect(first.isTerminated)
        await h.client.stop()
    }

    // MARK: - Lifecycle

    @Test func stopTearsDownAndFinishesTheStream() async throws {
        let h = await makeHarness()
        let first = try #require(await h.transport.nextConnection())
        first.open()
        first.sendHandshake()
        #expect(await waitUntil { !h.box.handshakes.isEmpty })

        await h.client.stop()
        #expect(await waitUntil { first.isTerminated })
        #expect(await h.client.state == .idle)
        #expect(await waitUntil { h.box.states.last == .idle })

        // start() after stop() yields a finished stream, not a revived client.
        let revived = await h.client.start()
        var iterator = revived.makeAsyncIterator()
        #expect(await iterator.next() == nil)
    }

    @Test func seededCursorIsSentOnFirstConnect() async throws {
        let transport = FakeTransport()
        let clock = ManualClock()
        let tokenSource = TokenSource(["tok-1"])
        let configuration = SSEClientConfiguration(
            baseUrl: URL(string: "https://hub.test")!,
            tokenProvider: { tokenSource.next() },
            scope: .global,
            jitterMs: { 0 }
        )
        let client = SSEClient(configuration: configuration, transport: transport, clock: clock)
        await client.seedCursor("018f:99:zz")
        let stream = await client.start()
        _ = collect(stream)
        let connection = try #require(await transport.nextConnection())
        #expect(connection.queryItems["lastEventId"] == "018f:99:zz")
        await client.stop()
    }
}
