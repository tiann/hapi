import Dispatch
import Foundation

/// Minimal time source used by `SSEClient` for the connect timeout, the
/// staleness watchdog, and backoff sleeps.
///
/// Deliberately NOT the stdlib `Clock` protocol: tests need a manually
/// advanced clock whose `sleep` parks on a continuation until test code
/// moves time forward, and the stdlib protocol's associated types and
/// tolerance machinery buy nothing here.
public protocol SSEClock: Sendable {
    /// Current time in milliseconds on a monotonically increasing scale.
    /// Only ever used for differences; the origin is arbitrary.
    func nowMs() -> Int
    /// Suspends for `ms`. Must throw `CancellationError` promptly when the
    /// surrounding task is cancelled — the client relies on it to abort
    /// watchdog ticks and pending backoff sleeps.
    func sleep(ms: Int) async throws
}

/// Production clock: monotonic uptime + `Task.sleep`.
public struct SystemSSEClock: SSEClock {
    public init() {}

    public func nowMs() -> Int {
        Int(DispatchTime.now().uptimeNanoseconds / 1_000_000)
    }

    public func sleep(ms: Int) async throws {
        guard ms > 0 else { return }
        try await Task.sleep(nanoseconds: UInt64(ms) * 1_000_000)
    }
}
