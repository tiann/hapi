import HapiClient
import HapiProtocol
import HapiUI
import SwiftUI

/// The session list (A-M2a) — standalone screen: navigation and hub chrome
/// stay outside; taps surface through `onOpenSession`.
///
/// Inventory (mirrors the web sidebar semantics via the Android port):
/// - offline state over snapshot data, machine filter chips (≥ 2 machines),
///   pull-to-refresh, empty/loading states;
/// - pinned section first (the sort already puts globalPinned/pinned rows on
///   top; a header makes the boundary visible);
/// - per row: flavor brand icon + title, spinner while a turn is in flight,
///   summary line, `project · worktree · machine` meta line (machine only
///   when it disambiguates), relative latest-reply/activity time, pending-request badge,
///   todo-progress chip, unread dot; disconnected rows are dimmed —
///   connected is the resting state, so no presence dot (web parity);
/// - long-press context menu → pin (none/project/global) + archive with
///   optimistic store updates; failures land in an alert.
struct SessionListView: View {
    @Environment(\.hapiTheme) private var theme
    @State private var model: SessionListModel
    private let onOpenSession: (String) -> Void

    init(session: HubSession, onOpenSession: @escaping (String) -> Void) {
        _model = State(initialValue: SessionListModel(session: session))
        self.onOpenSession = onOpenSession
    }

    var body: some View {
        // Minute-tick timeline keeps the relative-age labels honest without
        // any store churn.
        TimelineView(.periodic(from: .now, by: 60)) { context in
            sessionList(now: context.date)
        }
        .safeAreaInset(edge: .top, spacing: 0) {
            VStack(spacing: 0) {
                if model.isOffline && model.hasLoaded {
                    offlineBanner
                }
                if model.showMachineFilterBar {
                    MachineFilterBar(
                        filters: model.machineFilters,
                        activeFilter: model.activeMachineFilter,
                        onSelect: { model.machineFilter = $0 }
                    )
                }
            }
        }
        .task {
            // Explicit fetch on entry: the snapshot may be stale and a
            // `resume: ok` handshake deliberately skips the REST resync.
            await model.refresh()
        }
        .refreshable {
            await model.refresh()
        }
        .alert(
            "Action failed",
            isPresented: Binding(
                get: { model.actionError != nil },
                set: { presented in
                    if !presented {
                        model.actionError = nil
                    }
                }
            )
        ) {
            Button("OK") {
                model.actionError = nil
            }
        } message: {
            Text(model.actionError ?? "")
        }
    }

    // MARK: - List

    private func sessionList(now: Date) -> some View {
        let rows = model.rows
        let pinnedCount = SessionListModel.pinnedCount(of: rows)
        return List {
            if pinnedCount > 0 {
                Section("Pinned") {
                    ForEach(rows.prefix(pinnedCount)) { row in
                        rowCell(row, now: now)
                    }
                }
                .listSectionSeparator(.hidden, edges: .top)
            }
            if rows.count > pinnedCount {
                // Headerless when nothing is pinned: an empty-string Section
                // header still reserves a blank sticky band above the list
                // (device feedback: "一片空白").
                if pinnedCount > 0 {
                    Section(String(localized: "Sessions")) {
                        ForEach(rows.dropFirst(pinnedCount)) { row in
                            rowCell(row, now: now)
                        }
                    }
                    .listSectionSeparator(.hidden, edges: .top)
                } else {
                    // Top edge hidden: a plain list otherwise draws a stray
                    // separator above the very first row (device feedback).
                    Section {
                        ForEach(rows) { row in
                            rowCell(row, now: now)
                        }
                    }
                    .listSectionSeparator(.hidden, edges: .top)
                }
            }
        }
        .listStyle(.plain)
        .overlay {
            if rows.isEmpty {
                emptyState
                    .allowsHitTesting(false) // keep the pull-to-refresh gesture
            }
        }
    }

    private func rowCell(_ row: SessionRowUI, now: Date) -> some View {
        Button {
            model.onSessionOpened(row.id)
            onOpenSession(row.id)
        } label: {
            SessionRowView(row: row, now: now)
        }
        .buttonStyle(.plain)
        // Default separator color reads heavy against these rows; the theme
        // divider is the WeChat-style faint hairline.
        .listRowSeparatorTint(theme.divider)
        .contextMenu {
            contextMenuActions(row)
        }
    }

