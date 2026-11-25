/// Separates the reader's tail-following intent from the measured bottom
/// edge. Media can resize without changing messages; that must request a
/// correction, not turn the reader into a history reader.
///
/// A mounted transcript owns one instance. Its initial request positions a
/// fresh scroll view; a nil request cancels any queued correction.
public struct ChatTailFollowState: Equatable, Sendable {
    public private(set) var isFollowingTail = true
    public private(set) var isDragging = false

    private var contentHeight: Double?
    private var viewportHeight: Double?
    private var awaitingBottom = true
    private var revision = 0

    public init() {}

    /// Key for the view's deferred scroll task. Repeated offset observations
    /// do not change it; reaching the bottom or starting a drag cancels it.
    public var scrollRequest: Int? {
        isFollowingTail && !isDragging && awaitingBottom ? revision : nil
    }

    public mutating func layoutChanged(
        contentHeight: Double,
        viewportHeight: Double,
        isAtBottom: Bool
    ) {
        let resized = self.contentHeight != contentHeight || self.viewportHeight != viewportHeight
        self.contentHeight = contentHeight
        self.viewportHeight = viewportHeight

        guard !isDragging else { return }
        if isAtBottom {
            isFollowingTail = true
            awaitingBottom = false
        } else if resized && isFollowingTail {
            requestBottom()
        } else if !awaitingBottom {
            // An offset-only departure also covers accessibility scrolling,
            // which need not deliver the view's drag gesture callbacks.
            isFollowingTail = false
        }
    }

    public mutating func beginDragging() {
        isDragging = true
        isFollowingTail = false
        awaitingBottom = false
    }

    public mutating func endDragging(isAtBottom: Bool) {
        guard isDragging else { return }
        isDragging = false
        isFollowingTail = isAtBottom
        awaitingBottom = false
    }

    public mutating func followTail() {
        isFollowingTail = true
        requestBottom()
    }

    private mutating func requestBottom() {
        revision += 1
        awaitingBottom = true
    }
}
