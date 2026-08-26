import Foundation

/// State machine model for one session's message window — the faithful port
/// of the web reference `web/src/lib/message-window-store.ts` (its
/// `InternalState`), per `docs/api/client-contract/pagination.md`. The pure
/// transitions over this state live in ``MessageWindowLogic``; the async
/// orchestration (`HapiClient` `MessageWindowController`) drives them.
/// Structure and semantics mirror the Android reference port
/// (`android/core/protocol/.../window/MessageWindowState.kt`) one-to-one.

/// Windowing constants — normative, from the web reference.
public enum MessageWindowConstants {
    /// Max regular rows kept in tail mode (following the live bottom).
    public static let visibleWindowSize = 400
    /// Max regular rows kept in history mode (user scrolled back).
    public static let historyWindowSize = 600
    /// Temporary cap while an older page is being merged (prepend).
    public static let olderLoadWindowSize = 800
    /// Separate trim bucket for codex `agent-run-*` rows so background-agent
    /// traces don't evict chat.
    public static let agentRunWindowSize = 800
    /// Request size for every page fetch.
    public static let pageSize = 200
}

public enum MessageViewMode: String, Sendable {
    /// Following the live bottom; trims from the top.
    case tail
    /// Scrolled back; trims from the bottom and may force a latest reset.
    case history
}

/// Compound paging position `(at, seq)` where `at = invokedAt ?? createdAt` —
/// both halves always travel together (`pagination.md` "Position key").
public struct MessagePosition: Equatable, Comparable, Sendable {
    public let at: Int
    public let seq: Int

    public init(at: Int, seq: Int) {
        self.at = at
        self.seq = seq
    }

    public static func < (lhs: MessagePosition, rhs: MessagePosition) -> Bool {
        lhs.at != rhs.at ? lhs.at < rhs.at : lhs.seq < rhs.seq
    }
}

/// Outcome of one older-page load (`fetchOlderMessages` in the web).
public enum OlderLoadOutcome: Sendable {
    case applied(historyVersion: Int, hasMore: Bool, addedRenderableCount: Int)
    case stopped(StopReason)
    case failed(any Error)

    public enum StopReason: String, Sendable {
        case unavailable
        case busy
        case invalidated
        case epochReset = "epoch-reset"
        case exhausted
    }
}

/// The full window state. Field-for-field port of the web `InternalState`
/// (public `MessageWindowState` + internal cursor/generation fields), with
/// the two `(at, seq)` half-pairs folded into nullable ``MessagePosition``s —
/// the web only ever reads/writes them pairwise (`readPosition`).
///
/// `Equatable` compares ``WindowMessage`` rows by **identity** (see that
/// type) — deliberately mirroring the web's instance-based change detection,
/// not deep equality.
public struct MessageWindowState: Equatable, Sendable {
    public let sessionId: String
    /// Window rows in position order (queued rows re-merged after each trim).
    public var messages: [WindowMessage] = []
    /// Older history exists (server flag, or rows were trimmed away).
    public var hasMore: Bool = false
    /// min/max `seq` over ``messages`` — derived, kept for UI parity.
    public var oldestSeq: Int?
    public var newestSeq: Int?
    /// Cached server epoch; nil until the first page (or after invalidation).
    public var epoch: Int?
    public var isSyncingTail: Bool = false
    public var isLoadingMore: Bool = false
    public var warning: String?
    public var viewMode: MessageViewMode = .tail
    /// Bumped whenever the ``messages`` list instance changes.
    public var messagesVersion: Int = 0
    /// Bumped per applied older page (scroll-anchoring handle).
    public var historyVersion: Int = 0
    /// Bumped on tail-side content changes (auto-scroll handle).
    public var tailRevision: Int = 0
    /// Next `before` request position (web `oldestPositionAt/Seq`).
    public var oldestPosition: MessagePosition?
    /// Next `after` request position (web `newestPositionAt/Seq`).
    public var newestPosition: MessagePosition?
    /// Cursors are unusable — the next tail sync must fetch a fresh latest page.
    public var requiresLatestReset: Bool = false
    /// Re-activation with persisted state: fetch the current tail first.
    public var preferLatestOnActivation: Bool = false
    /// Invalidates in-flight tail syncs (compare-and-ignore).
    public var syncGeneration: Int = 0
    /// Invalidates in-flight older-page loads.
    public var olderGeneration: Int = 0

    public init(sessionId: String) {
        self.sessionId = sessionId
    }
}

/// Snapshot shape persisted per session (web `PersistedMessageWindowState`,
/// storage key `hapi:message-window:v2:`): messages + cursors + epoch only —
/// transient flags and counters never survive a restart.
///
/// Encoding writes every key (`null` for empty cursor halves), matching the
/// web's v2 JSON shape; decoding is lenient (absent keys fall back to the
/// defaults) so an older snapshot never throws.
public struct PersistedMessageWindow: Codable, Sendable {
    public var messages: [WindowMessage] = []
    public var hasMore: Bool = false
    public var oldestPositionAt: Int?
    public var oldestPositionSeq: Int?
    public var newestPositionAt: Int?
    public var newestPositionSeq: Int?
    public var epoch: Int?

    public init(
        messages: [WindowMessage] = [],
        hasMore: Bool = false,
        oldestPositionAt: Int? = nil,
        oldestPositionSeq: Int? = nil,
        newestPositionAt: Int? = nil,
        newestPositionSeq: Int? = nil,
        epoch: Int? = nil
    ) {
        self.messages = messages
        self.hasMore = hasMore
        self.oldestPositionAt = oldestPositionAt
        self.oldestPositionSeq = oldestPositionSeq
        self.newestPositionAt = newestPositionAt
        self.newestPositionSeq = newestPositionSeq
        self.epoch = epoch
    }

    private enum CodingKeys: String, CodingKey {
        case messages, hasMore
        case oldestPositionAt, oldestPositionSeq
        case newestPositionAt, newestPositionSeq
        case epoch
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        messages = try container.decodeIfPresent([WindowMessage].self, forKey: .messages) ?? []
        hasMore = try container.decodeIfPresent(Bool.self, forKey: .hasMore) ?? false
        oldestPositionAt = try container.decodeIfPresent(Int.self, forKey: .oldestPositionAt)
        oldestPositionSeq = try container.decodeIfPresent(Int.self, forKey: .oldestPositionSeq)
        newestPositionAt = try container.decodeIfPresent(Int.self, forKey: .newestPositionAt)
        newestPositionSeq = try container.decodeIfPresent(Int.self, forKey: .newestPositionSeq)
        epoch = try container.decodeIfPresent(Int.self, forKey: .epoch)
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(messages, forKey: .messages)
        try container.encode(hasMore, forKey: .hasMore)
        try container.encode(oldestPositionAt, forKey: .oldestPositionAt)
        try container.encode(oldestPositionSeq, forKey: .oldestPositionSeq)
        try container.encode(newestPositionAt, forKey: .newestPositionAt)
        try container.encode(newestPositionSeq, forKey: .newestPositionSeq)
        try container.encode(epoch, forKey: .epoch)
    }
}
