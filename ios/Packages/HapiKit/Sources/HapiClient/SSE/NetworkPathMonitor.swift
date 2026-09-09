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
    /// Interfaces carrying the path; preserves same-cost route changes.
    public var usedInterfaces: Set<String>
    /// Default gateways distinguish route changes on the same interface.
    public var gateways: Set<String>

    public init(
        isSatisfied: Bool,
        isExpensive: Bool = false,
        usedInterfaces: Set<String> = [],
        gateways: Set<String> = []
    ) {
        self.isSatisfied = isSatisfied
        self.isExpensive = isExpensive
        self.usedInterfaces = usedInterfaces
        self.gateways = gateways
    }

    func requiresReconnect(from previous: Self) -> Bool {
        isSatisfied != previous.isSatisfied
            || usedInterfaces != previous.usedInterfaces
            || gateways != previous.gateways
    }
}

/// Source of network-path change notifications for `SSEClient`.
///
/// The stream's FIRST element is the baseline path reported on subscription
/// (NWPathMonitor always fires once immediately). Later callbacks can repeat
/// the route or change only metadata such as cost; those must not tear down
/// a healthy stream. Reachability, interface, or gateway changes invalidate
/// the old route and reconnect without waiting for the staleness watchdog.
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
                    isExpensive: path.isExpensive,
                    usedInterfaces: Set(path.availableInterfaces
                        .filter { path.usesInterfaceType($0.type) }
                        .map(\.name)),
                    gateways: Set(path.gateways.map { String(describing: $0) })
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
