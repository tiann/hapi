import Foundation
import HapiProtocol
import Observation

/// Live scratchlist view of one session (``SessionScratchlistStoring/state(_:)``).
public struct ScratchlistSessionState: Equatable, Sendable {
    /// Optimistic rows first, then hub order (`createdAt DESC`).
    public var entries: [ScratchlistEntry] = []
    /// At least one fetch succeeded — an empty ``entries`` means "truly empty".
    public var loaded = false
    public var isRefreshing = false
    /// No successful fetch yet and the last attempt failed → error state.
    public var loadFailed = false
    /// The session sits at the 200-entry cap (local count, or the hub's 409
    /// `scratchlist_at_cap` verdict) — disable the add affordances.
    public var atCap = false
    /// Filenames of attachment uploads in flight (indeterminate progress chips).
    public var uploadsInFlight: [String] = []

    public init() {}
}

public enum ScratchlistCreateResult: Sendable {
    case created(ScratchlistEntry)
    case atCap
    case failed(any Error)
}

public enum ScratchlistUploadResult: Sendable {
    case uploaded(ScratchlistAttachment)

    /// `code` is the typed hub code when present (`scratchlist_attachment_too_large`, …).
    case failed(message: String, code: String?)
}

public enum ScratchlistAttachmentDeleteResult: Sendable {
    case removed

    /// 409 `scratchlist_attachment_in_use` — an entry still references the file.
    case inUse
    case failed(any Error)
}

/// Store-side validation failures (mirror of the Android store's
/// `IllegalArgumentException` path).
public enum ScratchlistStoreError: Error, Equatable {
    /// A create with neither text nor attachments (the hub would 400 it).
    case emptyEntry
}

/// The scratchlist surface UI layers depend on (``ScratchlistStore`` is the
/// production implementation; screen-model and interactor tests substitute
/// fakes — the same interface extraction as ``SessionListStoring``).
@MainActor
public protocol SessionScratchlistStoring: AnyObject {
    /// Current per-session state; reading it inside an observation scope
    /// tracks the store's changes.
    func state(_ sessionId: String) -> ScratchlistSessionState

    /// Marks the session observed (SSE invalidations refetch it) + refreshes.
    func open(_ sessionId: String)

    /// Unmarks observed; cached entries stay for instant re-open.
    func release(_ sessionId: String)

    /// `GET /sessions/:id/scratchlist` — replaces the cached list. Throws on failure.
    func refresh(_ sessionId: String) async throws

    /// Optimistic create; see ``ScratchlistStore/createEntry(sessionId:text:attachments:)``.
    func createEntry(
        sessionId: String,
        text: String,
        attachments: [ScratchlistAttachment]
    ) async -> ScratchlistCreateResult

    /// Optimistic update (nil = keep; `attachments = []` clears). Returns
    /// false when the update did not stick.
    func updateEntry(
        sessionId: String,
        entryId: String,
        text: String?,
        attachments: [ScratchlistAttachment]?
    ) async -> Bool

    /// Optimistic delete; restores on failure. A 404 counts as success (already gone).
    func deleteEntry(sessionId: String, entryId: String) async -> Bool

    /// Base64-JSON upload; in flight it appears in ``ScratchlistSessionState/uploadsInFlight``.
    func uploadAttachment(
        sessionId: String,
        filename: String,
        data: Data,
        mimeType: String
    ) async -> ScratchlistUploadResult

    func deleteAttachment(sessionId: String, attachmentId: String) async -> ScratchlistAttachmentDeleteResult

    /// Hub attachment budgets, cached after the first success; defaults offline.
    func limits(sessionId: String) async -> ScratchlistAttachmentLimits
}

extension SessionScratchlistStoring {
    /// Text-only create convenience (protocol requirements cannot default arguments).
    public func createEntry(sessionId: String, text: String) async -> ScratchlistCreateResult {
        await createEntry(sessionId: sessionId, text: text, attachments: [])
    }
}

