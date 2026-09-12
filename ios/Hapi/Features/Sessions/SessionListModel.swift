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
    /// Secondary line: summary text, only when it is not already the title.
    let subtitle: String?
    /// Single meta line, `project · worktree · machine`: project is the last
    /// two segments of the worktree base path (session path fallback, the web
    /// sidebar's group-name rule); the machine label is disambiguation only —
    /// present only when several machines are known and no machine filter is
    /// active. Full paths never render in the list (the session detail owns
    /// them).
    let meta: String?
    /// Raw flavor id (`claude`, `codex`, …); labels resolve via the catalog.
    let flavor: String?
    let unread: Bool

    var id: String { summary.id }
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
        // With one machine — or a machine filter active — every visible row
        // shares the machine, so repeating it per row is noise.
        let machines = machineFilters
        let showMachine = machines.count >= 2 && activeFilter == nil
        let labels = Dictionary(uniqueKeysWithValues: machines.map { ($0.id, $0.label) })
        return visible.map { summary in
            let title = Self.sessionTitle(summary)
            let rawSummaryText = summary.metadata?.summary?.text
            let isBlank = rawSummaryText?.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ?? true
            let summaryText = isBlank ? nil : rawSummaryText
            var metaParts: [String] = []
            if let project = Self.projectLabel(summary) {
                metaParts.append(project)
            }
            if let tree = summary.metadata?.worktree {
                let name = tree.name.trimmingCharacters(in: .whitespaces)
                metaParts.append(name.isEmpty ? tree.branch : tree.name)
            }
            if showMachine, let machine = labels[summary.metadata?.machineId ?? unknownMachineFilterId] {
                metaParts.append(machine)
            }
            return SessionRowUI(
                summary: summary,
                title: title,
                subtitle: (summaryText != nil && summaryText != title) ? summaryText : nil,
                meta: metaParts.isEmpty ? nil : metaParts.joined(separator: " · "),
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

    /// Project identity for the meta line: last two segments of the worktree
    /// base path, session path fallback — mirrors the web sidebar's
    /// `getGroupDisplayName` rule (`SessionList.tsx`).
    static func projectLabel(_ summary: SessionSummary) -> String? {
        guard let path = summary.metadata?.worktree?.basePath ?? summary.metadata?.path,
              !path.isEmpty else { return nil }
        let parts = path.split(whereSeparator: { $0 == "/" || $0 == "\\" }).map(String.init)
        if parts.isEmpty { return path }
        if parts.count == 1 { return parts[0] }
        return "\(parts[parts.count - 2])/\(parts[parts.count - 1])"
    }

    // MARK: - Actions

    /// Pull-to-refresh / initial load. Coalesces concurrent calls; the first
    /// successful list seeds the unread baseline so historical sessions do
    /// not all light up as unread.
    func refresh() async {
        guard !isRefreshing else { return }
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
