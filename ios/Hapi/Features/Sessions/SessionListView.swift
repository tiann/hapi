import HapiClient
import HapiProtocol
import HapiUI
import SwiftUI

/// The session list (A-M2a) — standalone screen: navigation and hub chrome
/// stay outside; taps surface through `onOpenSession`.
///
/// Inventory (mirrors the web sidebar semantics via the Android port):
/// - an active-filter summary, pull-to-refresh, empty/loading states;
///   home owns the filter menu and connection notice;
/// - pinned section first (the sort already puts globalPinned/pinned rows on
///   top; a header makes the boundary visible);
/// - per row: a two-line-tall flavor icon whose presence badge marks
///   connected sessions (pulsing while running); title with trailing
///   relative `updatedAt` (unread: semibold title + accent time, no dot so
///   the badge stays the only dot); a quiet second line has project left and an attention symbol right. No preview, task progress,
///   machine/path details or spinners. Disconnected rows are not dimmed;
/// - swipe actions: leading pin/mark-read, trailing archive or delete/reopen;
/// - long-press context menu → rename, pin (none/project/global), then
///   archive for active sessions or reopen/delete for inactive ones (web
///   `SessionActionMenu`), with optimistic store updates; failures land in
///   an alert.
struct SessionListView: View {
    @Environment(\.hapiTheme) private var theme
    let model: SessionListModel
    var selection: Binding<String?>? = nil
    let onOpenSession: (String) -> Void

    @State private var renameTarget: SessionRowUI?
    @State private var renameText = ""
    @State private var deleteTarget: SessionRowUI?

