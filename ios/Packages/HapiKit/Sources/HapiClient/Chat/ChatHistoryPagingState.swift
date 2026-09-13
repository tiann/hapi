import HapiProtocol

/// One pagination run includes its first rendered layout, not just the HTTP
/// request. Geometry may submit demand repeatedly; only an idle run starts.
/// Owned by the chat's main-thread coordinator. No timers or UI dependencies.
public struct ChatHistoryPagingState: Equatable, Sendable {
    public enum Phase: Equatable, Sendable {
        case idle, loading, awaitingLayout(Int), retrying, failed, paused, exhausted
    }

    public private(set) var phase: Phase = .idle
    public private(set) var generation = 0
    public private(set) var failures = 0
    public private(set) var pagesWithoutProgress = 0

    public init() {}

    public mutating func begin() -> Int? {
        guard phase == .idle else { return nil }
        generation += 1
        phase = .loading
        return generation
    }

    /// Returns the bounded retry delay, in milliseconds, if one is needed.
    @discardableResult
    public mutating func received(_ result: OlderLoadOutcome, generation: Int) -> Int? {
        guard self.generation == generation, phase == .loading else { return nil }
        switch result {
        case .applied(let version, _, _):
            phase = .awaitingLayout(version)
            failures = 0
        case .failed:
            failures += 1
            phase = failures <= 2 ? .retrying : .failed
            return failures == 1 ? 500 : failures == 2 ? 1500 : nil
        case .stopped(let reason):
            switch reason {
            case .exhausted: phase = .exhausted
            case .cursorDidNotAdvance: phase = .paused
            default: phase = .idle
            }
        }
        return nil
    }

    @discardableResult
    public mutating func retryElapsed(generation: Int) -> Bool {
        guard self.generation == generation, phase == .retrying else { return false }
        phase = .idle
        return true
    }

    /// Also called for pages with no new cells: their version still needs an
    /// acknowledgement, otherwise hidden-only pages deadlock the loader.
    @discardableResult
    public mutating func laidOut(historyVersion: Int, madeProgress: Bool) -> Bool {
        guard case .awaitingLayout(let target) = phase, historyVersion >= target else { return false }
        pagesWithoutProgress = madeProgress ? 0 : pagesWithoutProgress + 1
        phase = pagesWithoutProgress >= 3 ? .paused : .idle
        return true
    }

    public mutating func resume() {
        guard phase == .failed || phase == .paused else { return }
        failures = 0
        pagesWithoutProgress = 0
        phase = .idle
    }

    /// Tail-window trimming can make older pages available again. Errors and
    /// no-progress pauses still require an explicit reader action.
    public mutating func refreshAvailability(hasMore: Bool) {
        if hasMore, phase == .exhausted { phase = .idle }
    }

    public mutating func cancel() {
        generation += 1
        phase = .idle
        failures = 0
        pagesWithoutProgress = 0
    }
}
