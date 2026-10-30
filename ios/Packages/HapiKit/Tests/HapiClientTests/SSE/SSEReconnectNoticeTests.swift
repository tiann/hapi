import HapiClient
import Testing

@Suite("SSE reconnect notice")
@MainActor
struct SSEReconnectNoticeTests {
    @Test func fastReconnectDoesNotFlash() async {
        let clock = ManualClock()
        let notice = SSEReconnectNotice(clock: clock)
        notice.update(.connecting)
        #expect(clock.activeSleeperCount() == 0)
        notice.update(.connected)

        // The immediate retry can begin before SwiftUI renders the backoff.
        notice.update(.backoff(attempt: 0))
        notice.update(.connecting)
        #expect(await waitUntil { clock.activeSleeperCount() == 1 })
        clock.advance(byMs: 3_999)
        #expect(!notice.isVisible)
        notice.update(.connected)
        #expect(await waitUntil { clock.activeSleeperCount() == 0 })
        clock.advance(byMs: 10_000)
        #expect(!notice.isVisible)
    }

    @Test func outageSpansRetryPhasesUntilHandshake() async {
        let clock = ManualClock()
        let notice = SSEReconnectNotice(clock: clock)
        notice.update(.connected)
        notice.update(.backoff(attempt: 0))
        #expect(await waitUntil { clock.activeSleeperCount() == 1 })
        clock.advance(byMs: 2_000)
        notice.update(.connecting)
        notice.update(.backoff(attempt: 1))
        notice.update(.connecting)
        clock.advance(byMs: 2_000)
        #expect(await waitUntil { await notice.isVisible })

        notice.update(.backoff(attempt: 2))
        notice.update(.connecting)
        #expect(notice.isVisible)
        #expect(clock.activeSleeperCount() == 0)
        notice.update(.connected)
        #expect(!notice.isVisible)
    }

    @Test(arguments: [SSEConnectionState.idle, .suspended])
    func lifecycleClearsPendingAndVisibleNotices(_ state: SSEConnectionState) async {
        let clock = ManualClock()
        let notice = SSEReconnectNotice(clock: clock)
        notice.update(.backoff(attempt: 0))
        #expect(await waitUntil { clock.activeSleeperCount() == 1 })
        clock.advance(byMs: 2_000)
        notice.update(state)
        notice.update(.connecting)
        #expect(await waitUntil { clock.activeSleeperCount() == 0 })
        clock.advance(byMs: 10_000)
        #expect(!notice.isVisible)

        notice.update(.backoff(attempt: 0))
        #expect(await waitUntil { clock.activeSleeperCount() == 1 })
        clock.advance(byMs: 4_000)
        #expect(await waitUntil { await notice.isVisible })
        notice.update(state)
        #expect(!notice.isVisible)
    }

    @Test func cancelledTimerCannotRevealTheNextOutage() async {
        let clock = ManualClock()
        let notice = SSEReconnectNotice(clock: clock)
        notice.update(.backoff(attempt: 0))
        #expect(await waitUntil { clock.activeSleeperCount() == 1 })
        // Wake the timer, but reconnect before its main-actor task runs.
        clock.advance(byMs: 4_000)
        notice.update(.connected)
        notice.update(.backoff(attempt: 0))
        #expect(await waitUntil { clock.activeSleeperCount() == 1 })
        #expect(!notice.isVisible)
        clock.advance(byMs: 3_999)
        #expect(!notice.isVisible)
        clock.advance(byMs: 1)
        #expect(await waitUntil { await notice.isVisible })
        notice.update(.idle)
    }
}
