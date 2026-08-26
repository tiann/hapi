import Foundation
import Testing
@testable import HapiClient

/// Deterministic seedable RNG (SplitMix64) for jitter tests.
struct SplitMix64: RandomNumberGenerator {
    private var state: UInt64

    init(seed: UInt64) {
        state = seed
    }

    mutating func next() -> UInt64 {
        state &+= 0x9E37_79B9_7F4A_7C15
        var z = state
        z = (z ^ (z >> 30)) &* 0xBF58_476D_1CE4_E5B9
        z = (z ^ (z >> 27)) &* 0x94D0_49BB_1331_11EB
        return z ^ (z >> 31)
    }
}

@Suite("Reconnect policy")
struct ReconnectPolicyTests {
    @Test func exactScheduleIncludingSlowCeiling() {
        let policy = ReconnectPolicy()
        let expected = [
            0: 0, // first retry is immediate (jitter only)
            1: 1_000,
            2: 2_000,
            3: 4_000,
            4: 8_000,
            5: 16_000,
            6: 30_000, // 32 s capped at 30 s
            7: 30_000, // 64 s capped at 30 s
            8: 128_000, // slow ceiling (300 s) active, exponential resumes
            9: 256_000,
            10: 300_000, // 512 s capped at the slow ceiling
            11: 300_000,
            25: 300_000,
        ]
        for (attempt, delay) in expected {
            #expect(policy.exponentialDelayMs(forAttempt: attempt) == delay, "attempt \(attempt)")
        }
    }

    @Test func hugeAttemptCountsDoNotOverflow() {
        let policy = ReconnectPolicy()
        #expect(policy.exponentialDelayMs(forAttempt: 100) == 300_000)
        #expect(policy.exponentialDelayMs(forAttempt: Int(Int32.max)) == 300_000)
    }

    @Test func negativeAttemptTreatedAsImmediate() {
        #expect(ReconnectPolicy().exponentialDelayMs(forAttempt: -3) == 0)
    }

    @Test func jitterStaysInsideBoundsWithSeededRNG() {
        let policy = ReconnectPolicy()
        var rng = SplitMix64(seed: 0xDEAD_BEEF)
        for attempt in 0...20 {
            for _ in 0..<50 {
                let base = policy.exponentialDelayMs(forAttempt: attempt)
                let full = policy.delayMs(forAttempt: attempt, using: &rng)
                let jitter = full - base
                #expect(jitter >= 0 && jitter <= 500, "attempt \(attempt) jitter \(jitter)")
            }
        }
    }

    @Test func seededJitterIsDeterministic() {
        let policy = ReconnectPolicy()
        var first = SplitMix64(seed: 42)
        var second = SplitMix64(seed: 42)
        let a = (0..<20).map { _ in policy.delayMs(forAttempt: 3, using: &first) }
        let b = (0..<20).map { _ in policy.delayMs(forAttempt: 3, using: &second) }
        #expect(a == b)
        // The draws themselves vary (jitter is actually applied).
        #expect(Set(a).count > 1)
    }

    @Test func timingConstantsMatchContract() {
        #expect(SSETimings.heartbeatIntervalMs == 30_000)
        #expect(SSETimings.stalenessThresholdMs == 90_000)
        #expect(SSETimings.foregroundResumeStalenessMs == 45_000)
        #expect(SSETimings.watchdogTickMs == 10_000)
        #expect(SSETimings.connectTimeoutMs == 10_000)
        let policy = ReconnectPolicy()
        #expect(policy.baseDelayMs == 1_000)
        #expect(policy.maxDelayMs == 30_000)
        #expect(policy.slowMaxDelayMs == 300_000)
        #expect(policy.slowAfterAttempts == 8)
        #expect(policy.jitterRangeMs == 0...500)
    }
}
