import Foundation
import HapiProtocol
import Observation

/// The session-facing store surface the routing/UI layers depend on
/// (``SessionListStore`` is the production implementation; tests substitute
/// fakes — the same interface extraction as the Android reference port's
/// `SessionListStore`).
@MainActor
public protocol SessionListStoring: AnyObject {
    /// Sorted with `sortSessionSummaries` (globalPinned > pinned > active >
    /// pending > recency).
    var sessions: [SessionSummary] { get }

    /// `GET /api/sessions` — replaces the list wholesale. Throws on failure.
    func refresh() async throws

    /// Coalesced fire-and-forget ``refresh()`` (the web's 16 ms invalidation
    /// batch).
    func scheduleRefresh()

    /// Handshake-`gap` recovery: list + every cached detail. Throws when the
    /// list refetch itself fails (per-detail failures are swallowed).
    func fullResync() async throws

    /// Routes `session-added/updated/removed/ended` into the caches.
    func applySessionEvent(_ event: SyncEvent)

    /// `PUT /sessions/:id/pin`, optimistic.
    func setPinMode(sessionId: String, mode: SessionPinMode) async throws

    /// `POST /sessions/:id/archive`, optimistic removal.
    func archiveSession(sessionId: String) async throws
}

/// Session list + detail cache for one hub, fed by the global SSE pipe
/// through ``applySessionEvent(_:)`` (see `SyncEventRouter`) and by REST
/// (``refresh()``). Mirrors the web reference's cache handlers in
/// `web/src/hooks/useSSE.ts` via the Android port (`SessionStore`):
///
/// - **Summaries** (the list): full-`Session` payloads upsert via
///   `SummaryPatching.toSessionSummary` (preserving the hub-computed
///   scheduled-message fields the projection cannot derive); `SessionPatch`
///   payloads apply through `SummaryPatching.applySessionSummaryPatch` —
///   versioned fields gated `>=` against the summary's own watermarks — and
///   keep-alive churn is dropped by `SummaryPatching.isRenderIrrelevantPatch`
///   before re-sorting.
/// - **Details** (per-id `Session`): populated only by
///   ``loadSessionDetail(_:)`` (a screen opened the session) or a
///   full-session SSE payload; patches apply with the **strict-`>`**
///   versioned gates of `applySessionDetailPatch`. Where the web queues a
///   React-Query detail invalidation for an uncached session, this store
///   does nothing — an uncached detail has no observers, and opening the
///   session fetches fresh.
/// - Unparseable/absent `session-updated` data falls back to REST
///   (`sse.md#versioned-patch-algorithm` step 3): list refetch + refetch of
///   the cached detail, if any. An *empty* `{}` patch counts as unparseable
///   too — the wire union decodes it as an all-nil `SessionPatch`, but the
///   web's `getSessionPatch` rejects empty objects, so it must take the REST
///   fallback here as well (the Android port bakes the same rule into
///   `SessionPatches.parse`).
///
/// The summary list persists as a debounced JSON snapshot per hub
/// (`sessions.json` under `snapshotDirectory`) for instant cold start;
/// details are memory-only (message windows own their snapshots in M2d).
@MainActor @Observable
public final class SessionListStore: SessionListStoring {
    /// Sorted list rows. Assigned only through ``setSessions(_:)`` so every
    /// real change also bumps ``listRevision`` and schedules a snapshot.
    public private(set) var sessions: [SessionSummary]

    /// All cached details, keyed by session id.
    public private(set) var details: [String: Session] = [:]

    /// Bumps on every real list mutation. Keep-alive suppression means an
    /// applied event does not necessarily move it — tests (and diff-averse
    /// UI) can use it where the reference asserts object identity.
    public private(set) var listRevision = 0

    /// Fired with the session id when a `session-updated` patch carries
    /// `scratchlistUpdatedAt` — a bare refetch trigger for that session's
    /// scratchlist (A-M4b); the timestamp is the signal, never data. Wired by
    /// `HubSession` to `ScratchlistStore.handleInvalidation` (the iOS seam
    /// for the Android `SessionStore.scratchlistInvalidations` flow).
    @ObservationIgnored public var onScratchlistInvalidation: (@MainActor (String) -> Void)?