    @ViewBuilder
    private func contextMenuActions(_ row: SessionRowUI) -> some View {
        let summary = row.summary
        if summary.pinned == true || summary.globalPinned == true {
            Button {
                model.setPinMode(sessionId: row.id, mode: .none)
            } label: {
                Label("Unpin", systemImage: "pin.slash")
            }
        }
        if summary.pinned != true {
            Button {
                model.setPinMode(sessionId: row.id, mode: .project)
            } label: {
                Label("Pin to Project", systemImage: "pin")
            }
        }
        if summary.globalPinned != true {
            Button {
                model.setPinMode(sessionId: row.id, mode: .global)
            } label: {
                Label("Pin Globally", systemImage: "pin.circle")
            }
        }
        Button(role: .destructive) {
            model.archiveSession(sessionId: row.id)
        } label: {
            Label("Archive", systemImage: "archivebox")
        }
    }

    // MARK: - Chrome

    private var offlineBanner: some View {
        Text("Offline — showing cached sessions")
            .font(.footnote)
            .frame(maxWidth: .infinity)
            .padding(.vertical, 6)
            .background(.orange.opacity(0.15))
            .foregroundStyle(.orange)
    }

    @ViewBuilder
    private var emptyState: some View {
        if !model.hasLoaded && !model.isOffline {
            ContentUnavailableView {
                Label("Loading sessions…", systemImage: "arrow.triangle.2.circlepath")
            } description: {
                Text("Fetching the session list from the hub.")
            }
        } else if model.isOffline {
            ContentUnavailableView {
                Label("Hub unreachable", systemImage: "wifi.slash")
            } description: {
                Text("Pull to retry once you are back online.")
            }
        } else {
            ContentUnavailableView {
                Label("No sessions yet", systemImage: "tray")
            } description: {
                Text("Start an agent with the hapi CLI and it will appear here.")
            }
        }
    }
}

// MARK: - Row

struct SessionRowView: View {
    let row: SessionRowUI
    let now: Date

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            titleLine
            // Summary directly under the title (its prose continuation); the
            // `project · machine` meta closes the row as a footer.
            if let subtitle = row.subtitle {
                Text(subtitle)
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }
            metaLine
            badgeLine
        }
        .padding(.vertical, 2)
        // Dimming expresses "disconnected" (web parity): connected is the
        // resting state here, so only the exception gets marked — no
        // per-row presence dot.
        .opacity(row.summary.active ? 1 : 0.5)
        .accessibilityElement(children: .combine)
    }

    private var titleLine: some View {
        // Spinner/dot pinned to the trailing edge next to the timestamp
        // (Android row order), so they don't drift with the title length.
        HStack(spacing: 6) {
            AgentFlavorIconView(flavor: row.flavor)
            Text(row.title)
                .font(.body)
                .fontWeight(row.unread ? .semibold : .regular)
                .lineLimit(1)
            Spacer(minLength: 4)
            if row.summary.active && row.summary.thinking {
                ProgressView()
                    .scaleEffect(0.7)
                    .frame(width: 14, height: 14)
                    .tint(.green)
                    .accessibilityLabel("Thinking")
            }
            if row.unread {
                Circle()
                    .fill(.tint)
                    .frame(width: 8, height: 8)
                    .accessibilityLabel("Unread")
            }
            Text(formatRelativeAge(
                now: now,
                thenEpochMs: row.summary.lastAssistantMessageAt ?? row.summary.updatedAt
            ))
                .font(.caption2)
                .foregroundStyle(.secondary)
        }
    }

    // `project · worktree · machine`, composed in the model (machine only
    // when it disambiguates) — the row just renders it.
    @ViewBuilder
    private var metaLine: some View {
        if let meta = row.meta {
            // Footnote, not caption: as the row's only secondary line the
            // meta carries the project scan key (web keeps title/meta at
            // 14/12; 17/13 is the same contrast).
            Text(meta)
                .font(.footnote)
                .foregroundStyle(.secondary)
                .lineLimit(1)
        }
    }

    @ViewBuilder
    private var badgeLine: some View {
        let summary = row.summary
        if summary.pendingRequestsCount > 0 || summary.todoProgress != nil {
            HStack(spacing: 6) {
                if summary.pendingRequestsCount > 0 {
                    PendingBadge(
                        count: summary.pendingRequestsCount,
                        kinds: summary.pendingRequestKinds,
                        requests: summary.pendingRequests
                    )
                }
                if let progress = summary.todoProgress {
                    TodoChip(progress: progress)
                }
            }
            .padding(.top, 2)
        }
    }
}