/// Per-session scratchlist cache for one hub (tiann/hapi#893, A-M4b) — the
/// iOS twin of the Android `ScratchlistStore` / `web/src/lib/use-hub-scratchlist.ts`:
///
/// - **Fetching**: ``open(_:)`` (chat/scratchlist screen) refreshes; a
///   `scratchlistUpdatedAt` SSE patch signal — delivered by
///   `SessionListStore.onScratchlistInvalidation` into
///   ``handleInvalidation(sessionId:)`` — refetches sessions somebody
///   observes (the timestamp is the trigger, never data). Refetches coalesce
///   per session like the list store's 16 ms invalidation batch.
/// - **Optimistic mutations** reconcile surgically (by entryId) instead of
///   snapshot-restore, so a concurrent SSE refetch cannot resurrect
///   rolled-back rows; refreshes preserve optimistic rows whose POST is still
///   in flight.
/// - **Cap**: local pre-check at ``ScratchlistCaps/maxEntries`` plus the
///   hub's 409 `scratchlist_at_cap` both surface as the friendly
///   ``ScratchlistSessionState/atCap`` flag (recomputed from entry count on
///   every entries change).
///
/// Text is trimmed and truncated to ``ScratchlistCaps/maxTextLength`` (web
/// truncates rather than rejects). Entries are memory-only: the hub is the
/// durable store and every open refetches.
@MainActor @Observable
public final class ScratchlistStore: SessionScratchlistStoring {
    /// All cached sessions, keyed by session id.
    public private(set) var states: [String: ScratchlistSessionState] = [:]

    @ObservationIgnored private let api: APIClient
    @ObservationIgnored private let refreshBatch: Duration
    @ObservationIgnored private let now: () -> Int
    @ObservationIgnored private let makeEntryId: () -> String

    @ObservationIgnored private var observers: [String: Int] = [:]
    @ObservationIgnored private var refreshQueued: Set<String> = []
    /// Per-session refresh chain — serializes overlapping refreshes so a
    /// staler response can never overwrite a fresher one (the Android store's
    /// per-session mutex).
    @ObservationIgnored private var refreshTails: [String: Task<Void, any Error>] = [:]
    /// Optimistic-create entry ids whose POST has not settled (refresh keeps them).
    @ObservationIgnored private var pendingCreates: Set<String> = []
    @ObservationIgnored private var cachedLimits: ScratchlistAttachmentLimits?

    public init(
        api: APIClient,
        refreshBatch: Duration = .milliseconds(16),
        now: @escaping () -> Int = { Int(Date().timeIntervalSince1970 * 1000) },
        makeEntryId: @escaping () -> String = { "scratch-\(UUID().uuidString)" }
    ) {
        self.api = api
        self.refreshBatch = refreshBatch
        self.now = now
        self.makeEntryId = makeEntryId
    }

    public func state(_ sessionId: String) -> ScratchlistSessionState {
        states[sessionId] ?? ScratchlistSessionState()
    }

    public func open(_ sessionId: String) {
        observers[sessionId, default: 0] += 1
        scheduleRefresh(sessionId)
    }

    public func release(_ sessionId: String) {
        guard let count = observers[sessionId] else { return }
        if count <= 1 {
            observers.removeValue(forKey: sessionId)
        } else {
            observers[sessionId] = count - 1
        }
    }

    /// `scratchlistUpdatedAt` arrived in the session's SSE patch: refetch if
    /// anybody observes this session (wired by `HubSession` from
    /// `SessionListStore.onScratchlistInvalidation`).
    public func handleInvalidation(sessionId: String) {
        guard observers[sessionId, default: 0] > 0 else { return }
        scheduleRefresh(sessionId)
    }

    // MARK: - Fetching

    public func refresh(_ sessionId: String) async throws {
        let previous = refreshTails[sessionId]
        let task = Task<Void, any Error> { [weak self] in
            if let previous {
                _ = try? await previous.value
            }
            guard let self else { return }
            try await self.performRefresh(sessionId)
        }
        refreshTails[sessionId] = task
        defer {
            if refreshTails[sessionId] == task {
                refreshTails[sessionId] = nil
            }
        }
        try await task.value
    }

    /// Coalesced fire-and-forget ``refresh(_:)`` (per-session 16 ms batch,
    /// like `SessionListStore.scheduleRefresh`).
    public func scheduleRefresh(_ sessionId: String) {
        guard !refreshQueued.contains(sessionId) else { return }
        refreshQueued.insert(sessionId)
        Task { [refreshBatch] in
            try? await Task.sleep(for: refreshBatch)
            self.refreshQueued.remove(sessionId)
            // Offline burst — the next signal or screen open retries.
            try? await self.refresh(sessionId)
        }
    }

