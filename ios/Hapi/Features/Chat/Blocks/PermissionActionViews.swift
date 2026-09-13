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
            PermissionActionsRow(tool: tool, requestId: requestId, interactions: interactions)
        }
    }
}

/// Ordinary approvals retain their existing permission-specific controls.
struct PermissionActionsRow: View {
    let tool: ChatToolCall
    let requestId: String
    let interactions: ChatInteractor
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize

    var body: some View {
        let override = interactions.permissionOverrides[requestId]
        if override == .alreadyHandled {
            AlreadyHandledLine()
        } else {
            let resolving = override == .resolving
            let codex = isCodexPermissionUX(flavor: interactions.flavor, toolName: tool.name)
            let canAllowForSession = !codex && !PermissionGates.hideAllowForSession.contains(tool.name)
            let canAllowAllEdits = interactions.flavor == "claude"
                && PermissionGates.editTools.contains(tool.name)

            let layout = dynamicTypeSize.isAccessibilitySize
                ? AnyLayout(VStackLayout(alignment: .leading, spacing: 8))
                : AnyLayout(HStackLayout(spacing: 8))
            layout {
                Button {
                    interactions.resolvePermission(requestId: requestId, action: .allow)
                } label: {
                    Text("Allow")
                        .fixedSize(horizontal: false, vertical: true)
                        .frame(maxWidth: .infinity, minHeight: 44)
                }
                .buttonStyle(.bordered)
                .tint(.green)

                Button {
                    interactions.resolvePermission(requestId: requestId, action: codex ? .abort : .deny)
                } label: {
                    Text(codex ? String(localized: "Abort") : String(localized: "Deny"))
                        .fixedSize(horizontal: false, vertical: true)
                        .frame(maxWidth: .infinity, minHeight: 44)
                }
                .buttonStyle(.bordered)
                .tint(.red)

                if resolving {
                    ProgressView()
                        .controlSize(.small)
                } else if codex || canAllowForSession || canAllowAllEdits {
                    Menu {
                        if codex || canAllowForSession {
                            Button("Allow for this session") {
                                interactions.resolvePermission(requestId: requestId, action: .allowForSession)
                            }
                        }
                        if canAllowAllEdits {
                            Button("Allow all edits") {
                                interactions.resolvePermission(requestId: requestId, action: .allowAllEdits)
                            }
                        }
                    } label: {
                        Image(systemName: "ellipsis")
                            .frame(minWidth: 44, minHeight: 44)
                            .contentShape(Rectangle())
                    }
                }
            }
            .disabled(resolving)
            .padding(.horizontal, 10)
            .padding(.vertical, 6)
        }
    }
}

private struct AlreadyHandledLine: View {
    var body: some View {
        Text("Already handled elsewhere")
            .font(.caption)
            .foregroundStyle(.secondary)
            .padding(.horizontal, 10)
            .padding(.vertical, 6)
    }
}
