import HapiUI
import SwiftUI

/// One expandable home affordance. Future filter dimensions belong in this
/// menu, not in a row of always-visible machine / status / agent chips.
struct SessionFilterMenu: View {
    @Environment(\.hapiTheme) private var theme
    let model: SessionListModel

    var body: some View {
        Menu {
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
                        Text("\(machine.sessionCount) sessions")
                        if model.activeMachineFilter == machine.id { Image(systemName: "checkmark") }
                    }
                    .accessibilityLabel(Text("\(machine.label), \(machine.sessionCount) sessions"))
                    .accessibilityAddTraits(model.activeMachineFilter == machine.id ? .isSelected : [])
                }
            }
            if model.activeMachineFilter != nil {
                Divider()
                Button("Clear Filters", systemImage: "line.3.horizontal.decrease.circle") {
                    model.clearFilters()
                }
            }
        } label: {
            Label("Filters", systemImage: model.activeMachineFilter == nil
                  ? "line.3.horizontal.decrease.circle" : "line.3.horizontal.decrease.circle.fill")
                .frame(minWidth: 44, minHeight: 44)
        }
        .tint(model.activeMachineFilter == nil ? .primary : theme.accent)
        .accessibilityValue(model.filterSummary ?? String(localized: "No filters"))
        .accessibilityIdentifier("home.filters")
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
