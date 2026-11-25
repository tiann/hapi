import Foundation

/// Synchronously invalidated by reader input; checked inside the window
/// actor's before-apply callback. Never reaches back into UI from that actor.
public final class ChatHistoryRequestGate: @unchecked Sendable {
    private let lock = NSLock()
    private var valid = true

    public init() {}

    public var allowsApply: Bool { lock.withLock { valid } }
    public func invalidate() { lock.withLock { valid = false } }
}
