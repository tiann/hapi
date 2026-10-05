import HapiClient
import HapiUI
import SwiftUI

/// A plan menu, not an approval footer. The proposal remains readable after
/// its live id is withdrawn; only the current root proposal can be executed.
struct CodexPlanActionsView: View {
    let planId: String
    let interactions: ChatInteractor
    @Environment(\.hapiTheme) private var theme
    @Environment(\.hapiTypography) private var typography

    var body: some View {
        let state = interactions.codexPlanActions(planId: planId)
        if state.isVisible {
            VStack(alignment: .leading, spacing: 8) {
                if let error = state.error {
                    Text(verbatim: LocalizedNoticeMapper.map(error))
                        .font(typography.captionFont)
                        .foregroundStyle(theme.danger)
                        .accessibilityIdentifier("plan-error-\(planId)")
                }
                if state.available || state.pending {
                    // Prefer one compact row, but never squeeze or truncate
                    // the labels to fit a narrow column or larger text size.
                    ViewThatFits(in: .horizontal) {
                        HStack(spacing: 8) {
                            buttons(state: state, horizontal: true)
                        }
                        VStack(spacing: 8) {
                            buttons(state: state, horizontal: false)
                        }
                    }
                    .font(typography.toolTitleFont)
                    .disabled(!state.canAct)
                }
            }
            .padding(12)
        }
    }

    @ViewBuilder
    private func buttons(state: CodexPlanActionState, horizontal: Bool) -> some View {
        Button { interactions.implementCodexPlan(planId: planId) } label: {
            HStack(spacing: 8) {
                if state.pending {
                    ProgressView()
                        .controlSize(.small)
                        .tint(theme.background)
                        .accessibilityHidden(true)
                }
                Text("Implement plan")
            }
            .fixedSize(horizontal: horizontal, vertical: true)
        }
        .buttonStyle(ChatActionButtonStyle(emphasis: .primary))
        .accessibilityIdentifier("plan-implement-\(planId)")

        Button { interactions.continueCodexPlan(planId: planId) } label: {
            Text("Continue planning")
                .fixedSize(horizontal: horizontal, vertical: true)
        }
        .buttonStyle(ChatActionButtonStyle(emphasis: .secondary))
        .accessibilityIdentifier("plan-continue-\(planId)")
    }
}
