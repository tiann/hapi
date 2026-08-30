import Foundation
import HapiClient
import HapiProtocol
import Testing

/// Transcribes the Android reference suite (`LastSeenStoreTest.kt`):
/// monotonic watermarks, the unread derivation, per-scope baseline seeding,
/// and the snapshot round-trip.
@MainActor
@Suite("LastSeenStore")
struct LastSeenStoreTests {

    @Test func markSeenIsMonotonicMax() {
        let store = LastSeenStore()
        store.markSeen(sessionId: "s1", seenAt: 1_000)
        #expect(store.lastSeenAt("s1") == 1_000)
        store.markSeen(sessionId: "s1", seenAt: 500) // stale screen must not rewind
        #expect(store.lastSeenAt("s1") == 1_000)
        store.markSeen(sessionId: "s1", seenAt: 2_000)
        #expect(store.lastSeenAt("s1") == 2_000)
        #expect(store.lastSeenAt("unknown") == 0)
    }

    @Test func unreadComparesLatestReplyAgainstTheWatermark() {
        let row = storeSummary("s1", updatedAt: 9_000, lastAssistantMessageAt: 1_000)
        #expect(LastSeenStore.isUnread(row, lastSeenAt: 0))
        #expect(LastSeenStore.isUnread(row, lastSeenAt: 999))
        #expect(!LastSeenStore.isUnread(row, lastSeenAt: 1_000))
        #expect(!LastSeenStore.isUnread(row, lastSeenAt: 2_000))
    }

    @Test func archiveOnlyUpdatedAtChangesDoNotMakeASeenReplyUnread() {
        let archived = storeSummary("archived", updatedAt: 9_000, lastAssistantMessageAt: 5_000)
        #expect(!LastSeenStore.isUnread(archived, lastSeenAt: 5_000))
    }

    @Test func baselineWaitsForALegacyReplyClockBeforeSeeding() {
        var pending = storeSummary("legacy", updatedAt: 9_000, lastAssistantMessageAt: 5_000)
        pending.assistantReplyClockBackfilled = false
        let store = LastSeenStore()

        store.initializeBaseline(scopeKey: "hub-a", sessions: [pending])
        #expect(store.lastSeenAt("legacy") == 0)
        #expect(!LastSeenStore.isUnread(pending, lastSeenAt: store.lastSeenAt("legacy")))

        pending.assistantReplyClockBackfilled = true
        store.initializeBaseline(scopeKey: "hub-a", sessions: [pending])
        #expect(store.lastSeenAt("legacy") == 5_000)
    }

    @Test func baselineSeedsMissingWatermarksOnlyOncePerScope() {
        let store = LastSeenStore()
        store.markSeen(sessionId: "seen", seenAt: 50)
        store.initializeBaseline(
            scopeKey: "hub-a",
            sessions: [storeSummary("seen", updatedAt: 900), storeSummary("fresh", updatedAt: 700)]
        )
        // Existing watermarks are never overwritten; missing ones seed at
        // reply/activity clock.
        #expect(store.lastSeenAt("seen") == 50)
        #expect(store.lastSeenAt("fresh") == 700)
        #expect(!LastSeenStore.isUnread(storeSummary("fresh", updatedAt: 700), lastSeenAt: store.lastSeenAt("fresh")))

        // Second call for the same scope is a no-op — later sessions stay
        // unread.
        store.initializeBaseline(scopeKey: "hub-a", sessions: [storeSummary("later", updatedAt: 999)])
        #expect(store.lastSeenAt("later") == 0)
        #expect(LastSeenStore.isUnread(storeSummary("later", updatedAt: 999), lastSeenAt: store.lastSeenAt("later")))
    }

    @Test func stateRoundTripsThroughTheSnapshot() async throws {
        let directory = makeTempDirectory()
        let store = LastSeenStore(snapshotDirectory: directory)
        store.markSeen(sessionId: "s1", seenAt: 1_234)
        store.initializeBaseline(scopeKey: "hub-a", sessions: [])
        await store.flushPersistence()

        let cold = LastSeenStore(snapshotDirectory: directory)
        #expect(cold.lastSeenAt("s1") == 1_234)
        // Baseline flag persists too — no re-seeding on cold start.
        cold.initializeBaseline(scopeKey: "hub-a", sessions: [storeSummary("s2", updatedAt: 700)])
        #expect(cold.lastSeenAt("s2") == 0)
    }
}
