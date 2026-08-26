import Foundation

/// Normative SSE timing constants, in milliseconds.
///
/// Values come from `docs/api/client-contract/sse.md` ("Reconnect policy")
/// and the web reference client (`web/src/hooks/useSSE.ts`).
public enum SSETimings {
    /// The hub emits a heartbeat frame every 30 s (informational).
    public static let heartbeatIntervalMs = 30_000
    /// No frames of any kind for 90 s ⇒ tear down and reconnect.
    public static let stalenessThresholdMs = 90_000
    /// On app-foreground, reconnect immediately when the last frame is older
    /// than this. One missed heartbeat interval after an OS suspend is
    /// already enough to distrust the socket (no FIN/RST ever surfaces).
    public static let foregroundResumeStalenessMs = 45_000
    /// Staleness check interval. Checks are skipped while suspended.
    public static let watchdogTickMs = 10_000
    /// An attempt that has not reached OPEN within 10 s is likely hung on a
    /// dead pooled socket — abandon it and retry on a fresh connection.
    public static let connectTimeoutMs = 10_000
}

/// Pure backoff schedule for SSE reconnects.
///
/// Delay for attempt `n` (0-based, reset to 0 on every successful open):
///
/// - attempt 0 → 0 ms (the first retry is immediate; backoff is for
///   *repeated* failures, not the initial recovery),
/// - attempt n ≥ 1 → `min(cap, base × 2^(n-1))`,
/// - cap is 30 s, widening to 300 s once `n ≥ 8` (a hub that stays
///   unreachable is usually down for hours, and every retry through a relay
///   costs a TLS handshake),
/// - plus uniform jitter of 0–500 ms on every delay, immediate ones included.
///
/// Jitter is injectable: the generic `delayMs(forAttempt:using:)` draws from
/// any `RandomNumberGenerator` so tests can seed it, and callers that manage
/// randomness themselves can add `exponentialDelayMs(forAttempt:)` + their
/// own draw from `jitterRangeMs` (this is what `SSEClient` does).
public struct ReconnectPolicy: Equatable, Sendable {
    public var baseDelayMs: Int
    public var maxDelayMs: Int
    public var slowMaxDelayMs: Int
    public var slowAfterAttempts: Int
    public var jitterRangeMs: ClosedRange<Int>

    public init(
        baseDelayMs: Int = 1_000,
        maxDelayMs: Int = 30_000,
        slowMaxDelayMs: Int = 300_000,
        slowAfterAttempts: Int = 8,
        jitterRangeMs: ClosedRange<Int> = 0...500
    ) {
        self.baseDelayMs = baseDelayMs
        self.maxDelayMs = maxDelayMs
        self.slowMaxDelayMs = slowMaxDelayMs
        self.slowAfterAttempts = slowAfterAttempts
        self.jitterRangeMs = jitterRangeMs
    }

    /// The deterministic part of the schedule, without jitter.
    public func exponentialDelayMs(forAttempt attempt: Int) -> Int {
        guard attempt >= 1 else {
            return 0
        }
        let cap = attempt >= slowAfterAttempts ? slowMaxDelayMs : maxDelayMs
        // Clamp the exponent so the shift can never overflow; 2^30 × base is
        // already far past every cap.
        let exponent = min(attempt - 1, 30)
        return min(cap, baseDelayMs << exponent)
    }

    /// Full delay including a jitter draw from the supplied generator.
    public func delayMs<R: RandomNumberGenerator>(forAttempt attempt: Int, using rng: inout R) -> Int {
        exponentialDelayMs(forAttempt: attempt) + Int.random(in: jitterRangeMs, using: &rng)
    }
}
