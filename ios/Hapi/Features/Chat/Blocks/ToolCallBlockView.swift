import HapiClient
import HapiProtocol
import HapiUI
import SwiftUI

/// One tool invocation (web `ToolCard`): collapsed header row — icon, title,
/// subtitle, status — expanding to the per-tool body (`ToolCallBody`), the
/// permission state, and nested children (sidechain transcript behind an
/// indent rail). Cards with a pending permission start expanded and carry the
/// "awaiting approval" banner; with a `\.chatInteractions` engine present
/// (A-M3b) the banner grows the actionable approval footer.
struct ToolCallBlockView: View {
    let block: ToolCallBlock
    let basePath: String?

    @State private var expanded: Bool
    @State private var childrenOpen: Bool
    @Environment(\.hapiTheme) private var theme
    @Environment(\.chatInteractions) private var interactions

    init(block: ToolCallBlock, basePath: String?) {
        self.block = block
        self.basePath = basePath
        let pending = block.tool.permission?.status == .pending
        _expanded = State(initialValue: pending)
        _childrenOpen = State(initialValue: pending)
    }

    var body: some View {
        let presentation = toolCardPresentation(block.tool, basePath: basePath)
        VStack(alignment: .leading, spacing: 0) {
            headerRow(presentation)
            if let permission = block.tool.permission {
                if permission.status == .pending, let interactions {
                    pendingApprovalSection(permission: permission, interactions: interactions)
                } else {
                    PermissionStateRow(permission: permission)
                }
            }
            if expanded {
                ToolCallBody(tool: block.tool, basePath: basePath)
                    .padding(.horizontal, 10)
                    .padding(.bottom, 10)
            }
            if !block.children.isEmpty {
                childrenSection
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(theme.surface)
        .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
    }

    /// Pending permission with a live interaction engine: highlighted banner
    /// plus the actionable footer (approve buttons / answer forms).
    private func pendingApprovalSection(
        permission: ToolPermission,
        interactions: ChatInteractor
    ) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            Label("Awaiting approval", systemImage: "hourglass")
                .font(.footnote.weight(.semibold))
                .foregroundStyle(.orange)
                .padding(.horizontal, 10)
                .padding(.top, 6)
            PendingPermissionFooter(
                tool: block.tool,
                requestId: permission.id,
                interactions: interactions
            )
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(.orange.opacity(0.10))
    }

    private func headerRow(_ presentation: ToolCardPresentation) -> some View {
        Button {
            withAnimation(.easeInOut(duration: 0.15)) {
                expanded.toggle()
            }
        } label: {
            HStack(spacing: 8) {
                Image(systemName: presentation.icon)
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                    .frame(width: 18)
                VStack(alignment: .leading, spacing: 1) {
                    Text(presentation.title)
                        .font(.subheadline)
                        .foregroundStyle(theme.textPrimary)
                        .lineLimit(1)
                    if let subtitle = presentation.subtitle {
                        Text(subtitle)
                            .font(.caption2)
                            .foregroundStyle(.secondary)
                            .lineLimit(1)
                    }
                }
                Spacer(minLength: 8)
                ToolStatusIndicator(state: block.tool.state)
            }
            .padding(.horizontal, 10)
            .padding(.vertical, 8)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }

    /// Sidechain children, nested behind an indent rail; collapsed to a
    /// count row.
    private var childrenSection: some View {
        VStack(alignment: .leading, spacing: 0) {
            Button {
                withAnimation(.easeInOut(duration: 0.15)) {
                    childrenOpen.toggle()
                }
            } label: {
                Label(
                    block.children.count == 1
                        ? String(localized: "1 agent step")
                        : String(format: String(localized: "%lld agent steps"), Int64(block.children.count)),
                    systemImage: childrenOpen ? "chevron.down" : "chevron.right"
                )
                .font(.caption)
                .foregroundStyle(.secondary)
                .padding(.horizontal, 10)
                .padding(.vertical, 6)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            if childrenOpen {
                HStack(alignment: .top, spacing: 10) {
                    RoundedRectangle(cornerRadius: 1)
                        .fill(theme.divider)
                        .frame(width: 2)
                    VStack(alignment: .leading, spacing: 8) {
                        ForEach(block.children, id: \.id) { child in
                            ChatSubBlockView(block: child, basePath: basePath)
                        }
                    }
                }
                .padding(.leading, 12)
                .padding(.trailing, 8)
                .padding(.bottom, 10)
            }
        }
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
        case .pending:
            StatusChip(text: String(localized: "pending"), tint: .secondary)
        case .error:
            StatusChip(text: String(localized: "error"), tint: .red)
        case .completed:
            Image(systemName: "checkmark")
                .font(.caption)
                .foregroundStyle(.secondary)
        }
    }
}

private struct StatusChip: View {
    let text: String
    let tint: Color

    var body: some View {
        Text(text)
            .font(.caption2)
            .foregroundStyle(tint)
            .padding(.horizontal, 6)
            .padding(.vertical, 2)
            .background(tint.opacity(0.14), in: RoundedRectangle(cornerRadius: 6))
    }
}

// MARK: - Permission (read-only)

/// Read-only permission verdict: highlighted banner while pending (shown only
/// without a `\.chatInteractions` engine — previews/tests; the live chat
/// renders `PendingPermissionFooter` instead), subdued line once decided.
private struct PermissionStateRow: View {
    let permission: ToolPermission

    var body: some View {
        switch permission.status {
        case .pending:
            Label("Awaiting approval", systemImage: "hourglass")
                .font(.footnote.weight(.semibold))
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.horizontal, 10)
                .padding(.vertical, 6)
                .background(.orange.opacity(0.18))
                .foregroundStyle(.orange)
        case .approved:
            PermissionLine(text: String(localized: "✓ Approved") + (permission.mode.map { " · \($0)" } ?? ""))
        case .denied:
            PermissionLine(
                text: String(localized: "✕ Denied") + (permission.reason.map { " · \($0)" } ?? ""),
                isError: true
            )
        case .canceled:
            PermissionLine(text: String(localized: "— Canceled"))
        }
    }
}

private struct PermissionLine: View {
    let text: String
    var isError = false

    var body: some View {
        Text(text)
            .font(.caption2)
            .foregroundStyle(isError ? AnyShapeStyle(.red) : AnyShapeStyle(.secondary))
            .padding(.horizontal, 10)
            .padding(.bottom, 6)
    }
}
