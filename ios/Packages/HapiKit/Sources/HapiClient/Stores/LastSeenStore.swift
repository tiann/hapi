import Foundation
import HapiProtocol
import Observation

/// Snapshot payload: watermarks + which scopes already got their baseline.
public struct LastSeenState: Codable, Equatable, Sendable {
    public var lastSeen: [String: Int]
    public var baselines: Set<String>

    public init(lastSeen: [String: Int] = [:], baselines: Set<String> = []) {
        self.lastSeen = lastSeen
        self.baselines = baselines
    }
}

/// Per-session last-seen watermarks — port of `web/src/lib/sessionLastSeen.ts`
/// (localStorage → per-hub JSON snapshot) plus the unread derivation from
/// `web/src/lib/sessionAttention.ts`, mirroring the Android port
/// (`LastSeenStore`).
///
/// The watermark is the session `updatedAt` the operator last had on screen;
/// a session is **unread** when its current `updatedAt` moved past it
/// (``isUnread(_:lastSeenAt:)`` — the reference compares `updatedAt` only;
/// message `seq` never reaches the summary).
/// ``initializeBaseline(scopeKey:sessions:)`` seeds missing watermarks from
/// the first session list so a fresh install does not mark every historical
/// session unread — once per ``LastSeenState/baselines`` scope, exactly like
/// the web's per-scope baseline flag.
@MainActor @Observable
public final class LastSeenStore {
    public private(set) var state: LastSeenState

    @ObservationIgnored private let snapshot: DiskCache<LastSeenState>?

    public init(snapshotDirectory: URL? = nil) {
        let cache = snapshotDirectory.map {
            DiskCache<LastSeenState>(directory: $0, filename: "last-seen.json")
        }
        self.snapshot = cache
        self.state = cache?.load() ?? LastSeenState()
    }

    public func lastSeenAt(_ sessionId: String) -> Int {
        state.lastSeen[sessionId] ?? 0
    }

    /// Forces the debounced snapshot to disk (app background / tests).
    public func flushPersistence() async {
        await snapshot?.flush()
    }

    /// `markSessionSeen`: monotonic max — a stale screen never rewinds the
    /// watermark.
    public func markSeen(sessionId: String, seenAt: Int) {
        guard !sessionId.isEmpty else { return }
        let current = state.lastSeen[sessionId] ?? 0
        let next = max(current, seenAt)
        if next == current, state.lastSeen[sessionId] != nil {
            return
        }
        state.lastSeen[sessionId] = next
        snapshot?.scheduleWrite(state)
    }

    /// `initializeSessionLastSeen`: on the first list load for `scopeKey`
    /// (e.g. the hub origin), seed every session without a watermark at its
    /// current `updatedAt`, then never again for that scope.
    public func initializeBaseline(scopeKey: String, sessions: [SessionSummary]) {
        guard !state.baselines.contains(scopeKey) else { return }
        var next = state
        for session in sessions where next.lastSeen[session.id] == nil {
            next.lastSeen[session.id] = session.updatedAt
        }
        next.baselines.insert(scopeKey)
        state = next
        snapshot?.scheduleWrite(next)
    }

    /// `sessionIsUnread`: activity newer than the operator's watermark.
    public static func isUnread(_ summary: SessionSummary, lastSeenAt: Int) -> Bool {
        summary.updatedAt > lastSeenAt
    }
}
