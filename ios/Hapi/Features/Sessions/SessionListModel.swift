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

/// Session-list presentation state over the `HubSession` stores — the iOS
/// counterpart of the Android reference's `SessionListViewModel`: row/filter
/// derivation, refresh + offline/loaded flags, last-seen stamping, and
/// pin/archive forwarding (optimism lives in the store). The SSE
/// subscription itself is owned by `HubSession`, not this model.
@MainActor @Observable
final class SessionListModel {
    private let session: HubSession

    /// Selected machine filter id (`nil` = All). In-memory only, like the
    /// web's sidebar selection.
    var machineFilter: String?
    private(set) var isRefreshing = false
    /// Last refresh failed — show the offline state over snapshot data.
    private(set) var isOffline = false
    private(set) var hasRefreshedOnce = false
    /// Transient pin/archive failure for an alert.
    var actionError: String?

    init(session: HubSession) {
        self.session = session
    }

    // MARK: - Derived state

    /// True once either the snapshot or a refresh produced a list.
    var hasLoaded: Bool {
        hasRefreshedOnce || !session.sessionStore.sessions.isEmpty
    }

    /// Filter chips derive from ALL sessions (pre-filter), like the web —
    /// filtering first would drop chips and silently clear the selection.
    /// Encounter order is kept for equal counts so chips do not reshuffle.
    var machineFilters: [MachineFilterUI] {
        var counts: [(id: String, count: Int)] = []
        var indexById: [String: Int] = [:]
        for summary in session.sessionStore.sessions {
            let id = summary.metadata?.machineId ?? unknownMachineFilterId
            if let index = indexById[id] {
                counts[index].count += 1
            } else {
                indexById[id] = counts.count
                counts.append((id: id, count: 1))
            }
        }
        return counts
            .map { entry in
                MachineFilterUI(
                    id: entry.id,
                    label: entry.id == unknownMachineFilterId ? "" : (machineLabel(entry.id) ?? ""),
                    sessionCount: entry.count
                )
            }
            .sorted { $0.sessionCount > $1.sessionCount }
    }

    /// Render the chip bar only when at least two machines have sessions.
    var showMachineFilterBar: Bool {
        machineFilters.count >= 2
    }

    /// A persisted pick whose machine no longer has sessions falls back to
    /// All; with fewer than two machines the bar hides and never filters.
    var activeMachineFilter: String? {
        guard let machineFilter else { return nil }
        let filters = machineFilters
        guard filters.count >= 2, filters.contains(where: { $0.id == machineFilter }) else {
            return nil
        }
        return machineFilter
    }

    var rows: [SessionRowUI] {
        let lastSeen = session.lastSeenStore.state.lastSeen
        let activeFilter = activeMachineFilter
        let visible = session.sessionStore.sessions.filter { summary in
            guard let activeFilter else { return true }
            return (summary.metadata?.machineId ?? unknownMachineFilterId) == activeFilter
        }
        // With one machine — or a machine filter active — every visible row
        // shares the machine, so repeating it per row is noise.
        let showMachine = machineFilters.count >= 2 && activeFilter == nil
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
            if showMachine, let machine = machineLabel(summary.metadata?.machineId) {
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
            try await session.sessionStore.refresh()
            try await session.machineStore.refresh()
            isOffline = false
            hasRefreshedOnce = true
            session.lastSeenStore.initializeBaseline(
                scopeKey: session.hubUrl,
                sessions: session.sessionStore.sessions
            )
        } catch {
            isOffline = true
        }
    }

    /// Call when navigating into a session: stamps the last-seen watermark.
    func onSessionOpened(_ sessionId: String) {
        guard let summary = session.sessionStore.sessions.first(where: { $0.id == sessionId }) else {
            return
        }
        session.lastSeenStore.markSeen(sessionId: sessionId, seenAt: summary.updatedAt)
    }

    /// `PUT /sessions/:id/pin` with store-side optimistic re-sort; failures
    /// surface on `actionError`.
    func setPinMode(sessionId: String, mode: SessionPinMode) {
        let store = session.sessionStore
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
        let store = session.sessionStore
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

    private func machineLabel(_ machineId: String?) -> String? {
        guard let machineId else { return nil }
        guard let metadata = session.machineStore.machines.first(where: { $0.id == machineId })?.metadata else {
            return String(machineId.prefix(8))
        }
        if let displayName = metadata.displayName,
           !displayName.trimmingCharacters(in: .whitespaces).isEmpty {
            return displayName
        }
        return metadata.host
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
