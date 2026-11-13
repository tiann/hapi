import Foundation

/// Cursor block of `GET /api/sessions/:id/messages/:messageId/context`
/// (`MessageContextResponse['page']` in `shared/src/apiTypes.ts`): the bounded
/// context window carries no direction/limit/reset keys.
public struct MessageContextPage: Codable, Equatable, Sendable {
    public var epoch: Int
    public var nextBeforeSeq: Int?
    public var nextBeforeAt: Int?
    public var snapshotHeadSeq: Int?
    public var snapshotHeadAt: Int?
    public var hasMore: Bool

    public init(
        epoch: Int,
        nextBeforeSeq: Int? = nil,
        nextBeforeAt: Int? = nil,
        snapshotHeadSeq: Int? = nil,
        snapshotHeadAt: Int? = nil,
        hasMore: Bool
    ) {
        self.epoch = epoch
        self.nextBeforeSeq = nextBeforeSeq
        self.nextBeforeAt = nextBeforeAt
        self.snapshotHeadSeq = snapshotHeadSeq
        self.snapshotHeadAt = snapshotHeadAt
        self.hasMore = hasMore
    }
}

/// `GET /api/sessions/:id/messages/:messageId/context` — a bounded history
/// window centered on one message. The hub answers a bare JSON `null` when the
/// message does not resolve (web `MessageContextResponse | null`).
public struct MessageContextResponse: Codable, Equatable, Sendable {
    public var messages: [DecryptedMessage]
    public var targetMessageId: String
    public var page: MessageContextPage

    public init(
        messages: [DecryptedMessage],
        targetMessageId: String,
        page: MessageContextPage
    ) {
        self.messages = messages
        self.targetMessageId = targetMessageId
        self.page = page
    }
}