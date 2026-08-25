import Foundation

/// Cursor block of a `GET /api/sessions/:id/messages` response.
///
/// Mirrors `MessagesResponse['page']` (`shared/src/apiTypes.ts`); full cursor
/// semantics in `docs/api/client-contract/pagination.md`. Every cursor is a
/// `(seq, at)` pair — both halves travel together.
public struct MessagesPage: Codable, Equatable, Sendable {
    public enum Direction: String, Codable, Sendable {
        case latest
        case before
        case after
    }

    public var direction: Direction
    public var limit: Int
    /// Server's current epoch for this session; a mismatch on your next
    /// `after` request yields a `reset: true` latest page.
    public var epoch: Int
    /// `true` ⇒ discard the local window, this page replaces it.
    public var reset: Bool
    public var nextBeforeSeq: Int?
    public var nextBeforeAt: Int?
    public var nextAfterSeq: Int?
    public var nextAfterAt: Int?
    /// Newest position at snapshot time (inclusive catch-up bound).
    public var snapshotHeadSeq: Int?
    public var snapshotHeadAt: Int?
    /// More rows exist in the requested direction.
    public var hasMore: Bool

    public init(
        direction: Direction,
        limit: Int,
        epoch: Int,
        reset: Bool,
        nextBeforeSeq: Int? = nil,
        nextBeforeAt: Int? = nil,
        nextAfterSeq: Int? = nil,
        nextAfterAt: Int? = nil,
        snapshotHeadSeq: Int? = nil,
        snapshotHeadAt: Int? = nil,
        hasMore: Bool
    ) {
        self.direction = direction
        self.limit = limit
        self.epoch = epoch
        self.reset = reset
        self.nextBeforeSeq = nextBeforeSeq
        self.nextBeforeAt = nextBeforeAt
        self.nextAfterSeq = nextAfterSeq
        self.nextAfterAt = nextAfterAt
        self.snapshotHeadSeq = snapshotHeadSeq
        self.snapshotHeadAt = snapshotHeadAt
        self.hasMore = hasMore
    }
}

/// Envelope of `GET /api/sessions/:id/messages`.
public struct MessagesResponse: Codable, Equatable, Sendable {
    /// Ascending display order.
    public var messages: [DecryptedMessage]
    public var page: MessagesPage

    public init(messages: [DecryptedMessage], page: MessagesPage) {
        self.messages = messages
        self.page = page
    }
}
