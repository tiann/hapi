import Foundation
import HapiClient
import HapiProtocol
import Observation

/// Sessions whose metadata carries no machine id group under this filter id.
let unknownMachineFilterId = "__unknown__"

/// One rendered list row: the summary plus everything derived for display.
struct SessionRowUI: Identifiable, Equatable {
    let summary: SessionSummary
    /// `getSessionTitle` port: name → summary text → path tail → id prefix.
    let title: String
    /// Short project name only. Paths, machine/worktree details and the
    /// conversation summary stay out of the compact home row.
    let project: String?
    /// Raw flavor id (`claude`, `codex`, …); labels resolve via the catalog.
    let flavor: String?
    let unread: Bool

    var id: String { summary.id }
    var status: SessionRowStatus? { SessionRowStatus(summary: summary) }
}

/// Presentation only: request totals/kinds come from the hub, independently
/// of the capped request slice and the local read watermark.
enum SessionRowStatus: Equatable {
    case needsReply(Int)
    case needsApproval(Int)
    case needsAttention(Int)
    case running

    init?(summary: SessionSummary) {
        let count = summary.pendingRequestsCount
        if count > 0 {
            let kinds = Set(summary.pendingRequestKinds)
            if kinds == [.input] {
                self = .needsReply(count)
            } else if kinds == [.permission] {
                self = .needsApproval(count)
            } else {
                self = .needsAttention(count)
            }
        } else if summary.active && summary.thinking {
            self = .running
        } else {
            return nil
        }
    }

    /// Localize in the view so its locale also governs previews/specimens.
    var titleKey: String {
        switch self {
        case .needsReply: return "Needs reply"
        case .needsApproval: return "Needs approval"
        case .needsAttention: return "Needs attention"
        case .running: return "Running"
        }
    }

    var count: Int? {
        switch self {
        case .needsReply(let count), .needsApproval(let count), .needsAttention(let count): return count
        case .running: return nil
        }
    }

    /// Unfilled attention symbols; running uses the native loading indicator.
    /// Status wording/count remain available to VoiceOver in either case.
    var symbolName: String? {
        switch self {
        case .needsReply: return "bubble.left"
        case .needsApproval: return "hand.raised"
        case .needsAttention: return "exclamationmark.bubble"
        case .running: return nil
        }
    }
}

struct MachineFilterUI: Identifiable, Equatable {
    /// Machine id or `unknownMachineFilterId`.
    let id: String
    let label: String
    let sessionCount: Int
}

/// Transient, per-home filters. Add future dimensions here, not to navigation.
struct SessionListFilters: Equatable, Hashable {
    var machineId: String?

    var isActive: Bool { machineId != nil }
}

/// Session-list presentation state over the `HubSession` stores — the iOS
/// counterpart of the Android reference's `SessionListViewModel`: row/filter
/// derivation, refresh + offline/loaded flags, last-seen stamping, and
/// pin/archive forwarding (optimism lives in the store). The SSE
/// subscription itself is owned by `HubSession`, not this model.
@MainActor @Observable
final class SessionListModel {
    private let sessionStore: any SessionListStoring
    private let machineStore: any MachineListStoring
    private let lastSeenStore: LastSeenStore
    private let hubUrl: String

    /// Not persisted: a new home / hub starts with all sessions.
    private(set) var filters = SessionListFilters()
    private(set) var isRefreshing = false
    /// Last refresh failed — show the offline state over snapshot data.
    private(set) var isOffline = false
    private(set) var hasRefreshedOnce = false
    @ObservationIgnored private var hasAttemptedRefresh = false
    /// Transient pin/archive failure for an alert.
    var actionError: String?

    convenience init(session: HubSession) {
        self.init(
            sessionStore: session.sessionStore, machineStore: session.machineStore,
            lastSeenStore: session.lastSeenStore, hubUrl: session.hubUrl
        )
    }

    init(
        sessionStore: any SessionListStoring,
        machineStore: any MachineListStoring,
        lastSeenStore: LastSeenStore,
        hubUrl: String
    ) {
        self.sessionStore = sessionStore
        self.machineStore = machineStore
        self.lastSeenStore = lastSeenStore
        self.hubUrl = hubUrl
    }

    // MARK: - Derived state

