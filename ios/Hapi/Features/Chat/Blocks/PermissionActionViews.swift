import HapiClient
import HapiProtocol
import HapiUI
import SwiftUI

/// The process page also hosts permissions. Reuse the same question form there,
/// without an inspector button that would reopen the current process.
struct PendingPermissionFooter: View {
    let tool: ChatToolCall
    let requestId: String
    let interactions: ChatInteractor

    var body: some View {
        if isQuestionDetailsTool(tool.name) {
            if interactions.permissionOverrides[requestId] == .alreadyHandled {
                AlreadyHandledLine()
            } else {
                QuestionAnswerFormView(
                    tool: tool, requestId: requestId, enabled: true,
                    submitting: interactions.permissionOverrides[requestId] == .resolving,
                    openDetails: nil,
                    submit: { interactions.resolvePermission(requestId: requestId, action: $0) }
                )
            }
        } else {
            PermissionApprovalView(tool: tool, requestId: requestId, interactions: interactions)
        }
    }
}

/// One approval surface in both the conversation and the process page. The
/// latter omits the input link because its full input is already on screen.
struct PermissionApprovalView: View {
    let tool: ChatToolCall
    let requestId: String
    let interactions: ChatInteractor
    var openInput: (() -> Void)?
    @Environment(\.hapiTheme) private var theme
    @Environment(\.hapiTypography) private var typography

    var body: some View {
        let override = interactions.permissionOverrides[requestId]
        VStack(alignment: .leading, spacing: 8) {
            header(override: override)
                .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
            if override != .alreadyHandled {
                PermissionActionsRow(
                    options: PermissionActionOptions(flavor: interactions.flavor, toolName: tool.name),
                    requestId: requestId,
                    resolving: override == .resolving
                ) { action in
                    interactions.resolvePermission(requestId: requestId, action: action)
                }
            }
        }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(theme.surface, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
    }

    private func header(override: PermissionRowOverride?) -> some View {
        ViewThatFits(in: .horizontal) {
            HStack(spacing: 8) {
                status(override).fixedSize(horizontal: true, vertical: true)
                Spacer(minLength: 0)
                inputLink.fixedSize(horizontal: true, vertical: true)
            }
            VStack(alignment: .leading, spacing: 4) {
                status(override)
                inputLink
            }
        }
    }

    private func status(_ override: PermissionRowOverride?) -> some View {
        PermissionPendingStatus(override: override)
            .accessibilityIdentifier("permission-status-\(requestId)")
    }

    @ViewBuilder
    private var inputLink: some View {
        if let openInput {
            Button(action: openInput) {
                Label("View full input", systemImage: "arrow.up.right.square")
                    .font(typography.captionFont)
                    .fixedSize(horizontal: false, vertical: true)
                    .frame(minHeight: 44, alignment: .leading)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .foregroundStyle(theme.link)
            .accessibilityIdentifier("permission-input-\(requestId)")
        }
    }
}

/// UI projection of the existing flavor/tool gates, not a new permission policy.
struct PermissionActionOptions: Equatable {
    let denyAction: PermissionAction
    let canAllowForSession: Bool
    let canAllowAllEdits: Bool

    var hasMore: Bool { canAllowForSession || canAllowAllEdits }

    init(flavor: String?, toolName: String) {
        let codex = isCodexPermissionUX(flavor: flavor, toolName: toolName)
        denyAction = codex ? .abort : .deny
        canAllowForSession = codex || !PermissionGates.hideAllowForSession.contains(toolName)
        canAllowAllEdits = flavor == "claude" && PermissionGates.editTools.contains(toolName)
    }
}

struct PermissionActionsRow: View {
    let options: PermissionActionOptions
    let requestId: String
    let resolving: Bool
    let submit: (PermissionAction) -> Void
    @Environment(\.hapiTypography) private var typography

    var body: some View {
        Group {
            if typography.usesStackedToolLayout {
                VStack(spacing: 8) { buttons(horizontal: false) }
            } else {
                ViewThatFits(in: .horizontal) {
                    HStack(spacing: 8) { buttons(horizontal: true) }
                    VStack(spacing: 8) { buttons(horizontal: false) }
                }
            }
        }
        .font(typography.toolTitleFont)
        .disabled(resolving)
    }

    @ViewBuilder
    private func buttons(horizontal: Bool) -> some View {
        Button { submit(.allow) } label: {
            Text("Allow").fixedSize(horizontal: horizontal, vertical: true)
        }
        .buttonStyle(ChatActionButtonStyle(emphasis: .primary))
        .accessibilityIdentifier("permission-allow-\(requestId)")

        Button { submit(options.denyAction) } label: {
            Text(options.denyAction == .abort ? LocalizedStringKey("Abort") : LocalizedStringKey("Deny"))
                .fixedSize(horizontal: horizontal, vertical: true)
        }
        .buttonStyle(ChatActionButtonStyle(emphasis: .destructive))
        .accessibilityIdentifier("permission-deny-\(requestId)")

        if options.hasMore {
            Menu {
                if options.canAllowForSession {
                    Button("Allow for this session") { submit(.allowForSession) }
                }
                if options.canAllowAllEdits {
                    Button("Allow all edits") { submit(.allowAllEdits) }
                }
            } label: {
                if horizontal {
                    Image(systemName: "ellipsis").frame(width: 20)
                } else {
                    Label("More approval options", systemImage: "ellipsis")
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            .buttonStyle(ChatActionButtonStyle(emphasis: .secondary, fillsWidth: !horizontal))
            .accessibilityLabel("More approval options")
            .accessibilityIdentifier("permission-more-\(requestId)")
        }
    }
}

/// Progress occupies the status icon's slot, never replaces the more menu or
/// changes the action widths. An already-handled request is no longer waiting.
struct PermissionPendingStatus: View {
    var override: PermissionRowOverride?
    @Environment(\.hapiTheme) private var theme
    @Environment(\.hapiTypography) private var typography

    private var title: LocalizedStringKey {
        switch override {
        case .resolving: "Submitting approval…"
        case .alreadyHandled: "Already handled elsewhere"
        case nil: "Awaiting approval"
        }
    }

    var body: some View {
        Label {
            // The warning token is an accent, not a small-text color on the
            // light surface. Keep the caption readable in every palette.
            Text(title)
                .foregroundStyle(theme.textSecondary)
                .fixedSize(horizontal: false, vertical: true)
        } icon: {
            Group {
                if override == .resolving {
                    ProgressView().controlSize(.small).tint(theme.textSecondary)
                } else {
                    Image(systemName: override == .alreadyHandled ? "checkmark.circle" : "hourglass")
                }
            }
            .frame(width: typography.captionSize, height: typography.captionSize)
            .foregroundStyle(override == nil ? theme.warning : theme.textSecondary)
            .accessibilityHidden(true)
        }
        .font(typography.captionFont)
    }
}

private struct AlreadyHandledLine: View {
    var body: some View {
        PermissionPendingStatus(override: .alreadyHandled)
            .padding(12)
    }
}