    var body: some View {
        // Minute-tick timeline keeps the relative-age labels honest without
        // any store churn.
        TimelineView(.periodic(from: .now, by: 60)) { context in
            sessionList(now: context.date)
        }
        .safeAreaInset(edge: .top, spacing: 0) {
            if let summary = model.filterSummary {
                SessionFilterSummary(summary: summary, onClear: model.clearFilters)
            }
        }
        .onChange(of: model.machineFilterIds, initial: true) { _, _ in
            model.reconcileFilters()
        }
        .task {
            // Explicit fetch on entry: the snapshot may be stale and a
            // `resume: ok` handshake deliberately skips the REST resync.
            if selection != nil {
                await model.refreshOnFirstAppearance()
            } else {
                await model.refresh()
            }
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
        .alert(
            "Rename Session",
            isPresented: Binding(
                get: { renameTarget != nil },
                set: { if !$0 { renameTarget = nil } }
            ),
            presenting: renameTarget
        ) { row in
            TextField("Session name", text: $renameText)
            Button("Cancel", role: .cancel) {}
            Button("Save") {
                let name = renameText.trimmingCharacters(in: .whitespacesAndNewlines)
                // An untouched title must not freeze an agent-generated one.
                if name != row.title {
                    model.renameSession(sessionId: row.id, name: name)
                }
            }
            .disabled(!SessionNameRules.isValid(renameText))
        }
        .alert(
            "Delete Session",
            isPresented: Binding(
                get: { deleteTarget != nil },
                set: { if !$0 { deleteTarget = nil } }
            ),
            presenting: deleteTarget
        ) { row in
            Button("Delete", role: .destructive) {
                model.deleteSession(sessionId: row.id)
            }
            Button("Cancel", role: .cancel) {}
        } message: { row in
            Text(SessionNameRules.deleteMessage(title: row.title))
        }
    }

    // MARK: - List

    private func sessionList(now: Date) -> some View {
        let rows = model.rows
        let pinnedCount = SessionListModel.pinnedCount(of: rows)
        return List(selection: selection) {
            if pinnedCount > 0 {
                Section {
                    ForEach(rows.prefix(pinnedCount)) { row in
                        rowCell(row, now: now)
                    }
                } header: {
                    sectionHeader("Pinned")
                }
                .listSectionSeparator(.hidden, edges: .top)
            }
            if rows.count > pinnedCount {
                // Headerless when nothing is pinned: an empty-string Section
                // header still reserves a blank sticky band above the list
                // (device feedback: "一片空白").
                if pinnedCount > 0 {
                    Section {
                        ForEach(rows.dropFirst(pinnedCount)) { row in
                            rowCell(row, now: now)
                        }
                    } header: {
                        // Not "Sessions": the navigation title already says so.
                        sectionHeader("Recent")
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
        // The default plain header height leaves a blank band between
        // Pinned and Recent; headers size to their compact text instead.
        .environment(\.defaultMinListHeaderHeight, 0)
        // An explicit filter change starts at the top. SSE/count/name changes
        // keep this identity (and the reading position), as does chat return.
        .id(model.filters)
        .accessibilityIdentifier("home.sessions")
        .overlay {
            if rows.isEmpty {
                emptyState
                    .allowsHitTesting(false) // keep the pull-to-refresh gesture
            }
        }
    }

    private func rowCell(_ row: SessionRowUI, now: Date) -> some View {
        Group {
            if selection != nil {
                NavigationLink(value: row.id) {
                    rowLabel(row, now: now)
                }
                .tag(row.id)
            } else {
                Button {
                    onOpenSession(row.id)
                } label: {
                    rowLabel(row, now: now)
                }
                .buttonStyle(.plain)
            }
        }
        .listRowInsets(EdgeInsets(top: 12, leading: 16, bottom: 12, trailing: 16))
        // Default separator color reads heavy against these rows; the theme
        // divider is the WeChat-style faint hairline.
        .listRowSeparatorTint(theme.divider)
        .swipeActions(edge: .leading) {
            leadingSwipeActions(row)
        }
        .swipeActions(edge: .trailing) {
            trailingSwipeActions(row)
        }
        .contextMenu {
            contextMenuActions(row)
        }
    }

    /// Compact header (Mail-style) instead of the large plain-list default.
    private func sectionHeader(_ title: LocalizedStringKey) -> some View {
        Text(title)
            .font(.footnote.weight(.semibold))
            .foregroundStyle(theme.textSecondary)
            .textCase(nil)
            .listRowInsets(EdgeInsets(top: 4, leading: 16, bottom: 4, trailing: 16))
    }

    /// Leading swipe: the quick toggles (pin, read), as in Mail.
    @ViewBuilder
    private func leadingSwipeActions(_ row: SessionRowUI) -> some View {
        let isPinned = row.summary.pinned == true || row.summary.globalPinned == true
        Button {
            model.setPinMode(sessionId: row.id, mode: isPinned ? .none : .project)
        } label: {
            Label(isPinned ? "Unpin" : "Pin to Project",
                  systemImage: isPinned ? "pin.slash.fill" : "pin.fill")
        }
        .tint(.orange)
        if row.unread {
            Button {
                model.markRead(sessionId: row.id)
            } label: {
                Label("Mark as Read", systemImage: "envelope.open.fill")
            }
            .tint(theme.accent)
        }
    }

    /// Trailing swipe mirrors the context menu's lifecycle actions: the hub
    /// archives live sessions only; inactive ones are deleted or reopened.
    @ViewBuilder
    private func trailingSwipeActions(_ row: SessionRowUI) -> some View {
        if row.summary.active {
            Button {
                model.archiveSession(sessionId: row.id)
            } label: {
                Label("Archive", systemImage: "archivebox.fill")
            }
            .tint(.indigo)
        } else {
            // Not role: .destructive — that removes the row before the
            // confirmation alert has a chance to cancel.
            Button {
                deleteTarget = row
            } label: {
                Label("Delete…", systemImage: "trash.fill")
            }
            .tint(.red)
            Button {
                model.reopenSession(sessionId: row.id) { sessionId in
                    onOpenSession(sessionId)
                }
            } label: {
                Label("Reopen", systemImage: "arrow.clockwise")
            }
            .tint(.gray)
        }
    }

    private func rowLabel(_ row: SessionRowUI, now: Date) -> some View {
        SessionRowView(row: row, now: now)
            .frame(maxWidth: .infinity, alignment: .leading)
            .contentShape(Rectangle())
    }

    @ViewBuilder
    private func contextMenuActions(_ row: SessionRowUI) -> some View {
        let summary = row.summary
        Button {
            renameText = row.title
            renameTarget = row
        } label: {
            Label("Rename…", systemImage: "pencil")
        }
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
        // The hub archives live sessions only (409 for an inactive one);
        // inactive history is reopened or deleted instead.
        if summary.active {
            Button(role: .destructive) {
                model.archiveSession(sessionId: row.id)
            } label: {
                Label("Archive", systemImage: "archivebox")
            }
        } else {
            Button {
                model.reopenSession(sessionId: row.id) { sessionId in
                    onOpenSession(sessionId)
                }
            } label: {
                Label("Reopen", systemImage: "arrow.clockwise")
            }
            Button(role: .destructive) {
                deleteTarget = row
            } label: {
                Label("Delete…", systemImage: "trash")
            }
        }
    }

    // MARK: - Chrome

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
        } else if model.isSearching {
            ContentUnavailableView.search(text: model.searchQuery)
        } else if model.hasActiveFilters {
            ContentUnavailableView {
                Label("No matching sessions", systemImage: "line.3.horizontal.decrease.circle")
            } description: {
                Text("Clear the filters to see every session.")
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
    @Environment(\.hapiTheme) private var theme
    @ScaledMetric(relativeTo: .body) private var iconSize: CGFloat = 30
    @ScaledMetric(relativeTo: .footnote) private var statusSlotSize: CGFloat = 16

    let row: SessionRowUI
    let now: Date

    private let iconSpacing: CGFloat = 12

    var body: some View {
        HStack(alignment: .center, spacing: iconSpacing) {
            agentIcon
            VStack(alignment: .leading, spacing: 3) {
                titleLine
                detailLine
            }
        }
        // Separators start under the text column, as in Mail and Messages.
        .alignmentGuide(.listRowSeparatorLeading) { _ in iconSize + iconSpacing }
        .accessibilityElement(children: .combine)
        .accessibilityValue(row.unread ? Text("Unread") : Text(verbatim: ""))
        .accessibilityIdentifier("home.session.\(row.id)")
    }

    /// The agent owns the leading column; a presence badge marks connected
    /// sessions (pulsing while the agent works) instead of dimming the rest.
    private var agentIcon: some View {
        AgentFlavorIconView(flavor: row.flavor, size: iconSize * 0.8)
            .frame(width: iconSize, height: iconSize)
            .overlay(alignment: .bottomTrailing) {
                if row.summary.active {
                    presenceBadge
                }
            }
    }

    private var presenceBadge: some View {
        let isRunning = row.status == .running
        return Image(systemName: "circle.fill")
            .font(.system(size: iconSize * 0.3))
            .foregroundStyle(theme.success)
            .symbolEffect(.pulse, options: .repeating, isActive: isRunning)
            .padding(2)
            .background(Circle().fill(theme.background))
            .offset(x: 2, y: 2)
            .accessibilityLabel(isRunning ? Text("Running") : Text("Connected"))
    }

    private var titleLine: some View {
        HStack(spacing: 8) {
            Text(verbatim: row.title)
                .font(.body)
                .fontWeight(row.unread ? .semibold : .regular)
                .foregroundStyle(theme.textPrimary)
                .lineLimit(1)
            Spacer(minLength: 4)
            // Unread is a semibold title plus an accent timestamp, not a
            // dot: the presence badge is the row's only dot.
            Text(verbatim: formatRelativeAge(now: now, thenEpochMs: row.summary.updatedAt))
                .font(.footnote)
                .fontWeight(row.unread ? .semibold : .regular)
                .foregroundStyle(row.unread ? theme.accent : theme.textSecondary)
                .monospacedDigit()
                .fixedSize()
        }
    }

    /// Project left; only states that need the user (reply/approval) get a
    /// trailing symbol. Routine activity lives on the icon badge.
    private var detailLine: some View {
        HStack(alignment: .center, spacing: 0) {
            // Keep the same text line height when metadata is missing,
            // so the row height does not jump.
            Text(verbatim: row.project ?? " ")
                .lineLimit(1)
                .accessibilityHidden(row.project == nil)
            Spacer(minLength: 12)
            if let status = row.status, let symbol = status.symbolName {
                Image(systemName: symbol)
                    .symbolVariant(.none)
                    .symbolRenderingMode(.monochrome)
                    .foregroundStyle(attentionColor)
                    // One slot keeps every attention symbol aligned.
                    .frame(width: statusSlotSize, height: statusSlotSize)
                    .fixedSize()
                    .layoutPriority(1)
                    .accessibilityLabel(statusAccessibilityText(status))
            }
        }
        .font(.footnote)
        .foregroundStyle(theme.textSecondary)
    }

    // Darker amber keeps thin strokes visible on white without a filled
    // symbol, background badge or animation competing with the session title.
    private var attentionColor: Color {
        theme.isDark ? theme.warning : Color(hex: 0x9A6700)
    }

    /// Keep the exact request count available to VoiceOver without adding
    /// another visible number or badge to every waiting conversation.
    private func statusAccessibilityText(_ status: SessionRowStatus) -> Text {
        let title = Text(LocalizedStringKey(status.titleKey))
        if let count = status.count, count > 1 {
            return Text("\(title) · \(count) requests")
        }
        return title
    }
}

// MARK: - Rename / delete copy (shared by the list and the chat menu)

enum SessionNameRules {
    /// Hub `PATCH /sessions/:id` accepts 1–255 characters.
    static func isValid(_ name: String) -> Bool {
        let trimmed = name.trimmingCharacters(in: .whitespacesAndNewlines)
        return !trimmed.isEmpty && trimmed.utf16.count <= 255
    }

    static func deleteMessage(title: String) -> String {
        String(format: String(localized: "Delete “%@”? This can't be undone."), title)
    }
}

// MARK: - Recent-directory chip (used by NewSessionView)

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
