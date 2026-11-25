import HapiClient
import HapiProtocol
import Testing

@Suite("Chat history paging")
struct ChatHistoryPagingStateTests {
    @Test func exhaustionCanReviveButPausedNeedsExplicitRetry() {
        var state = ChatHistoryPagingState()
        let first = state.begin()!
        state.received(.stopped(.exhausted), generation: first)
        state.refreshAvailability(hasMore: true)
        #expect(state.phase == .idle)
        let second = state.begin()!
        state.received(.stopped(.cursorDidNotAdvance), generation: second)
        state.refreshAvailability(hasMore: true)
        #expect(state.phase == .paused)
    }
    @Test func pagesWaitForTheirLayoutAndDoNotNeedANewGesture() {
        var state = ChatHistoryPagingState()
        let first = state.begin()!
        let duplicateRequestRejected = state.begin() == nil
        #expect(duplicateRequestRejected)
        state.received(.applied(historyVersion: 3, hasMore: true, addedRenderableCount: 2), generation: first)
        let requestDuringLayoutRejected = state.begin() == nil
        #expect(requestDuringLayoutRejected)
        let staleLayoutIgnored = !state.laidOut(historyVersion: 2, madeProgress: true)
        #expect(staleLayoutIgnored)
        let layoutAccepted = state.laidOut(historyVersion: 3, madeProgress: true)
        #expect(layoutAccepted)
        let nextRequestStarted = state.begin() != nil
        #expect(nextRequestStarted)
    }

    @Test func retriesAreBoundedAndExplicitRetryResumes() {
        struct Failure: Error {}
        var state = ChatHistoryPagingState()
        for delay in [500, 1500] {
            let request = state.begin()!
            let delayMatches = state.received(.failed(Failure()), generation: request) == delay
            #expect(delayMatches)
            let requestDuringBackoffRejected = state.begin() == nil
            #expect(requestDuringBackoffRejected)
            let retryAccepted = state.retryElapsed(generation: request)
            #expect(retryAccepted)
        }
        let request = state.begin()!
        let noAutomaticRetry = state.received(.failed(Failure()), generation: request) == nil
        #expect(noAutomaticRetry)
        #expect(state.phase == .failed)
        state.resume()
        let manualRetryStarted = state.begin() != nil
        #expect(manualRetryStarted)
    }

    @Test func nonRenderingPagesPauseWithoutClaimingExhaustion() {
        var state = ChatHistoryPagingState()
        for version in 1...3 {
            let request = state.begin()!
            state.received(.applied(historyVersion: version, hasMore: true, addedRenderableCount: 0), generation: request)
            let layoutAccepted = state.laidOut(historyVersion: version, madeProgress: false)
            #expect(layoutAccepted)
        }
        #expect(state.phase == .paused)
        state.resume()
        let explicitContinueStarted = state.begin() != nil
        #expect(explicitContinueStarted)
    }

    @Test func cancellationRejectsOldResponsesAndTimers() {
        var state = ChatHistoryPagingState()
        let old = state.begin()!
        state.cancel()
        let current = state.begin()!
        state.received(.applied(historyVersion: 99, hasMore: true, addedRenderableCount: 1), generation: old)
        let staleTimerIgnored = !state.retryElapsed(generation: old)
        #expect(staleTimerIgnored)
        #expect(state.generation == current)
        #expect(state.phase == .loading)
        let gate = ChatHistoryRequestGate()
        gate.invalidate()
        #expect(!gate.allowsApply)
    }
}
