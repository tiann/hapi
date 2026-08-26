import Foundation
import HapiProtocol

/// Fan-out from an SSE subscription's event stream to the stores — the
/// session-list half of the event routing, mirroring the global-scope rules
/// of `web/src/hooks/useSSE.ts` via the Android port
/// (`SyncEventRouter` + `StoreSyncTargets`):
///
/// - session lifecycle events → `SessionListStoring.applySessionEvent`;
/// - `machine-updated` → `MachineListStoring.applyMachineEvent`;
/// - global-scope message-stream events refresh the session list where the
///   web invalidates it (`messages-invalidated`, `messages-consumed`,
///   `message-cancelled`, `scheduled-matured`, and a `message-received`
///   carrying `scheduledAt` — they all move the hub-computed
///   scheduled/queued fields the client cannot derive);
/// - `toast` → the injected callback;
/// - a `gap` handshake verdict triggers the full REST resync (session list +
///   cached details + machines); `ok` means the hub replays every missed
///   event right after the handshake, so the REST resync is skipped;
/// - `heartbeat`/`connection-changed`/unknown types are engine/no-op
///   territory here.
///
/// The app's `HubSession` owns one of these per hub and calls
/// ``handleHandshake(resume:)`` / ``route(_:scope:)`` from its SSE consume
/// loop. Since M2f the app's per-chat `ChatSession` reuses this router for
/// the session-scope pipe's non-message events and delivers the
/// message-stream family to the open `MessageWindowController` itself —
/// awaiting each ingest from its single consume task, which is what
/// preserves SSE arrival order into the window actor (the role the Android
/// port's `StoreSyncTargets` channel plays).
@MainActor
public struct SyncEventRouter {
    private let sessions: any SessionListStoring
    private let machines: any MachineListStoring
    private let onToast: @MainActor (ToastPayload) -> Void

    public init(
        sessions: any SessionListStoring,
        machines: any MachineListStoring,
        onToast: @escaping @MainActor (ToastPayload) -> Void = { _ in }
    ) {
        self.sessions = sessions
        self.machines = machines
        self.onToast = onToast
    }

    /// `resume == .ok` skips the resync (the replay that follows covers every
    /// missed event); `.gap` — or, defensively, anything else — triggers the
    /// full refetch. (`SSEClient` already maps an absent wire verdict to
    /// `.gap`, per the contract's absence rule.)
    public func handleHandshake(resume: ResumeVerdict?) {
        guard resume != .ok else { return }
        requestFullResync()
    }

    /// Full REST resync: session list + cached details, then machines.
    /// Failures are swallowed — offline keeps the snapshot state and the
    /// next reconnect retries.
    public func requestFullResync() {
        let sessions = self.sessions
        let machines = self.machines
        Task { @MainActor in
            try? await sessions.fullResync()
            try? await machines.refresh()
        }
    }

    /// Routes one decoded `SyncEvent` from the subscription identified by
    /// `scope` (the dual-subscription model: the global pipe drives the
    /// list; per-chat `.session` pipes arrive with M2f and their
    /// message-stream events belong to the message window, not the list).
    public func route(_ event: SyncEvent, scope: SSEScope = .global) {
        switch event {
        case .sessionAdded, .sessionUpdated, .sessionRemoved, .sessionEnded:
            sessions.applySessionEvent(event)

        case .machineUpdated(_, let machineId, let data):
            machines.applyMachineEvent(machineId: machineId, data: data)

        case .messagesInvalidated, .messagesConsumed, .messagesIndeterminate, .messagesRequeued, .messageCancelled, .scheduledMatured:
            guard scope == .global else { return }
            sessions.scheduleRefresh()

        case .messageReceived(_, _, let message):
            guard scope == .global else { return }
            if message.scheduledAt != nil {
                sessions.scheduleRefresh()
            }

        case .toast(_, let payload):
            onToast(payload)

        case .heartbeat, .connectionChanged, .unknown:
            // Heartbeats feed the SSE watchdog; the handshake surfaces
            // through `handleHandshake`; unknown types are forward-compat
            // no-ops.
            break
        }
    }
}
