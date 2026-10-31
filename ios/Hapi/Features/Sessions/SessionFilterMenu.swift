import HapiUI
import SwiftUI

/// One expandable home affordance: the unread lens, machine selection (two
/// or more machines) and Mark All as Read. Future filter dimensions belong in
/// this menu, not in a row of always-visible machine / status / agent chips.
struct SessionFilterMenu: View {
    @Environment(\.hapiTheme) private var theme
    let model: SessionListModel
    @State private var confirmMarkAllRead = false

    var body: some View {
        Menu {
            Section {
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
            Label("Filters", systemImage: model.hasActiveFilters
                  ? "line.3.horizontal.decrease.circle.fill" : "line.3.horizontal.decrease.circle")
                .frame(minWidth: 44, minHeight: 44)
        }
        .tint(model.hasActiveFilters ? theme.accent : .primary)
        .accessibilityValue(model.filterSummary ?? String(localized: "No filters"))
        .accessibilityIdentifier("home.filters")
        .alert("Mark All as Read?", isPresented: $confirmMarkAllRead) {
            Button("Mark as Read") { model.markAllRead() }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text(String(
                format: String(localized: "Marks %lld unread sessions as read on this device."),
                Int64(model.unreadCount)
            ))
        }
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
