import HapiProtocol
import HapiUI
import SwiftUI

/// One expandable home affordance (web "Sort and filter"): sort key and
/// Active first, the status and unread filters, machine selection (two or
/// more machines) and Mark All as Read. Future filter dimensions belong in
/// this menu, not in a row of always-visible machine / status / agent chips.
/// Choices apply immediately; ordering persists, filters stay per home.
struct SessionFilterMenu: View {
    @Environment(\.hapiTheme) private var theme
    let model: SessionListModel
    @State private var confirmMarkAllRead = false

    var body: some View {
        Menu {
            // Native Pickers and Toggles share the system checkmark column, so
            // every row's text lines up and selection reads the same way.
            Section("Sort By") {
                Picker("Sort By", selection: Binding(get: { model.order.sort }, set: { model.setSort($0) })) {
                    Text("Last Message").tag(SessionListSort.lastMessage)
                    Text("Date Created").tag(SessionListSort.created)
                }
                .pickerStyle(.inline)
                Toggle("Active First", isOn: Binding(get: { model.order.activeFirst }, set: { model.setActiveFirst($0) }))
                    .accessibilityIdentifier("home.filters.active-first")
            }
            Section("Show") {
                Picker("Show", selection: Binding(get: { model.filters.status }, set: { model.setStatus($0) })) {
                    Text("All Sessions").tag(SessionListStatus.all)
                    Text("Active Only").tag(SessionListStatus.active)
                    Text("Archived Only").tag(SessionListStatus.archived)
                }
                .pickerStyle(.inline)
                Toggle("Unread Only", isOn: Binding(get: { model.filters.unreadOnly }, set: { model.setUnreadOnly($0) }))
                    .accessibilityIdentifier("home.filters.unread")
            }
            if model.showsMachineFilter {
                Section { machineMenu }
            }
            Section {
                Button("Mark All as Read", systemImage: "checkmark.circle") {
                    confirmMarkAllRead = true
                }
                .disabled(model.unreadCount == 0)
                .accessibilityIdentifier("home.filters.mark-all-read")
            }
            if model.hasActiveFilters {
                Divider()
                Button("Clear Filters", systemImage: "line.3.horizontal.decrease.circle") {
                    model.clearFilters()
                }
            }
        } label: {
            // No .circle variant: the iOS 26 glass button is already the
            // circle. Filters or a non-default order show through the accent
            // tint (web's dot on the trigger).
            Label("Sort & Filter", systemImage: "line.3.horizontal.decrease")
                .frame(minWidth: 44, minHeight: 44)
        }
        .tint(model.isCustomized ? theme.accent : .primary)
        .accessibilityValue(model.filterSummary ?? String(localized: "No filters"))
        .accessibilityIdentifier("home.filters")
        .alert("Mark All as Read?", isPresented: $confirmMarkAllRead) {
            Button("Mark as Read") { model.markAllRead() }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text(String(
                format: String(localized: "Marks %lld unread sessions as read across your devices."),
                Int64(model.unreadCount)
            ))
        }
    }

    /// Machines live in a submenu so a long roster never pushes the rest of
    /// the menu off screen; the row's subtitle names the current choice.
    private var machineMenu: some View {
        let selected = model.activeMachineFilter
        let selectedLabel = selected.flatMap { id in model.machineFilters.first { $0.id == id }?.label }
        return Menu {
            Toggle("All Machines", isOn: machineBinding(nil))
            Section {
                ForEach(model.machineFilters) { machine in
                    Toggle(isOn: machineBinding(machine.id)) {
                        // The second Text becomes the native menu subtitle.
                        Text(machine.label)
                        Text("\(machine.sessionCount, specifier: "%lld") sessions")
                    }
                    .accessibilityLabel(Text("\(machine.label), \(machine.sessionCount, specifier: "%lld") sessions"))
                }
            }
        } label: {
            Text("Machine")
            Text(selectedLabel ?? String(localized: "All Machines"))
        }
        .accessibilityIdentifier("home.filters.machine")
    }

    /// Radio semantics over a Toggle: turning the checked row off is a no-op.
    private func machineBinding(_ id: String?) -> Binding<Bool> {
        Binding(
            get: { model.activeMachineFilter == id },
            set: { isOn in if isOn { model.selectMachine(id) } }
        )
    }
}

/// Only applied conditions take space. No inventory counts or scrollable
/// catalogue here; names get two lines without displacing the session list.
struct SessionFilterSummary: View {
    let summary: String
    let onClear: () -> Void

    var body: some View {
        HStack(spacing: 8) {
            Text(summary)
                .font(.subheadline)
                .foregroundStyle(.secondary)
                .lineLimit(2)
                .truncationMode(.middle)
                .fixedSize(horizontal: false, vertical: true)
                .accessibilityIdentifier("home.filter-summary")
            Spacer(minLength: 0)
            Button(action: onClear) {
                Image(systemName: "xmark")
                    .font(.body)
                    .foregroundStyle(.secondary)
                    .frame(minWidth: 44, minHeight: 44)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Clear Filters")
            .accessibilityIdentifier("home.clear-filters")
        }
        .padding(.leading, 16)
        .padding(.trailing, 6)
        .background(.bar)
    }
}
