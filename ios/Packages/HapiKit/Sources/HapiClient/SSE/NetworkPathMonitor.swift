import Foundation
#if canImport(Network)
import Network
#endif

/// A snapshot of the device's network path.
public struct NetworkPathUpdate: Equatable, Sendable {
    /// Whether the path can carry traffic (`NWPath.Status.satisfied`).
    public var isSatisfied: Bool
    /// Cellular / personal-hotspot style paths (informational).
    public var isExpensive: Bool

    public init(isSatisfied: Bool, isExpensive: Bool = false) {
        self.isSatisfied = isSatisfied
        self.isExpensive = isExpensive
    }
}

/// Source of network-path change notifications for `SSEClient`.
///
/// The stream's FIRST element is the baseline path reported on subscription
/// (NWPathMonitor always fires once immediately); every subsequent element is
/// an actual change. `SSEClient` skips the baseline and treats any later
/// update while connected as a transport error — the old socket is almost
/// certainly routed over a path that no longer exists, and reconnecting
/// immediately beats waiting for the 90 s staleness watchdog.
public protocol NetworkPathObserving: Sendable {
    func pathUpdates() -> AsyncStream<NetworkPathUpdate>
}

#if canImport(Network)
/// Production observer backed by `NWPathMonitor`.
public struct NWPathObserver: NetworkPathObserving {
    /// `NWPathMonitor` is not Sendable; it is confined to its own dispatch
    /// queue and only ever touched from the update handler / termination
    /// callback, so boxing it is safe.
    private final class MonitorBox: @unchecked Sendable {
        let monitor = NWPathMonitor()
    }

    public init() {}

    public func pathUpdates() -> AsyncStream<NetworkPathUpdate> {
        AsyncStream { continuation in
            let box = MonitorBox()
            box.monitor.pathUpdateHandler = { path in
                continuation.yield(NetworkPathUpdate(
                    isSatisfied: path.status == .satisfied,
                    isExpensive: path.isExpensive
                ))
            }
            box.monitor.start(queue: DispatchQueue(label: "run.hapi.sse.path-monitor"))
            continuation.onTermination = { _ in
                box.monitor.cancel()
            }
        }
    }
}
#endif
