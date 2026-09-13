import Testing
@testable import HapiUI

@Suite("Transcript latest-button proximity")
struct TranscriptBottomProximityTests {
    @Test func smallDeparturesRemainHiddenUntilTheShowThreshold() {
        var state = TranscriptBottomProximity()
        #expect(!state.isAwayFromBottom)
        for distance in [-30.0, 0, 1, 2, 24, 50, 79.9] {
            state.update(bottomDistance: distance, followsTail: false)
            #expect(!state.isAwayFromBottom)
        }
        state.update(bottomDistance: 80, followsTail: false)
        #expect(state.isAwayFromBottom)
    }

    @Test func visibilityPersistsBetweenThresholdsAndHidesAtTheLowerBoundary() {
        var state = TranscriptBottomProximity()
        state.update(bottomDistance: 100, followsTail: false)
        for distance in [80.0, 79, 81, 40, 24.1] {
            state.update(bottomDistance: distance, followsTail: false)
            #expect(state.isAwayFromBottom)
        }
        state.update(bottomDistance: 24, followsTail: false)
        #expect(!state.isAwayFromBottom)
        for distance in [25.0, 23, 25, 50, 79.9] {
            state.update(bottomDistance: distance, followsTail: false)
            #expect(!state.isAwayFromBottom)
        }
        state.update(bottomDistance: 80, followsTail: false)
        #expect(state.isAwayFromBottom)
        state.update(bottomDistance: -20, followsTail: false)
        #expect(!state.isAwayFromBottom)
    }

    @Test func followingResetsVisibilityEvenBeforeBottomLayoutCatchesUp() {
        var state = TranscriptBottomProximity()
        state.update(bottomDistance: 200, followsTail: false)
        #expect(state.isAwayFromBottom)
        state.update(bottomDistance: 200, followsTail: true)
        #expect(!state.isAwayFromBottom)
        state.update(bottomDistance: 50, followsTail: false)
        #expect(!state.isAwayFromBottom)
    }
}