    /// True once either the snapshot or a refresh produced a list.
    var hasLoaded: Bool {
        hasRefreshedOnce || !sessionStore.sessions.isEmpty
    }

    /// All session groups, including historical / unidentified machines.
    /// The online roster is only a source of labels, never filter membership.
    var machineFilterIds: Set<String> {
        Set(sessionStore.sessions.map { $0.metadata?.machineId ?? unknownMachineFilterId })
    }

    /// Counts are pre-filter. Names, not live counts, determine menu order.
    var machineFilters: [MachineFilterUI] {
        var counts: [String: Int] = [:]
        for summary in sessionStore.sessions {
            let id = summary.metadata?.machineId ?? unknownMachineFilterId
            counts[id, default: 0] += 1
        }
        var names: [String: String] = [:]
        for machine in machineStore.machines where counts[machine.id] != nil {
            guard let metadata = machine.metadata else { continue }
            let displayName = metadata.displayName?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            let host = metadata.host.trimmingCharacters(in: .whitespacesAndNewlines)
            let name = displayName.isEmpty ? host : displayName
            if !name.isEmpty { names[machine.id] = name }
        }
        let nameCounts = Dictionary(grouping: names.values, by: { $0.lowercased() }).mapValues(\.count)
        return counts
            .map { entry in
                let id = entry.key
                let label: String
                if id == unknownMachineFilterId {
                    label = String(localized: "Unknown machine")
                } else if let name = names[id] {
                    label = nameCounts[name.lowercased(), default: 0] > 1
                        ? "\(name) · \(id.prefix(8))" : name
                } else {
                    label = String(format: String(localized: "Machine · %@"), String(id.prefix(8)))
                }
                return MachineFilterUI(id: id, label: label, sessionCount: entry.value)
            }
            .sorted { lhs, rhs in
                func rank(_ id: String) -> Int {
                    id == unknownMachineFilterId ? 2 : (names[id] == nil ? 1 : 0)
                }
                if rank(lhs.id) != rank(rhs.id) { return rank(lhs.id) < rank(rhs.id) }
                let order = lhs.label.localizedStandardCompare(rhs.label)
                return order == .orderedSame ? lhs.id < rhs.id : order == .orderedAscending
            }
    }

    var showsFilterMenu: Bool {
        machineFilterIds.count >= 2
    }

    /// Never render an invalid filter, even before the view reconciles it.
    var activeMachineFilter: String? {
        guard let machineId = filters.machineId else { return nil }
        let ids = machineFilterIds
        guard ids.count >= 2, ids.contains(machineId) else {
            return nil
        }
        return machineId
    }

    var filterSummary: String? {
        guard let id = activeMachineFilter,
              let machine = machineFilters.first(where: { $0.id == id }) else { return nil }
        return String(format: String(localized: "Machine: %@"), machine.label)
    }

    func selectMachine(_ id: String?) {
        filters.machineId = id
        reconcileFilters()
    }

    func clearFilters() {
        filters = SessionListFilters()
    }

    /// Clear the stored pick as well, so a vanished group cannot resurrect it.
    func reconcileFilters() {
        if filters.machineId != activeMachineFilter {
            filters.machineId = nil
        }
    }

    var rows: [SessionRowUI] {
        let lastSeen = lastSeenStore.state.lastSeen
        let activeFilter = activeMachineFilter
        let visible = sessionStore.sessions.filter { summary in
            guard let activeFilter else { return true }
            return (summary.metadata?.machineId ?? unknownMachineFilterId) == activeFilter
        }
        return visible.map { summary in
            SessionRowUI(
                summary: summary,
                title: Self.sessionTitle(summary),
                project: Self.projectLabel(summary),
                flavor: summary.metadata?.flavor,
                unread: LastSeenStore.isUnread(summary, lastSeenAt: lastSeen[summary.id] ?? 0)
            )
        }
    }

    /// The sort contract puts globalPinned/pinned rows first; this boundary
    /// index is where the pinned section ends.
    static func pinnedCount(of rows: [SessionRowUI]) -> Int {
        rows.prefix { $0.summary.globalPinned == true || $0.summary.pinned == true }.count
    }

