import Foundation
import HapiClient
import HapiProtocol
import Testing

/// Transcribes the Android reference suite (`StoreSyncTargetsTest.kt`):
/// routing rules of the SyncEvent fan-out, verified against fake stores
/// through the `SessionListStoring`/`MachineListStoring` seams.
@MainActor
private final class FakeSessionListStore: SessionListStoring {
    var sessions: [SessionSummary] = []
    var calls: [String] = []

    func refresh() async throws { calls.append("refresh") }
    func scheduleRefresh() { calls.append("scheduleRefresh") }
    func fullResync() async throws { calls.append("fullResync") }

    func applySessionEvent(_ event: SyncEvent) {
        let label: String
        switch event {
        case .sessionAdded: label = "sessionAdded"
        case .sessionUpdated: label = "sessionUpdated"
        case .sessionRemoved: label = "sessionRemoved"
        case .sessionEnded: label = "sessionEnded"
        default: label = "unexpected"
        }
        calls.append("session:\(label)")
    }

    func setPinMode(sessionId: String, mode: SessionPinMode) async throws {
        calls.append("pin:\(sessionId):\(mode.rawValue)")
    }

    func archiveSession(sessionId: String) async throws {
        calls.append("archive:\(sessionId)")
    }
}

@MainActor
private final class FakeMachineListStore: MachineListStoring {
    var machines: [Machine] = []
    var calls: [String] = []

    func refresh() async throws { calls.append("refresh") }
    func scheduleRefresh() { calls.append("scheduleRefresh") }

    func applyMachineEvent(machineId: String, data: MachineUpdatedData?) {
        calls.append("machine:\(machineId)")
    }
}

@MainActor
@Suite("SyncEventRouter")
struct SyncEventRoutingTests {

    @Test func sessionLifecycleEventsReachTheSessionStore() throws {
        let sessions = FakeSessionListStore()
        let router = SyncEventRouter(sessions: sessions, machines: FakeMachineListStore())
        router.route(try decodeSyncEvent("{\"type\":\"session-updated\",\"sessionId\":\"s1\",\"data\":{\"active\":true}}"))
        router.route(try decodeSyncEvent("{\"type\":\"session-removed\",\"sessionId\":\"s1\"}"))
        router.route(try decodeSyncEvent("{\"type\":\"session-ended\",\"sessionId\":\"s1\",\"reason\":\"completed\"}"))
        #expect(sessions.calls == ["session:sessionUpdated", "session:sessionRemoved", "session:sessionEnded"])
    }

    @Test func machineUpdatedReachesTheMachineStore() throws {
        let machines = FakeMachineListStore()
        let router = SyncEventRouter(sessions: FakeSessionListStore(), machines: machines)
        router.route(try decodeSyncEvent("{\"type\":\"machine-updated\",\"machineId\":\"m1\",\"data\":null}"))
        #expect(machines.calls == ["machine:m1"])
    }

    @Test func globalMessageStreamEventsRefreshTheSessionList() throws {
        let sessions = FakeSessionListStore()
        let router = SyncEventRouter(sessions: sessions, machines: FakeMachineListStore())
        router.route(try decodeSyncEvent("{\"type\":\"messages-invalidated\",\"sessionId\":\"s1\"}"))
        router.route(try decodeSyncEvent("{\"type\":\"messages-consumed\",\"sessionId\":\"s1\",\"localIds\":[\"l1\"],\"invokedAt\":1}"))
        router.route(try decodeSyncEvent("{\"type\":\"message-cancelled\",\"sessionId\":\"s1\",\"messageId\":\"m1\"}"))
        router.route(try decodeSyncEvent("{\"type\":\"scheduled-matured\",\"sessionId\":\"s1\"}"))
        #expect(sessions.calls == Array(repeating: "scheduleRefresh", count: 4))
    }

    @Test func messageReceivedRefreshesTheListOnlyWhenScheduled() throws {
        let sessions = FakeSessionListStore()
        let router = SyncEventRouter(sessions: sessions, machines: FakeMachineListStore())
        router.route(try decodeSyncEvent(
            "{\"type\":\"message-received\",\"sessionId\":\"s1\",\"message\":{\"id\":\"m1\",\"createdAt\":1}}"
        ))
        #expect(sessions.calls == [])
        router.route(try decodeSyncEvent(
            "{\"type\":\"message-received\",\"sessionId\":\"s1\",\"message\":{\"id\":\"m2\",\"createdAt\":1,\"scheduledAt\":99}}"
        ))
        #expect(sessions.calls == ["scheduleRefresh"])
    }

    @Test func sessionScopedMessageEventsDoNotTouchTheList() throws {
        // Window territory (M2f) — the per-chat pipe must not churn the list.
        let sessions = FakeSessionListStore()
        let router = SyncEventRouter(sessions: sessions, machines: FakeMachineListStore())
        router.route(
            try decodeSyncEvent("{\"type\":\"messages-invalidated\",\"sessionId\":\"s1\"}"),
            scope: .session("s1")
        )
        #expect(sessions.calls == [])
    }

    @Test func gapHandshakeTriggersTheFullResync() async throws {
        let sessions = FakeSessionListStore()
        let machines = FakeMachineListStore()
        let router = SyncEventRouter(sessions: sessions, machines: machines)
        router.handleHandshake(resume: .gap)
        try await expectEventually { sessions.calls == ["fullResync"] && machines.calls == ["refresh"] }
    }

    @Test func okHandshakeSkipsTheResync() async throws {
        let sessions = FakeSessionListStore()
        let machines = FakeMachineListStore()
        let router = SyncEventRouter(sessions: sessions, machines: machines)
        router.handleHandshake(resume: .ok)
        // Give a spawned (unexpected) resync task room to run.
        try await Task.sleep(for: .milliseconds(50))
        #expect(sessions.calls == [])
        #expect(machines.calls == [])
    }

    @Test func toastEventsReachTheCallback() throws {
        final class ToastBox {
            var toasts: [ToastPayload] = []
        }
        let box = ToastBox()
        let router = SyncEventRouter(
            sessions: FakeSessionListStore(),
            machines: FakeMachineListStore(),
            onToast: { box.toasts.append($0) }
        )
        router.route(try decodeSyncEvent(
            "{\"type\":\"toast\",\"data\":{\"title\":\"t\",\"body\":\"b\",\"sessionId\":\"s1\",\"url\":\"/sessions/s1\"}}"
        ))
        #expect(box.toasts.count == 1)
        #expect(box.toasts.first?.title == "t")
    }
}