    @ObservationIgnored private let api: APIClient
    @ObservationIgnored private let snapshot: DiskCache<[SessionSummary]>?
    @ObservationIgnored private let refreshBatch: Duration
    @ObservationIgnored private var refreshQueued = false
    /// Serializes overlapping refreshes "monotonic by start": a response is
    /// applied only when no later-started refresh already applied its own
    /// (the value-type equivalent of the reference's mutex ordering).
    @ObservationIgnored private var refreshGeneration = 0
    @ObservationIgnored private var lastAppliedRefresh = 0

    public init(
        api: APIClient,
        snapshotDirectory: URL? = nil,
        refreshBatch: Duration = .milliseconds(16)
    ) {
        let cache = snapshotDirectory.map {
            DiskCache<[SessionSummary]>(directory: $0, filename: "sessions.json")
        }
        self.api = api
        self.snapshot = cache
        self.refreshBatch = refreshBatch
        self.sessions = cache?.load().map(sortSessionSummaries) ?? []
    }

    // MARK: - Details

    public func detail(for sessionId: String) -> Session? {
        details[sessionId]
    }

    /// `GET /api/sessions/:id` into the detail cache (chat open / resync).
    @discardableResult
    public func loadSessionDetail(_ sessionId: String) async throws -> Session {
        let session = try await api.session(id: sessionId)
        details[sessionId] = session
        return session
    }

    /// Local optimistic mutation of a cached detail (A-M3ab composer/config
    /// flows — the Android `updateDetailLocal` twin). A missing detail is a
    /// no-op: optimistic writes only ever layer on loaded server truth, and
    /// error paths roll forward by refetching (`loadSessionDetail`) rather
    /// than restoring a possibly stale snapshot.
    public func updateDetailLocal(_ sessionId: String, _ transform: (inout Session) -> Void) {
        guard var session = details[sessionId] else { return }
        transform(&session)
        details[sessionId] = session
    }

    /// Drops a detail nobody observes anymore (chat closed).
    public func releaseDetail(_ sessionId: String) {
        details.removeValue(forKey: sessionId)
    }

    /// Forces the debounced snapshot to disk (app background / tests).
    public func flushPersistence() async {
        await snapshot?.flush()
    }

    // MARK: - Refresh

    public func refresh() async throws {
        refreshGeneration += 1
        let generation = refreshGeneration
        let list = try await api.listSessions()
        // A later-started refresh already applied fresher server truth.
        guard generation > lastAppliedRefresh else { return }
        lastAppliedRefresh = generation
        setSessions(sortSessionSummaries(list))
    }

    public func scheduleRefresh() {
        guard !refreshQueued else { return }
        refreshQueued = true
        Task { [refreshBatch] in
            try? await Task.sleep(for: refreshBatch)
            self.refreshQueued = false
            // Offline burst — the next SSE event or manual refresh retries.
            try? await self.refresh()
        }
    }

    public func fullResync() async throws {
        try await refresh()
        for sessionId in Array(details.keys) {
            // Keep a stale cached detail on failure; the session pipe
            // re-syncs it. (`_ =`: the refreshed detail is read from
            // `details`, not from this return value.)
            _ = try? await loadSessionDetail(sessionId)
        }
    }

    // MARK: - SSE events

    public func applySessionEvent(_ event: SyncEvent) {
        switch event {
        case .sessionAdded(_, let sessionId, let data),
             .sessionUpdated(_, let sessionId, let data):
            upsertOrPatch(sessionId: sessionId, data: data)
        case .sessionRemoved(_, let sessionId):
            details.removeValue(forKey: sessionId)
            let next = sessions.filter { $0.id != sessionId }
            if next.count != sessions.count {
                setSessions(next)
            }
        case .sessionEnded:
            // The reference has no session-ended cache branch: the state
            // change always arrives through the session-updated flow too.
            break
        default:
            break
        }
    }

    // MARK: - Pin / archive

