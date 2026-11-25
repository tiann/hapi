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
/// - rows follow the persisted order (Active first and the sort key, within
///   the pin tiers), except while searching;
/// - per row: a two-line-tall flavor icon whose presence badge gives every
///   state its own mark (working / background / waiting / stopped); title with trailing
///   relative `updatedAt` (unread: semibold title + accent time, no dot so
///   the badge stays the only dot); a quiet second line has project left and an attention symbol right
///   (a running attached job takes the project's place). No preview, todo progress,
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
    /// Rows kept while a pushed chat covers the list (see `sessionList`).
    @State private var frozenRows: [SessionRowUI]?

    var body: some View {
        // Rows own their minute-tick age labels; the list itself only
        // changes with the data.
        Group {
            sessionList
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

    /// Covered by a pushed chat, the list keeps its last rows: on a large
    /// hub every streaming session would otherwise rebuild and diff
    /// thousands of rows nobody sees (~80 ms main-thread stalls while
    /// scrolling the chat). A side-by-side split never disappears and
    /// stays live; returning refreshes once.
    private var sessionList: some View {
        let rows = frozenRows ?? model.rows
        return KeyedContent(key: ListRenderKey(rows: rows, selectable: selection != nil,
                                               theme: theme, filters: model.filters, order: model.order)) {
            list(rows)
        }
        .equatable()
        .onAppear { frozenRows = nil }
        .onDisappear { frozenRows = model.rows }
    }

    private func list(_ rows: [SessionRowUI]) -> some View {
        let pinnedCount = SessionListModel.pinnedCount(of: rows)
        return List(selection: selection) {
            if pinnedCount > 0 {
                Section {
                    ForEach(rows.prefix(pinnedCount)) { row in
                        equatableRow(row)
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
                            equatableRow(row)
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
                            equatableRow(row)
                        }
                    }
                    .listSectionSeparator(.hidden, edges: .top)
                }
            }
        }
        .modifier(PlatformSessionListStyle())
        // The default plain header height leaves a blank band between
        // Pinned and Recent; headers size to their compact text instead.
        .environment(\.defaultMinListHeaderHeight, 0)
        // An explicit filter or order change starts at the top. SSE/count/name
        // changes keep this identity (and the reading position), as does chat
        // return.
        .id(ListIdentity(filters: model.filters, order: model.order))
        .accessibilityIdentifier("home.sessions")
        .overlay {
            if rows.isEmpty {
                emptyState
                    .allowsHitTesting(false) // keep the pull-to-refresh gesture
            }
        }
    }

    /// The List evaluates every row's content (offscreen ones included) on
    /// each list change, so one streaming session cost O(all rows) per
    /// update. Rows compare only what they draw and skip unchanged content.
    private func equatableRow(_ row: SessionRowUI) -> some View {
        KeyedContent(key: RowRenderKey(row: row, selectable: selection != nil, theme: theme)) {
            rowCell(row)
        }
        .equatable()
    }

    private func rowCell(_ row: SessionRowUI) -> some View {
        Group {
            if selection != nil {
                NavigationLink(value: row.id) {
                    rowLabel(row)
                }
                .tag(row.id)
            } else {
                Button {
                    onOpenSession(row.id)
                } label: {
                    rowLabel(row)
                }
                .buttonStyle(.plain)
            }
        }
        .listRowInsets(EdgeInsets(top: Self.rowVerticalInset, leading: 16, bottom: Self.rowVerticalInset, trailing: 16))
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

    /// Pointer rows on a Mac sidebar are denser than touch rows.
    private static var rowVerticalInset: CGFloat {
        #if targetEnvironment(macCatalyst)
        6
        #else
        12
        #endif
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

    private func rowLabel(_ row: SessionRowUI) -> some View {
        SessionRowView(row: row)
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

/// Re-renders `content` only when `key` changes. List and row content
/// capture only stable references (the model, state setters, the open
/// callback), so an equal key can keep the previous content.
private struct KeyedContent<Key: Equatable, Content: View>: View, Equatable {
    let key: Key
    @ViewBuilder let content: () -> Content

    var body: some View { content() }

    static func == (lhs: Self, rhs: Self) -> Bool { lhs.key == rhs.key }
}

private struct RowRenderKey: Equatable {
    let row: SessionRowUI
    let selectable: Bool
    let theme: HapiTheme
}

private struct ListRenderKey: Equatable {
    let rows: [SessionRowUI]
    let selectable: Bool
    let theme: HapiTheme
    let filters: SessionListFilters
    let order: SessionListOrder
}

private struct ListIdentity: Hashable {
    let filters: SessionListFilters
    let order: SessionListOrder
}

struct SessionRowView: View {
    @Environment(\.hapiTheme) private var theme
    @ScaledMetric(relativeTo: .body) private var iconSize: CGFloat = 30
    @ScaledMetric(relativeTo: .footnote) private var statusSlotSize: CGFloat = 16

    let row: SessionRowUI

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

    /// The agent owns the leading column; its presence badge carries the
    /// session state instead of dimming disconnected rows.
    private var agentIcon: some View {
        AgentFlavorIconView(flavor: row.flavor, size: iconSize * 0.8)
            .frame(width: iconSize, height: iconSize)
            .overlay(alignment: .bottomTrailing) {
                SessionPresenceBadge(presence: row.presence, size: iconSize * 0.3)
                    .offset(x: 2, y: 2)
            }
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
            // Minute ticks redraw only this label, not the list.
            TimelineView(.periodic(from: .now, by: 60)) { context in
                Text(verbatim: formatRelativeAge(now: context.date, thenEpochMs: row.summary.updatedAt))
            }
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
            if let job = row.runningJob {
                AttachedJobLine(job: job)
            } else {
                // Keep the same text line height when metadata is missing,
                // so the row height does not jump.
                Text(verbatim: row.project ?? " ")
                    .lineLimit(1)
                    .accessibilityHidden(row.project == nil)
            }
            Spacer(minLength: 12)
            if let status = row.status {
                Image(systemName: status.symbolName)
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
        if status.count > 1 {
            return Text("\(title) · \(status.count) requests")
        }
        return title
    }
}

/// A running attached job on the row's second line (web `SessionRowSummary`
/// job line, without the bar): label, then remaining or percent, then
/// elapsed wall time — never an ETA. After 15 minutes without a heartbeat it
/// turns amber and says so instead of passing frozen progress off as live.
struct AttachedJobLine: View {
    @Environment(\.hapiTheme) private var theme
    let job: AttachedJob

    var body: some View {
        // Minute ticks: elapsed and stale age are minute-granular.
        TimelineView(.periodic(from: .now, by: 60)) { context in
            let nowMs = Int(context.date.timeIntervalSince1970 * 1000)
            let stale = job.isStale(nowMs: nowMs)
            Text(verbatim: Self.text(job, nowMs: nowMs))
                .lineLimit(1)
                .foregroundStyle(stale ? staleColor : theme.success)
        }
    }

    private var staleColor: Color {
        theme.isDark ? theme.warning : Color(hex: 0x9A6700)
    }

    static func text(_ job: AttachedJob, nowMs: Int) -> String {
        var parts = [job.label]
        let unit = job.unit.map { " \($0)" } ?? ""
        if let remaining = job.remaining {
            parts.append(String(format: String(localized: "%@ left"), formatJobQuantity(remaining) + unit))
        } else if let percent = job.percent, let done = job.done, let total = job.total {
            parts.append("\(percent)%")
            parts.append("\(formatJobQuantity(done))/\(formatJobQuantity(total))\(unit)")
        }
        if job.isStale(nowMs: nowMs) {
            parts.append(String(format: String(localized: "no heartbeat %@"),
                                formatCompactElapsed(ms: max(0, nowMs - job.heartbeatAt))))
        } else {
            parts.append(formatCompactElapsed(ms: max(0, nowMs - job.startedAt)))
        }
        return parts.joined(separator: " · ")
    }
}

/// Web presence badge (#2296) at native size: shape carries the state and
/// colour keeps its old meaning. Solid green = working, solid blue =
/// background tasks only (both pulse), green ring = connected and waiting,
/// power mark = stopped or archived. The background-coloured halo separates
/// it from the agent icon.
struct SessionPresenceBadge: View {
    @Environment(\.hapiTheme) private var theme
    let presence: SessionPresence
    let size: CGFloat

    /// Tailwind blue-400, web's background-work colour in both themes.
    static let backgroundWorkColor = Color(hex: 0x60A5FA)

    var body: some View {
        mark
            .frame(width: size, height: size)
            .padding(2)
            .background(Circle().fill(theme.background))
            .accessibilityElement()
            .accessibilityLabel(Text(LocalizedStringKey(presence.titleKey)))
    }

    @ViewBuilder
    private var mark: some View {
        switch presence {
        case .working, .background:
            // SF Symbol so the system pulse animates it; the still marks
            // (ring, power) never run an animation.
            Image(systemName: "circle.fill")
                .resizable()
                .foregroundStyle(presence == .working ? theme.success : Self.backgroundWorkColor)
                .symbolEffect(.pulse, options: .repeating, isActive: presence.pulses)
        case .waiting:
            Circle()
                .strokeBorder(theme.success, lineWidth: max(1.5, size * 0.2))
        case .stopped:
            // Drawn heavier than the other symbols: it renders at ~9pt.
            Image(systemName: "power")
                .font(.system(size: size, weight: .heavy))
                .foregroundStyle(theme.textHint)
        }
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

/// Mac windows get the native sidebar list (vibrant background, rounded
/// accent selection, hover); touch layouts keep the plain list.
private struct PlatformSessionListStyle: ViewModifier {
    func body(content: Content) -> some View {
        #if targetEnvironment(macCatalyst)
        content.listStyle(.sidebar)
        #else
        content.listStyle(.plain)
        #endif
    }
}
