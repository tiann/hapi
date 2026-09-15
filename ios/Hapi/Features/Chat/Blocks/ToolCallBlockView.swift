import HapiClient
import HapiProtocol
import HapiUI
import SwiftUI

/// A bounded activity summary. Ordinary tools open the shared inspector;
/// sidechains open their own transcript. Questions, plans and approvals stay inline.
struct ToolCallBlockView: View {
    let block: ToolCallBlock
    let basePath: String?

    @Environment(\.hapiTheme) private var theme
    @Environment(\.hapiTypography) private var typography
    @Environment(\.chatInteractions) private var interactions
    @Environment(\.openChatTool) private var openTool

    var body: some View {
        if isQuestionDetailsTool(block.tool.name) {
            QuestionToolCard(block: block)
        } else {
            activityCard
        }
    }

    @ViewBuilder
    private var activityCard: some View {
        let presentation = toolSummaryPresentation(block.tool, basePath: basePath)
        VStack(alignment: .leading, spacing: 0) {
            headerRow(presentation)
            if let plan = planProposalMarkdown(block.tool) {
                PlanProposalContent(markdown: plan)
                    .padding(12)
                    .accessibilityIdentifier("plan-proposal-\(block.id)")
                if let interactions {
                    CodexPlanActionsView(planId: block.tool.id, interactions: interactions)
                }
            }
            if let permission = block.tool.permission {
                if permission.status == .pending, let interactions {
                    PermissionApprovalView(
                        tool: block.tool, requestId: permission.id, interactions: interactions,
                        openInput: { openTool?(block) }
                    )
                } else {
                    PermissionStateRow(permission: permission)
                }
            }
            if opensToolProcess(block) {
                Button { openTool?(block) } label: {
                    Label(
                        String(format: String(localized: "View process · %lld steps"), Int64(block.children.count)),
                        systemImage: "arrow.right"
                    )
                    .font(typography.captionFont)
                    .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .foregroundStyle(theme.textSecondary)
                .padding(.horizontal, 10)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(theme.surface)
        .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
    }

    private func headerRow(_ presentation: ToolCardPresentation) -> some View {
        ToolSummaryRow(
            presentation: presentation, state: block.tool.state,
            showsStatus: block.tool.state != .pending || block.tool.permission?.status != .pending
        ) { openTool?(block) }
            .accessibilityHint(opensToolProcess(block)
                ? String(localized: "View agent process") : String(localized: "View tool details"))
            .accessibilityIdentifier("tool-summary-\(block.id)")
    }
}

/// Lightweight, read-only row shared by the conversation and group browser.
/// Tool output and approval controls are deliberately not part of this view.
struct ToolSummaryRow: View {
    let presentation: ToolCardPresentation
    let state: ToolCallState
    var showsStatus = true
    let action: () -> Void
    @Environment(\.hapiTheme) private var theme
    @Environment(\.hapiTypography) private var typography

    var body: some View {
        Button(action: action) {
            // An approval owns its status below this summary. Without a
            // status chip, keep the chevron beside the title, not on an orphan row.
            let stacksStatus = typography.usesStackedToolLayout && showsStatus
            let layout = stacksStatus
                ? AnyLayout(VStackLayout(alignment: .leading, spacing: 8))
                : AnyLayout(HStackLayout(spacing: 8))
            layout {
                HStack(alignment: .firstTextBaseline, spacing: 8) {
                    Image(systemName: presentation.icon)
                        .font(typography.toolSubtitleFont)
                        .foregroundStyle(theme.textSecondary)
                        .frame(width: typography.toolIconWidth)
                    VStack(alignment: .leading, spacing: 3) {
                        Text(presentation.title)
                            .font(typography.toolTitleFont)
                            .foregroundStyle(theme.textPrimary)
                            .lineLimit(typography.usesStackedToolLayout ? 2 : 1)
                            .truncationMode(.middle)
                            .fixedSize(horizontal: false, vertical: true)
                        if let subtitle = presentation.subtitle {
                            Text(subtitle)
                                .font(typography.toolSubtitleFont)
                                .foregroundStyle(theme.textSecondary)
                                // Full commands belong in the inspector, not above approval controls.
                                .lineLimit(typography.usesStackedToolLayout ? 2 : 1)
                                .truncationMode(.tail)
                                .fixedSize(horizontal: false, vertical: true)
                        }
                    }
                }
                if !stacksStatus { Spacer(minLength: 8) }
                HStack(spacing: 8) {
                    if showsStatus && state != .completed {
                        ToolStatusIndicator(state: state)
                    }
                    Image(systemName: "chevron.right")
                        .font(typography.captionFont)
                        .foregroundStyle(theme.textSecondary)
                }
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 6)
            .frame(minHeight: 44)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityValue(state == .completed ? String(localized: "Completed") : "")
    }
}

// MARK: - Status

struct ToolStatusIndicator: View {
    let state: ToolCallState

    var body: some View {
        switch state {
        case .running:
            ProgressView()
                .controlSize(.small)
                .accessibilityLabel("Running")
        case .pending:
            StatusChip(text: String(localized: "pending"), tint: .secondary)
        case .error:
            StatusChip(text: String(localized: "error"), tint: .red)
        case .completed:
            Image(systemName: "checkmark")
                .font(.caption)
                .foregroundStyle(.secondary)
                .accessibilityLabel("Completed")
        }
    }
}

private struct StatusChip: View {
    let text: String
    let tint: Color

    var body: some View {
        Text(text)
            .font(.footnote)
            .foregroundStyle(tint)
            .padding(.horizontal, 6)
            .padding(.vertical, 2)
            .background(tint.opacity(0.14), in: RoundedRectangle(cornerRadius: 6))
    }
}

// MARK: - Permission (read-only)

/// Read-only verdict in the inspector or a non-interactive transcript. Live
/// approvals share the same quiet status treatment in PermissionApprovalView.
struct PermissionStateRow: View {
    let permission: ToolPermission
    var horizontalInset: CGFloat = 12

    var body: some View {
        Group {
            switch permission.status {
            case .pending:
                PermissionPendingStatus()
            case .approved:
                PermissionLine(text: String(localized: "✓ Approved") + (permission.mode.map { " · \($0)" } ?? ""))
            case .denied:
                PermissionLine(
                    text: String(localized: "✕ Denied") + (permission.reason.map { " · \($0)" } ?? ""),
                    isError: true
                )
            case .resolved:
                PermissionLine(text: String(localized: "Resolved in Codex"))
            case .canceled:
                PermissionLine(text: String(localized: "— Canceled"))
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal, horizontalInset)
        .padding(.vertical, 6)
    }
}

private struct PermissionLine: View {
    let text: String
    var isError = false
    @Environment(\.hapiTheme) private var theme
    @Environment(\.hapiTypography) private var typography

    var body: some View {
        Text(text)
            .font(typography.captionFont)
            .foregroundStyle(isError ? theme.danger : theme.textSecondary)
            .fixedSize(horizontal: false, vertical: true)
    }
}
