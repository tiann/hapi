import Foundation
import HapiClient
import HapiProtocol
import Testing

/// Transcribes the Android reference suite (`MachineStoreTest.kt`): the exact
/// `machine-updated` decision tree plus refresh and the snapshot round-trip.
@MainActor
@Suite("MachineStore")
struct MachineStoreTests {

    private func makeStore(
        snapshotDirectory: URL? = nil
    ) throws -> (performer: RecordingPerformer, store: MachineStore) {
        let performer = RecordingPerformer()
        let api = try makeStoreAPIClient(performer: performer)
        let store = MachineStore(
            api: api,
            snapshotDirectory: snapshotDirectory,
            refreshBatch: .milliseconds(1)
        )
        return (performer, store)
    }

    @Test func refreshReplacesTheListInAPIOrder() async throws {
        let (performer, store) = try makeStore()
        await performer.enqueue(json: try machinesResponseJSON(storeMachine("m2"), storeMachine("m1")))
        try await store.refresh()
        #expect(store.machines.map(\.id) == ["m2", "m1"])
    }

    @Test func fullMachinePayloadUpsertsInPlaceAndAppendsNewOnes() async throws {
        let (performer, store) = try makeStore()
        await performer.enqueue(json: try machinesResponseJSON(storeMachine("m1"), storeMachine("m2")))
        try await store.refresh()

        store.applyMachineEvent(
            machineId: "m1",
            data: try machineUpdatedData("m1", dataJSON: machineJSON(storeMachine("m1", host: "renamed")))
        )
        #expect(store.machines.first?.metadata?.host == "renamed")
        #expect(store.machines.map(\.id) == ["m1", "m2"])

        store.applyMachineEvent(
            machineId: "m3",
            data: try machineUpdatedData("m3", dataJSON: machineJSON(storeMachine("m3")))
        )
        #expect(store.machines.map(\.id) == ["m1", "m2", "m3"])
    }

    @Test func fullMachinePayloadWithActiveFalseRemovesTheRow() async throws {
        let (performer, store) = try makeStore()
        await performer.enqueue(json: try machinesResponseJSON(storeMachine("m1"), storeMachine("m2")))
        try await store.refresh()
        store.applyMachineEvent(
            machineId: "m1",
            data: try machineUpdatedData("m1", dataJSON: machineJSON(storeMachine("m1", active: false)))
        )
        #expect(store.machines.map(\.id) == ["m2"])
    }

    @Test func nullDataRemovesTheMachine() async throws {
        let (performer, store) = try makeStore()
        await performer.enqueue(json: try machinesResponseJSON(storeMachine("m1"), storeMachine("m2")))
        try await store.refresh()
        store.applyMachineEvent(
            machineId: "m1",
            data: try machineUpdatedData("m1", dataJSON: "null")
        )
        #expect(store.machines.map(\.id) == ["m2"])
    }

    @Test func patchWithActiveFalseRemovesOtherPatchesRefetch() async throws {
        let (performer, store) = try makeStore()
        await performer.enqueue(json: try machinesResponseJSON(storeMachine("m1"), storeMachine("m2")))
        try await store.refresh()

        store.applyMachineEvent(
            machineId: "m1",
            data: try machineUpdatedData("m1", dataJSON: "{\"active\":false}")
        )
        #expect(store.machines.map(\.id) == ["m2"])

        // activeAt-only patch carries too little to upsert → refetch.
        await performer.enqueue(json: try machinesResponseJSON(storeMachine("m2"), storeMachine("m3")))
        store.applyMachineEvent(
            machineId: "m2",
            data: try machineUpdatedData("m2", dataJSON: "{\"activeAt\":123}")
        )
        try await expectEventually { store.machines.map(\.id) == ["m2", "m3"] }
    }

    @Test func absentDataRefetchesMachines() async throws {
        let (performer, store) = try makeStore()
        await performer.enqueue(json: try machinesResponseJSON(storeMachine("m1")))
        store.applyMachineEvent(
            machineId: "m1",
            data: try machineUpdatedData("m1", dataJSON: nil)
        )
        try await expectEventually { store.machines.map(\.id) == ["m1"] }
    }

    @Test func machinesRoundTripThroughTheSnapshot() async throws {
        let directory = makeTempDirectory()
        let (performer, store) = try makeStore(snapshotDirectory: directory)
        await performer.enqueue(json: try machinesResponseJSON(storeMachine("m1")))
        try await store.refresh()
        await store.flushPersistence()

        let (_, cold) = try makeStore(snapshotDirectory: directory)
        #expect(cold.machines.map(\.id) == ["m1"])
    }
}