/// Solid green for active (pulsing while thinking), muted gray when idle.
/// Chat-header use only — list rows express liveness by dimming instead
/// (web parity: no per-row presence dot).
struct StatusDot: View {
    let active: Bool
    let thinking: Bool

    var body: some View {
        let dot = Circle()
            .fill(active ? Color.green : Color.gray.opacity(0.45))
            .frame(width: 10, height: 10)
        Group {
            if thinking {
                dot.phaseAnimator([1.0, 0.25]) { view, opacity in
                    view.opacity(opacity)
                } animation: { _ in
                    .easeInOut(duration: 0.7)
                }
            } else {
                dot
            }
        }
        .accessibilityLabel(active
            ? (thinking ? String(localized: "Thinking") : String(localized: "Active"))
            : String(localized: "Inactive"))
    }
}

/// Pending badge: authoritative `pendingRequestsCount` + kind wording; the
/// capped `pendingRequests` slice names the first tool.
struct PendingBadge: View {
    let count: Int
    let kinds: [PendingRequestKind]
    let requests: [PendingRequest]

    var body: some View {
        let needsInput = kinds.contains(.input) && !kinds.contains(.permission)
        let label: String
        if needsInput {
            label = String(localized: "needs input")
        } else if let first = requests.first {
            label = String(format: String(localized: "approve %@"), first.tool)
        } else {
            label = String(localized: "pending")
        }
        let text = count > 1 ? "\(count) · \(label)" : label
        return Text(text)
            .font(.caption2)
            .lineLimit(1)
            .padding(.horizontal, 6)
            .padding(.vertical, 2)
            .background(.orange.opacity(0.18), in: RoundedRectangle(cornerRadius: 6))
            .foregroundStyle(.orange)
    }
}

struct TodoChip: View {
    let progress: TodoProgress

    var body: some View {
        Label("\(progress.completed)/\(progress.total)", systemImage: "checklist")
            .font(.caption2)
            .lineLimit(1)
            .padding(.horizontal, 6)
            .padding(.vertical, 2)
            .background(Color.secondary.opacity(0.15), in: RoundedRectangle(cornerRadius: 6))
            .foregroundStyle(.secondary)
    }
}

// MARK: - Machine filter

struct MachineFilterBar: View {
    let filters: [MachineFilterUI]
    let activeFilter: String?
    let onSelect: (String?) -> Void

    var body: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 8) {
                FilterChip(label: String(localized: "All"), selected: activeFilter == nil) {
                    onSelect(nil)
                }
                ForEach(filters) { filter in
                    let label = filter.label.isEmpty ? String(localized: "Unknown machine") : filter.label
                    FilterChip(
                        label: "\(label) · \(filter.sessionCount)",
                        selected: activeFilter == filter.id
                    ) {
                        // Tapping the active chip toggles back to All.
                        onSelect(activeFilter == filter.id ? nil : filter.id)
                    }
                }
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 6)
        }
        .background(.bar)
    }
}

struct FilterChip: View {
    let label: String
    let selected: Bool
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Text(label)
                .font(.footnote)
                .padding(.horizontal, 10)
                .padding(.vertical, 5)
                .background(
                    selected
                        ? AnyShapeStyle(.tint.opacity(0.18))
                        : AnyShapeStyle(Color.secondary.opacity(0.12)),
                    in: Capsule()
                )
                .foregroundStyle(selected ? AnyShapeStyle(.tint) : AnyShapeStyle(.primary))
        }
        .buttonStyle(.plain)
        .accessibilityAddTraits(selected ? .isSelected : [])
    }
}