    public func setPinMode(sessionId: String, mode: SessionPinMode) async throws {
        // Optimistic flip mirroring the hub flag mapping
        // (`hub/src/store/sessions.ts setSessionPinMode`): project → pinned,
        // global → globalPinned, none → neither.
        if let index = sessions.firstIndex(where: { $0.id == sessionId }) {
            var list = sessions
            list[index].pinned = mode == .project
            list[index].globalPinned = mode == .global
            setSessions(sortSessionSummaries(list))
        }
        do {
            try await api.setSessionPinMode(id: sessionId, mode: mode)
        } catch {
            // Roll forward to server truth instead of restoring a stale list
            // (SSE may have moved other rows since the optimistic write).
            scheduleRefresh()
            throw error
        }
    }

    public func archiveSession(sessionId: String) async throws {
        let removed = sessions.first { $0.id == sessionId }
        let filtered = sessions.filter { $0.id != sessionId }
        if filtered.count != sessions.count {
            setSessions(filtered)
        }
        do {
            try await api.archiveSession(id: sessionId)
        } catch {
            if let removed, !sessions.contains(where: { $0.id == sessionId }) {
                setSessions(sortSessionSummaries(sessions + [removed]))
            }
            throw error
        }
    }

    // MARK: - Internal

    private func upsertOrPatch(sessionId: String, data: SessionUpdatedData?) {
        // Order matters and mirrors the reference: full-session check first
        // (`isSessionRecord && data.id === sessionId`), then the strict
        // (non-empty) patch, then the REST fallback. `SessionUpdatedData`
        // already encodes the session-vs-strict-patch discrimination.
        switch data {
        case .session(let full) where full.id == sessionId:
            details[full.id] = full
            upsertSummary(full)
        case .patch(let patch) where patch != SessionPatch():
            patchDetail(sessionId: sessionId, patch: patch)
            if !patchSummary(sessionId: sessionId, patch: patch) {
                // Row not in the list yet (fresh spawn raced the refetch).
                scheduleRefresh()
            }
            // Bare refetch trigger for the scratchlist query (never applied
            // onto the session — it carries no such field).
            if patch.scratchlistUpdatedAt != nil {
                onScratchlistInvalidation?(sessionId)
            }
        case .session, .patch, .unrecognized, nil:
            // Mismatched-id full session, empty `{}` patch, unrecognized, or
            // absent payload → REST fallback.
            if details[sessionId] != nil {
                Task {
                    // Stale detail survives until the next successful sync.
                    try? await self.loadSessionDetail(sessionId)
                }
            }
            scheduleRefresh()
        }
    }

    private func upsertSummary(_ session: Session) {
        var list = sessions
        let index = list.firstIndex { $0.id == session.id }
        let existing = index.map { list[$0] }
        // The projection cannot derive the hub-computed scheduled-message
        // fields — carry them over from the previous row (web
        // `upsertSessionSummary`).
        var summary = SummaryPatching.toSessionSummary(session)
        summary.futureScheduledMessageCount = existing?.futureScheduledMessageCount ?? 0
        summary.nextScheduledAt = existing?.nextScheduledAt
        if let index {
            list[index] = summary
        } else {
            list.append(summary)
        }
        setSessions(sortSessionSummaries(list))
    }

    /// Detail patch with strict-`>` versioned gates; true when a row was
    /// cached. A `nil` apply result is render-irrelevant → keep the previous
    /// value.
    @discardableResult
    private func patchDetail(sessionId: String, patch: SessionPatch) -> Bool {
        guard let current = details[sessionId] else { return false }
        if let next = applySessionDetailPatch(session: current, patch: patch) {
            details[sessionId] = next
        }
        return true
    }

    /// Summary patch (`>=` gates + keep-alive suppression); true when the
    /// row exists.
    private func patchSummary(sessionId: String, patch: SessionPatch) -> Bool {
        guard let index = sessions.firstIndex(where: { $0.id == sessionId }) else { return false }
        let current = sessions[index]
        let next = SummaryPatching.applySessionSummaryPatch(current, patch)
        // Keep-alive noise: activeAt-only movement keeps the previous list
        // (no revision bump, no re-sort, no snapshot write).
        if SummaryPatching.isRenderIrrelevantPatch(current: current, next: next) {
            return true
        }
        var list = sessions
        list[index] = next
        setSessions(sortSessionSummaries(list))
        return true
    }

    private func setSessions(_ next: [SessionSummary]) {
        sessions = next
        listRevision += 1
        snapshot?.scheduleWrite(next)
    }
}
