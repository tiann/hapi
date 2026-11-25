import Observation

/// Keeps a reconnect notice stable across transport retry phases. Like the
/// web's useReconnectingState, short outages get a four-second grace period;
/// only a hub handshake (or lifecycle shutdown) clears an ongoing outage.
@MainActor @Observable
public final class SSEReconnectNotice {
    public private(set) var isVisible = false

    @ObservationIgnored private let clock: any SSEClock
    @ObservationIgnored private var pendingTask: Task<Void, Never>?

    public init(clock: any SSEClock = SystemSSEClock()) {
        self.clock = clock
    }

    deinit {
        pendingTask?.cancel()
    }

    /// Consume every transport state in order, rather than observing a UI
    /// snapshot: the first backoff can finish before SwiftUI renders it.
    public func update(_ state: SSEConnectionState) {
        switch state {
        case .backoff:
            guard pendingTask == nil, !isVisible else { return }
            let deadline = clock.nowMs() + 4_000
            let clock = clock
            pendingTask = Task { [weak self] in
                do {
                    try await clock.sleep(ms: max(0, deadline - clock.nowMs()))
                } catch {
                    return
                }
                guard !Task.isCancelled, let self else { return }
                self.isVisible = true
                self.pendingTask = nil
            }
        case .connecting:
            // Retrying is still part of the same outage. Do not hide the
            // notice or restart its grace period before the hub handshake.
            break
        case .connected, .idle, .suspended:
            pendingTask?.cancel()
            pendingTask = nil
            isVisible = false
        }
    }
}
