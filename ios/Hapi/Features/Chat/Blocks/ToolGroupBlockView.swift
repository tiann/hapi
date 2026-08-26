import HapiProtocol
import HapiUI
import SwiftUI

/// Run of adjacent groupable tools (web `ToolGroupCard`): a one-line summary
/// — count + first targets + error/running signals — expanding to the
/// individual `ToolCallBlockView`s. Codex exploration groups honor their
/// `defaultOpen`.
struct ToolGroupBlockView: View {
    let block: ToolGroupBlock
    let basePath: String?

    @State private var expanded: Bool
    @Environment(\.hapiTheme) private var theme

    init(block: ToolGroupBlock, basePath: String?) {
        self.block = block
        self.basePath = basePath
        _expanded = State(initialValue: block.defaultOpen)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            headerRow
            if expanded {
                VStack(alignment: .leading, spacing: 6) {
                    ForEach(block.tools, id: \.id) { tool in
                        ToolCallBlockView(block: tool, basePath: basePath)
                    }
                }
                .padding(.horizontal, 10)
                .padding(.bottom, 10)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(theme.surface)
        .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
    }

    private var headerRow: some View {
        Button {
            withAnimation(.easeInOut(duration: 0.15)) {
                expanded.toggle()
            }
        } label: {
            HStack(spacing: 8) {
                Image(systemName: "wrench.and.screwdriver")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                    .frame(width: 18)
                VStack(alignment: .leading, spacing: 1) {
                    Text(title)
                        .font(.subheadline)
                        .foregroundStyle(theme.textPrimary)
                        .lineLimit(1)
                    if !summaryText.isEmpty {
                        Text(summaryText)
                            .font(.caption2)
                            .foregroundStyle(.secondary)
                            .lineLimit(1)
                    }
                }
                Spacer(minLength: 8)
                trailingIndicator
            }
            .padding(.horizontal, 10)
            .padding(.vertical, 8)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }

    private var title: String {
        if let activityTitle = block.activityTitle {
            return activityTitle
        }
        let count = block.summary.totalTools
        return count == 1
            ? String(localized: "1 tool")
            : String(format: String(localized: "%lld tools"), Int64(count))
    }

    /// "file, other-file +2" digest from the group summary targets.
    private var summaryText: String {
        let summary = block.summary
        let targets = summary.fileTargets + summary.searchTargets
            + summary.commandTargets + summary.urlTargets + summary.otherTargets
        guard !targets.isEmpty else { return "" }
        let shown = targets.prefix(3)
            .map { target -> String in
                let tail = target.split(separator: "/").last.map(String.init) ?? target
                return tail.isEmpty ? target : tail
            }
            .joined(separator: ", ")
        let more = targets.count - 3
        return more > 0 ? "\(shown) +\(more)" : shown
    }

    @ViewBuilder
    private var trailingIndicator: some View {
        if block.summary.runningCount > 0 {
            ProgressView()
                .controlSize(.small)
        } else if block.summary.errorCount > 0 {
            Text("\(block.summary.errorCount) ⚠")
                .font(.caption2)
                .foregroundStyle(.red)
        } else {
            Image(systemName: expanded ? "chevron.down" : "chevron.right")
                .font(.caption)
                .foregroundStyle(.secondary)
        }
    }
}
