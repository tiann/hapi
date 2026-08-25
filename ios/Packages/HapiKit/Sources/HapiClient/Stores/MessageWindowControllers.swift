import Foundation
import HapiProtocol

/// Per-hub registry of per-session ``MessageWindowController``s — the
/// analogue of the web module's session-keyed maps and the Android port's
/// `MessageWindowStores`. ``open(sessionId:)`` hydrates a cold session from
/// its disk snapshot (interrupted `sending` rows restore, stale snapshots
/// start flagged for a latest reset); ``seed(fromSessionId:toSessionId:)``
/// carries a window across a resume/reopen id change. Snapshot files
/// themselves are LRU-capped by ``WindowSnapshotStore``.
public actor MessageWindowControllers {
    private let provider: any MessagesProviding
    private let snapshots: WindowSnapshotStore?
    private var controllers: [String: MessageWindowController] = [:]

    public init(provider: any MessagesProviding, snapshots: WindowSnapshotStore? = nil) {
        self.provider = provider
        self.snapshots = snapshots
    }

    /// The session's controller, hydrating from its snapshot on first open.
    public func open(sessionId: String) -> MessageWindowController {
        if let existing = controllers[sessionId] {
            return existing
        }
        let hydrated = snapshots?.load(sessionId: sessionId).map {
            MessageWindowLogic.hydrate(sessionId: sessionId, persisted: $0)
        }
        let controller = MessageWindowController(
            sessionId: sessionId,
            provider: provider,
            snapshots: snapshots,
            initialState: hydrated
        )
        controllers[sessionId] = controller
        return controller
    }

    /// Already-open controller, if any (no hydration).
    public func peek(sessionId: String) -> MessageWindowController? {
        controllers[sessionId]
    }

    /// Web `seedMessageWindowFromSession` for resume/reopen id migration.
    public func seed(fromSessionId: String, toSessionId: String) async {
        guard !fromSessionId.isEmpty, !toSessionId.isEmpty, fromSessionId != toSessionId else {
            return
        }
        let source = open(sessionId: fromSessionId)
        let target = open(sessionId: toSessionId)
        await target.seedFrom(source)
    }

    /// Web `clearMessageWindow` (e.g. on `session-removed`).
    public func clear(sessionId: String) async {
        await controllers[sessionId]?.clear()
    }
}
