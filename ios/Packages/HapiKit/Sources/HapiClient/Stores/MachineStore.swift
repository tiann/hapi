import Foundation
import HapiProtocol
import Observation

/// Machine-list store surface (production impl ``MachineStore``; tests fake
/// it — same interface extraction as the Android port's `MachineListStore`).
@MainActor
public protocol MachineListStoring: AnyObject {
    /// API order preserved (the reference never re-sorts machines).
    var machines: [Machine] { get }

    /// `GET /api/machines`. Throws on failure.
    func refresh() async throws

    /// Coalesced fire-and-forget ``refresh()``.
    func scheduleRefresh()

    /// Routes the `machine-updated` SSE event's already-discriminated data.
    func applyMachineEvent(machineId: String, data: MachineUpdatedData?)
}

/// Online machines for one hub. `machine-updated` handling is the exact web
/// decision tree (`web/src/hooks/useSSE.ts` +
/// `sse.md#syncevent-union-13-types`), which `MachineUpdatedData`'s decoder
/// has already discriminated:
///
/// 1. full `Machine` → upsert — except `active: false`, which removes;
/// 2. explicit `null` data (`.removed`) → machine removed;
/// 3. strict `MachinePatch` with `active: false` → remove; any other patch
///    carries too little to upsert → refetch (an empty `{}` decodes as an
///    all-nil patch here, which lands on the same refetch branch the web's
///    non-empty parse rule produces);
/// 4. absent (`nil`) / unrecognized data → refetch.
@MainActor @Observable
public final class MachineStore: MachineListStoring {
    public private(set) var machines: [Machine]

    /// Bumps on every real list mutation (see `SessionListStore.listRevision`).
    public private(set) var listRevision = 0

    @ObservationIgnored private let api: APIClient
    @ObservationIgnored private let snapshot: DiskCache<[Machine]>?
    @ObservationIgnored private let refreshBatch: Duration
    @ObservationIgnored private var refreshQueued = false
    @ObservationIgnored private var refreshGeneration = 0
    @ObservationIgnored private var lastAppliedRefresh = 0

    public init(
        api: APIClient,
        snapshotDirectory: URL? = nil,
        refreshBatch: Duration = .milliseconds(16)
    ) {
        let cache = snapshotDirectory.map {
            DiskCache<[Machine]>(directory: $0, filename: "machines.json")
        }
        self.api = api
        self.snapshot = cache
        self.refreshBatch = refreshBatch
        self.machines = cache?.load() ?? []
    }

    /// Forces the debounced snapshot to disk (app background / tests).
    public func flushPersistence() async {
        await snapshot?.flush()
    }

    public func refresh() async throws {
        refreshGeneration += 1
        let generation = refreshGeneration
        let list = try await api.listMachines()
        guard generation > lastAppliedRefresh else { return }
        lastAppliedRefresh = generation
        setMachines(list)
    }

    public func scheduleRefresh() {
        guard !refreshQueued else { return }
        refreshQueued = true
        Task { [refreshBatch] in
            try? await Task.sleep(for: refreshBatch)
            self.refreshQueued = false
            // Retried by the next event or manual refresh.
            try? await self.refresh()
        }
    }

    public func applyMachineEvent(machineId: String, data: MachineUpdatedData?) {
        switch data {
        case .machine(let machine):
            upsert(machine)
        case .removed:
            remove(machineId)
        case .patch(let patch):
            if patch.active == false {
                remove(machineId)
            } else {
                scheduleRefresh()
            }
        case .unrecognized, nil:
            scheduleRefresh()
        }
    }

    // MARK: - Internal

    /// Web `upsertMachine`: inactive rows are dropped, order preserved.
    private func upsert(_ machine: Machine) {
        var list = machines
        let index = list.firstIndex { $0.id == machine.id }
        if !machine.active {
            guard let index else { return }
            list.remove(at: index)
        } else if let index {
            list[index] = machine
        } else {
            list.append(machine)
        }
        setMachines(list)
    }

    private func remove(_ machineId: String) {
        let next = machines.filter { $0.id != machineId }
        guard next.count != machines.count else { return }
        setMachines(next)
    }

    private func setMachines(_ next: [Machine]) {
        machines = next
        listRevision += 1
        snapshot?.scheduleWrite(next)
    }
}
