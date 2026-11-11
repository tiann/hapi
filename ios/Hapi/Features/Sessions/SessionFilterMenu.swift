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
            Section("Sort By") {
                choice("Last Message", selected: model.order.sort == .lastMessage) {
                    model.setSort(.lastMessage)
                }
                choice("Date Created", selected: model.order.sort == .created) {
                    model.setSort(.created)
                }
                Toggle(isOn: Binding(get: { model.order.activeFirst }, set: { model.setActiveFirst($0) })) {
                    Label("Active First", systemImage: "arrow.up.to.line")
                }
                .accessibilityIdentifier("home.filters.active-first")
            }
            Section("Show") {
                choice("All Sessions", selected: model.filters.status == .all) {
                    model.setStatus(.all)
                }
                choice("Active Only", selected: model.filters.status == .active) {
                    model.setStatus(.active)
                }
                choice("Archived Only", selected: model.filters.status == .archived) {
                    model.setStatus(.archived)
                }
                Toggle(isOn: Binding(get: { model.filters.unreadOnly }, set: { model.setUnreadOnly($0) })) {
                    Label("Unread Only", systemImage: "circle.inset.filled")
                }
                .accessibilityIdentifier("home.filters.unread")
            }
            if model.showsMachineFilter {
                machineSection
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

    /// Single-choice row with the same checkmark presentation as the
    /// machine options (a Picker would discard the native layout we rely on).
    private func choice(_ title: LocalizedStringKey, selected: Bool, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Text(title)
            if selected { Image(systemName: "checkmark") }
        }
        .accessibilityAddTraits(selected ? .isSelected : [])
    }

    private var machineSection: some View {
        Section("Machine") {
            Button {
                model.selectMachine(nil)
            } label: {
                Text("All Machines")
                if model.activeMachineFilter == nil { Image(systemName: "checkmark") }
            }
            .accessibilityAddTraits(model.activeMachineFilter == nil ? .isSelected : [])
            ForEach(model.machineFilters) { machine in
                Button {
                    model.selectMachine(machine.id)
                } label: {
                    // Native Menu buttons turn the second Text into a
                    // subtitle; Picker options silently discard it.
                    Text(machine.label)
                    Text("\(machine.sessionCount, specifier: "%lld") sessions")
                    if model.activeMachineFilter == machine.id { Image(systemName: "checkmark") }
                }
                .accessibilityLabel(Text("\(machine.label), \(machine.sessionCount, specifier: "%lld") sessions"))
                .accessibilityAddTraits(model.activeMachineFilter == machine.id ? .isSelected : [])
            }
        }
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
