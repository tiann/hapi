import HapiClient
import Testing

@Suite("Chat tail-following intent")
struct ChatTailFollowStateTests {
    @Test func initialLayoutRequestsTheTailWithoutAMessageChange() throws {
        // A newly mounted transcript already contains a refetched window;
        // no subsequent model.blocks onChange is needed to position it.
        var state = ChatTailFollowState()
        state.layoutChanged(contentHeight: 4_000, viewportHeight: 600, isAtBottom: false)
        let initialRequest = try #require(state.scrollRequest)
        state.layoutChanged(contentHeight: 4_000, viewportHeight: 600, isAtBottom: false)
        #expect(state.scrollRequest == initialRequest)
        #expect(state.isFollowingTail)

        state.layoutChanged(contentHeight: 4_000, viewportHeight: 600, isAtBottom: true)
        #expect(state.scrollRequest == nil)
    }

    @Test func delayedImageGrowthKeepsFollowingSubsequentMessages() throws {
        var state = ChatTailFollowState()
        // A transcript ending in a 160 pt image placeholder is at the tail.
        state.layoutChanged(contentHeight: 2_160, viewportHeight: 600, isAtBottom: true)
        #expect(state.scrollRequest == nil)

        // Only the rendered image changes (to 360 pt); no message event.
        state.layoutChanged(contentHeight: 2_360, viewportHeight: 600, isAtBottom: false)
        let correction = try #require(state.scrollRequest)
        #expect(state.isFollowingTail)

        // Reobserving the pre-correction position cannot cancel or requeue it.
        state.layoutChanged(contentHeight: 2_360, viewportHeight: 600, isAtBottom: false)
        #expect(state.scrollRequest == correction)
        state.layoutChanged(contentHeight: 2_360, viewportHeight: 600, isAtBottom: true)
        #expect(state.scrollRequest == nil)
        #expect(state.isFollowingTail)

        state.layoutChanged(contentHeight: 2_460, viewportHeight: 600, isAtBottom: false)
        #expect(state.scrollRequest != nil)
        #expect(state.isFollowingTail)
    }

    @Test func mediaGrowthInHistoryDoesNotPullTheReaderToTheTail() {
        var state = ChatTailFollowState()
        state.layoutChanged(contentHeight: 2_160, viewportHeight: 600, isAtBottom: true)
        state.beginDragging()
        state.layoutChanged(contentHeight: 2_160, viewportHeight: 600, isAtBottom: false)
        state.endDragging(isAtBottom: false)

        state.layoutChanged(contentHeight: 2_360, viewportHeight: 600, isAtBottom: false)
        state.layoutChanged(contentHeight: 2_460, viewportHeight: 600, isAtBottom: false)
        #expect(!state.isFollowingTail)
        #expect(state.scrollRequest == nil)
    }

    @Test func readerDragCancelsAPendingResizeCorrection() {
        var state = ChatTailFollowState()
        state.layoutChanged(contentHeight: 2_160, viewportHeight: 600, isAtBottom: true)
        state.layoutChanged(contentHeight: 2_360, viewportHeight: 600, isAtBottom: false)
        #expect(state.scrollRequest != nil)

        state.beginDragging()
        #expect(state.scrollRequest == nil)
        // More content can arrive before the finger lifts.
        state.layoutChanged(contentHeight: 2_460, viewportHeight: 600, isAtBottom: false)
        state.endDragging(isAtBottom: false)
        #expect(!state.isFollowingTail)
        #expect(state.scrollRequest == nil)
    }

    @Test func scrollingWithoutADragCallbackStillLeavesAndRejoinsTheTail() {
        var state = ChatTailFollowState()
        state.layoutChanged(contentHeight: 2_160, viewportHeight: 600, isAtBottom: true)
        // Accessibility scrolling changes the offset without resizing rows.
        state.layoutChanged(contentHeight: 2_160, viewportHeight: 600, isAtBottom: false)
        #expect(!state.isFollowingTail)
        #expect(state.scrollRequest == nil)

        state.layoutChanged(contentHeight: 2_160, viewportHeight: 600, isAtBottom: true)
        #expect(state.isFollowingTail)
        state.layoutChanged(contentHeight: 2_360, viewportHeight: 600, isAtBottom: false)
        #expect(state.scrollRequest != nil)
    }

    @Test func viewportResizeUsesTheSameCorrectionWithoutIdleRepeats() {
        var state = ChatTailFollowState()
        state.layoutChanged(contentHeight: 2_160, viewportHeight: 600, isAtBottom: true)
        state.layoutChanged(contentHeight: 2_160, viewportHeight: 350, isAtBottom: false)
        #expect(state.isFollowingTail)
        #expect(state.scrollRequest != nil)

        state.layoutChanged(contentHeight: 2_160, viewportHeight: 350, isAtBottom: true)
        for _ in 0..<10 {
            state.layoutChanged(contentHeight: 2_160, viewportHeight: 350, isAtBottom: true)
            #expect(state.scrollRequest == nil)
        }
    }

    @Test func newMessagesButtonWaitsForBottomGeometryBeforeSettling() {
        var state = ChatTailFollowState()
        state.layoutChanged(contentHeight: 2_160, viewportHeight: 600, isAtBottom: true)
        state.layoutChanged(contentHeight: 2_160, viewportHeight: 600, isAtBottom: false)

        state.followTail()
        state.layoutChanged(contentHeight: 2_160, viewportHeight: 600, isAtBottom: false)
        #expect(state.isFollowingTail)
        #expect(state.scrollRequest != nil)
        state.layoutChanged(contentHeight: 2_160, viewportHeight: 600, isAtBottom: true)
        #expect(state.scrollRequest == nil)
    }
}