    private func performRefresh(_ sessionId: String) async throws {
        update(sessionId) { $0.isRefreshing = true }
        let fetched: [ScratchlistEntry]
        do {
            fetched = try await api.scratchlistEntries(sessionId: sessionId).entries
        } catch {
            update(sessionId) { state in
                state.isRefreshing = false
                state.loadFailed = !state.loaded
            }
            throw error
        }
        update(sessionId) { state in
            // Keep optimistic rows whose POST is still in flight — a
            // wholesale replace would flash them away mid-create.
            let optimistic = state.entries.filter { entry in
                pendingCreates.contains(entry.entryId)
                    && !fetched.contains { $0.entryId == entry.entryId }
            }
            state.entries = optimistic + fetched
            state.atCap = state.entries.count >= ScratchlistCaps.maxEntries
            state.loaded = true
            state.isRefreshing = false
            state.loadFailed = false
        }
    }

    // MARK: - Mutations

    /// Optimistic create. The optimistic row's entryId travels in the POST,
    /// so a retry after an ambiguous failure is idempotent (hub answers 200
    /// with the canonical row for a known id). Local count at the 200-entry
    /// cap short-circuits to ``ScratchlistCreateResult/atCap`` without a
    /// request.
    public func createEntry(
        sessionId: String,
        text: String,
        attachments: [ScratchlistAttachment]
    ) async -> ScratchlistCreateResult {
        let trimmed = Self.clampText(text)
        if trimmed.isEmpty && attachments.isEmpty {
            return .failed(ScratchlistStoreError.emptyEntry)
        }
        if state(sessionId).entries.count >= ScratchlistCaps.maxEntries {
            update(sessionId) { $0.atCap = true }
            return .atCap
        }

        let stamp = now()
        let optimistic = ScratchlistEntry(
            entryId: makeEntryId(),
            text: trimmed,
            createdAt: stamp,
            updatedAt: stamp,
            attachments: attachments
        )
        pendingCreates.insert(optimistic.entryId)
        setEntries(sessionId, [optimistic] + state(sessionId).entries)

        do {
            let response = try await api.createScratchlistEntry(
                sessionId: sessionId,
                ScratchlistEntryCreateRequest(
                    text: trimmed,
                    entryId: optimistic.entryId,
                    createdAt: stamp,
                    attachments: attachments.isEmpty ? nil : attachments
                )
            )
            pendingCreates.remove(optimistic.entryId)
            let canonical = response.entry
            // Replace the optimistic row; drop any duplicate the SSE refetch
            // may have landed first (web onSuccess dedupe).
            let without = state(sessionId).entries.filter {
                $0.entryId != optimistic.entryId && $0.entryId != canonical.entryId
            }
            setEntries(sessionId, [canonical] + without)
            return .created(canonical)
        } catch {
            // Roll back even when the surrounding task was cancelled — the
            // idempotent entryId means a refetch reconciles a send that
            // actually landed (the Android store rethrows cancellation
            // instead; this store's callers never rely on that).
            pendingCreates.remove(optimistic.entryId)
            setEntries(sessionId, state(sessionId).entries.filter { $0.entryId != optimistic.entryId })
            if let apiError = error as? APIError,
               apiError.status == 409, apiError.code == ScratchlistErrorCode.atCap {
                update(sessionId) { $0.atCap = true }
                // Reconcile the local count with the hub's cap verdict.
                scheduleRefresh(sessionId)
                return .atCap
            }
            return .failed(error)
        }
    }

    /// Optimistic update (nil = keep; `attachments = []` clears). Rolls the
    /// row back on failure; a 404 drops it and refetches (entry deleted
    /// elsewhere). Returns false when the update did not stick.
    public func updateEntry(
        sessionId: String,
        entryId: String,
        text: String?,
        attachments: [ScratchlistAttachment]?
    ) async -> Bool {
        let trimmed = text.map(Self.clampText)
        if trimmed == nil && attachments == nil { return false }
        let previous = state(sessionId).entries.first { $0.entryId == entryId }
        if var optimistic = previous {
            if let trimmed { optimistic.text = trimmed }
            if let attachments { optimistic.attachments = attachments }
            optimistic.updatedAt = now()
            replaceEntry(sessionId, entryId: entryId, with: optimistic)
        }
        do {
            let response = try await api.updateScratchlistEntry(
                sessionId: sessionId,
                entryId: entryId,
                ScratchlistEntryUpdateRequest(text: trimmed, attachments: attachments)
            )
            replaceEntry(sessionId, entryId: entryId, with: response.entry)
            return true
        } catch {
            if let apiError = error as? APIError, apiError.status == 404 {
                // Deleted elsewhere — drop the row and reconcile.
                setEntries(sessionId, state(sessionId).entries.filter { $0.entryId != entryId })
                scheduleRefresh(sessionId)
            } else if let previous {
                replaceEntry(sessionId, entryId: entryId, with: previous)
            }
            return false
        }
    }

