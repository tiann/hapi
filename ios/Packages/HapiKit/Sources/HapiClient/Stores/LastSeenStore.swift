import Foundation
import HapiProtocol
import Observation

/// Snapshot payload: watermarks + which scopes already got their baseline.
public struct LastSeenState: Codable, Equatable, Sendable {
    public var lastSeen: [String: Int]
    public var baselines: Set<String>
    /// Rows skipped because their legacy reply clock was not ready yet.
    public var pendingBaselines: [String: Set<String>]

    public init(
        lastSeen: [String: Int] = [:],
        baselines: Set<String> = [],
        pendingBaselines: [String: Set<String>] = [:]
    ) {
        self.lastSeen = lastSeen
        self.baselines = baselines
        self.pendingBaselines = pendingBaselines
    }
}

/// Per-session last-seen watermarks — port of `web/src/lib/sessionLastSeen.ts`
/// (localStorage → per-hub JSON snapshot) plus the unread derivation from
/// `web/src/lib/sessionAttention.ts`, mirroring the Android port
/// (`LastSeenStore`).
///
/// The watermark is the latest visible assistant reply the operator last had
/// on screen, falling back to `updatedAt` for sessions without a visible
/// reply. A session is **unread** when that same activity clock moves past it
/// (``isUnread(_:lastSeenAt:)``).
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
            // v2 changes the watermark from raw updatedAt to the reply/activity
            // clock. Do not load v1 values under the new meaning.
            DiskCache<LastSeenState>(directory: $0, filename: "last-seen-v2.json")
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
    /// current reply/activity clock, then never again for that scope.
    public func initializeBaseline(scopeKey: String, sessions: [SessionSummary]) {
        var next = state
        var pending = next.pendingBaselines[scopeKey] ?? []
        var pendingChanged = false
        for session in sessions {
            let replyClockReady = session.assistantReplyClockBackfilled != false
            if !state.baselines.contains(scopeKey) {
                if !replyClockReady {
                    if pending.insert(session.id).inserted { pendingChanged = true }
                    continue
                }
                if next.lastSeen[session.id] == nil {
                    next.lastSeen[session.id] = Self.seenTimestamp(session)
                }
                continue
            }

            guard replyClockReady, pending.remove(session.id) != nil else { continue }
            pendingChanged = true
            if next.lastSeen[session.id] == nil {
                next.lastSeen[session.id] = Self.seenTimestamp(session)
            }
        }
        if state.baselines.contains(scopeKey), !pendingChanged { return }
        next.baselines.insert(scopeKey)
        if pending.isEmpty {
            next.pendingBaselines.removeValue(forKey: scopeKey)
        } else {
            next.pendingBaselines[scopeKey] = pending
        }
        state = next
        snapshot?.scheduleWrite(next)
    }

    /// Timestamp shared by list recency, read state, and unread checks.
    public static func seenTimestamp(_ session: Session) -> Int {
        session.lastAssistantMessageAt ?? session.updatedAt
    }

    /// Timestamp shared by list recency, read state, and unread checks.
    public static func seenTimestamp(_ summary: SessionSummary) -> Int {
        summary.lastAssistantMessageAt ?? summary.updatedAt
    }

    /// `sessionIsUnread`: activity newer than the operator's watermark.
    public static func isUnread(_ summary: SessionSummary, lastSeenAt: Int) -> Bool {
        summary.assistantReplyClockBackfilled != false
            && seenTimestamp(summary) > lastSeenAt
    }
}