    /// Use the worktree's owning project, not its temporary checkout name.
    /// The home needs a scan key, not a repeated path or machine inventory.
    static func projectLabel(_ summary: SessionSummary) -> String? {
        guard let path = summary.metadata?.worktree?.basePath ?? summary.metadata?.path else { return nil }
        return path.split(whereSeparator: { $0 == "/" || $0 == "\\" }).last.map(String.init)
    }

    // MARK: - Actions

    /// A split sidebar can disappear/reappear just because the window
    /// collapses. Fetch once per home, not once per layout transition;
    /// global SSE recovery and explicit pull-to-refresh still fetch normally.
    func refreshOnFirstAppearance() async {
        guard !hasAttemptedRefresh else { return }
        hasAttemptedRefresh = true
        // The sidebar's SwiftUI task is cancelled when it collapses. The
        // initial fetch belongs to the model, not that transient presentation.
        await Task { await self.refresh() }.value
    }

    /// Pull-to-refresh / initial load. Coalesces concurrent calls; the first
    /// successful list seeds the unread baseline so historical sessions do
    /// not all light up as unread.
    func refresh() async {
        guard !isRefreshing else { return }
        hasAttemptedRefresh = true
        isRefreshing = true
        defer { isRefreshing = false }
        do {
            try await sessionStore.refresh()
            reconcileFilters()
            try await machineStore.refresh()
            isOffline = false
            hasRefreshedOnce = true
            lastSeenStore.initializeBaseline(
                scopeKey: hubUrl,
                sessions: sessionStore.sessions
            )
        } catch {
            isOffline = true
        }
    }

    /// Call when navigating into a session: stamps the last-seen watermark.
    func onSessionOpened(_ sessionId: String) {
        guard let summary = sessionStore.sessions.first(where: { $0.id == sessionId }) else {
            return
        }
        lastSeenStore.markSeen(sessionId: sessionId, seenAt: summary.updatedAt)
    }

    /// `PUT /sessions/:id/pin` with store-side optimistic re-sort; failures
    /// surface on `actionError`.
    func setPinMode(sessionId: String, mode: SessionPinMode) {
        let store = sessionStore
        Task {
            do {
                try await store.setPinMode(sessionId: sessionId, mode: mode)
            } catch {
                self.actionError = String(
                    format: String(localized: "Pin failed: %@"),
                    error.localizedDescription
                )
            }
        }
    }

    /// `POST /sessions/:id/archive` with store-side optimistic removal;
    /// failures surface on `actionError`.
    func archiveSession(sessionId: String) {
        let store = sessionStore
        Task {
            do {
                try await store.archiveSession(sessionId: sessionId)
            } catch {
                self.actionError = String(
                    format: String(localized: "Archive failed: %@"),
                    error.localizedDescription
                )
            }
        }
    }

    // MARK: - Helpers

    /// `getSessionTitle` (`web/src/lib/sessionTitle.ts`): name → summary
    /// text → path tail → id prefix.
    static func sessionTitle(_ summary: SessionSummary) -> String {
        if let name = summary.metadata?.name, !name.isEmpty {
            return name
        }
        if let text = summary.metadata?.summary?.text, !text.isEmpty {
            return text
        }
        if let path = summary.metadata?.path,
           let tail = path.split(separator: "/").last(where: { !$0.isEmpty }) {
            return String(tail)
        }
        return String(summary.id.prefix(8))
    }
}

/// Compact relative-age label for list rows ("now", "5m", "3h", "2d").
/// Minute granularity is deliberate: it is why sub-minute `activeAt` churn
/// can be dropped as render-irrelevant (`sse.md#keep-alive-noise`). Mirrors
/// the Android reference (`formatRelativeAge`).
func formatRelativeAge(now: Date, thenEpochMs: Int) -> String {
    let delta = Int(now.timeIntervalSince1970 * 1000) - thenEpochMs
    if delta < 60_000 { return String(localized: "now") }
    let minutes = delta / 60_000
    if minutes < 60 { return "\(minutes)m" }
    let hours = minutes / 60
    if hours < 24 { return "\(hours)h" }
    let days = hours / 24
    if days < 7 { return "\(days)d" }
    let weeks = days / 7
    if weeks < 5 { return "\(weeks)w" }
    let months = days / 30
    if months < 12 { return "\(months)mo" }
    return "\(days / 365)y"
}