    public func deleteEntry(sessionId: String, entryId: String) async -> Bool {
        let entries = state(sessionId).entries
        let index = entries.firstIndex { $0.entryId == entryId }
        let removed = index.map { entries[$0] }
        if removed != nil {
            setEntries(sessionId, entries.filter { $0.entryId != entryId })
        }
        do {
            try await api.deleteScratchlistEntry(sessionId: sessionId, entryId: entryId)
            return true
        } catch {
            if let apiError = error as? APIError, apiError.status == 404 {
                return true // already gone
            }
            if let removed, let index {
                update(sessionId) { state in
                    guard !state.entries.contains(where: { $0.entryId == entryId }) else { return }
                    state.entries.insert(removed, at: min(max(index, 0), state.entries.count))
                    state.atCap = state.entries.count >= ScratchlistCaps.maxEntries
                }
            }
            return false
        }
    }

    // MARK: - Attachments

    public func uploadAttachment(
        sessionId: String,
        filename: String,
        data: Data,
        mimeType: String
    ) async -> ScratchlistUploadResult {
        update(sessionId) { $0.uploadsInFlight.append(filename) }
        defer {
            update(sessionId) { state in
                if let index = state.uploadsInFlight.firstIndex(of: filename) {
                    state.uploadsInFlight.remove(at: index)
                }
            }
        }
        do {
            let response = try await api.uploadScratchlistAttachment(
                sessionId: sessionId,
                filename: filename,
                data: data,
                mimeType: mimeType
            )
            if response.success, let attachment = response.attachment {
                return .uploaded(attachment)
            }
            return .failed(message: response.error ?? "Upload failed", code: response.code)
        } catch {
            let apiError = error as? APIError
            let message = apiError?.code
                ?? (error as? LocalizedError)?.errorDescription
                ?? "Upload failed"
            return .failed(message: message, code: apiError?.code)
        }
    }

    public func deleteAttachment(
        sessionId: String,
        attachmentId: String
    ) async -> ScratchlistAttachmentDeleteResult {
        do {
            try await api.deleteScratchlistAttachment(sessionId: sessionId, attachmentId: attachmentId)
            return .removed
        } catch {
            if let apiError = error as? APIError {
                if apiError.status == 409, apiError.code == ScratchlistErrorCode.attachmentInUse {
                    return .inUse
                }
                if apiError.status == 404 {
                    return .removed
                }
            }
            return .failed(error)
        }
    }

    public func limits(sessionId: String) async -> ScratchlistAttachmentLimits {
        if let cachedLimits { return cachedLimits }
        do {
            let fetched = try await api.scratchlistLimits(sessionId: sessionId).limits
            cachedLimits = fetched
            return fetched
        } catch {
            return .defaultLimits
        }
    }

    // MARK: - Internal

    /// New entries list + recomputed ``ScratchlistSessionState/atCap``.
    private func setEntries(_ sessionId: String, _ entries: [ScratchlistEntry]) {
        update(sessionId) { state in
            state.entries = entries
            state.atCap = entries.count >= ScratchlistCaps.maxEntries
        }
    }

    private func replaceEntry(_ sessionId: String, entryId: String, with entry: ScratchlistEntry) {
        update(sessionId) { state in
            guard let index = state.entries.firstIndex(where: { $0.entryId == entryId }) else { return }
            state.entries[index] = entry
        }
    }

    private func update(
        _ sessionId: String,
        _ transform: (inout ScratchlistSessionState) -> Void
    ) {
        var state = states[sessionId] ?? ScratchlistSessionState()
        transform(&state)
        states[sessionId] = state
    }

    /// Trim, then truncate to the hub's UTF-16 length cap without splitting a
    /// grapheme (the web slices JS strings, which count UTF-16 units). Pure —
    /// `nonisolated` so it can be passed as an `Optional.map` transform.
    nonisolated static func clampText(_ text: String) -> String {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard trimmed.utf16.count > ScratchlistCaps.maxTextLength else { return trimmed }
        var used = 0
        var end = trimmed.startIndex
        for index in trimmed.indices {
            let next = trimmed.index(after: index)
            used += trimmed[index...index].utf16.count
            if used > ScratchlistCaps.maxTextLength { break }
            end = next
        }
        return String(trimmed[..<end])
    }
}
