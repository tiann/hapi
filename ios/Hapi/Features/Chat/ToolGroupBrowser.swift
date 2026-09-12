import HapiProtocol
import HapiUI
import SwiftUI

/// The list stays mounted behind its detail destination. Neither live data nor
/// returning from a detail is a scroll command; only opening and Latest are.
struct ToolGroupBrowser: View {
    let group: ToolGroupBlock
    let basePath: String?
    let isStale: Bool
    let isReconnecting: Bool
    let selectTool: (String) -> Void
    let close: () -> Void
    @State private var positionedInitially = false
    @Environment(\.hapiTheme) private var theme

    var body: some View {
        ScrollViewReader { proxy in
            List {
                ForEach(group.tools, id: \.id) { block in
                    ToolSummaryRow(presentation: toolSummaryPresentation(block.tool, basePath: basePath),
                                   state: block.tool.state) {
                        selectTool(block.id)
                    }
                    .accessibilityHint(opensToolProcess(block)
                        ? String(localized: "View agent process") : String(localized: "View tool details"))
                    .accessibilityIdentifier("tool-browser-row-\(block.id)")
                    .hapiReadingColumn()
                    .listRowInsets(EdgeInsets())
                    .listRowBackground(theme.surface)
                    .listRowSeparatorTint(theme.divider)
                    .id(block.id)
                }
            }
            .listStyle(.plain)
            .scrollContentBackground(.hidden)
            .background(theme.background)
            .accessibilityIdentifier("tool-browser")
            .task {
                guard !positionedInitially, let id = group.tools.last?.id else { return }
                positionedInitially = true
                proxy.scrollTo(id, anchor: .bottom)
            }
            .safeAreaInset(edge: .top, spacing: 0) {
                VStack(alignment: .leading, spacing: 6) {
                    Text(ToolGroupPresentation(group).categorySummary)
                        .lineLimit(2)
                        .foregroundStyle(theme.textSecondary)
                    if isStale {
                        Label("Showing the last available group. Live group updates are unavailable.", systemImage: "clock.arrow.circlepath")
                    } else if isReconnecting {
                        Label("Live updates interrupted — reconnecting…", systemImage: "wifi.slash")
                    }
                    if group.needsOlderHistory {
                        Text("Earlier calls aren't loaded. Close this view and load older messages in the conversation.")
                    }
                }
                .font(.footnote)
                .hapiReadingColumn()
                .padding(.vertical, 8)
                .background(.bar)
            }
            .safeAreaInset(edge: .bottom, spacing: 0) {
                Button {
                    if let id = group.tools.last?.id { proxy.scrollTo(id, anchor: .bottom) }
                } label: {
                    Label("Latest tool", systemImage: "arrow.down")
                        .frame(maxWidth: .infinity, minHeight: 44)
                }
                .disabled(group.tools.isEmpty)
                .accessibilityIdentifier("tool-browser-latest")
                .hapiReadingColumn()
                .padding(.vertical, 4)
                .background(.bar)
            }
        }
        .navigationTitle(ToolGroupPresentation(group).title)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .cancellationAction) {
                Button("Close", systemImage: "xmark", action: close)
                    .accessibilityIdentifier("tool-inspector-close")
            }
        }
    }
}
