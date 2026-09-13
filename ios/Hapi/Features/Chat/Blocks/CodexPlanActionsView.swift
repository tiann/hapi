import HapiClient
import HapiUI
import SwiftUI

/// A plan menu, not an approval footer. The proposal remains readable after
/// its live id is withdrawn; only the current root proposal can be executed.
struct CodexPlanActionsView: View {
    let planId: String
    let interactions: ChatInteractor
    @Environment(\.hapiTypography) private var typography

    var body: some View {
        let state = interactions.codexPlanActions(planId: planId)
        if state.isVisible {
            VStack(alignment: .leading, spacing: 8) {
                if let error = state.error {
                    Text(verbatim: LocalizedNoticeMapper.map(error))
                        .font(typography.captionFont)
                        .foregroundStyle(.red)
                        .accessibilityIdentifier("plan-error-\(planId)")
                }
                if state.available || state.pending {
                    // Stack on narrow phones and at large Dynamic Type sizes;
                    // labels stay complete and every action has a 44 pt target.
                    VStack(alignment: .leading, spacing: 4) {
                        Button { interactions.implementCodexPlan(planId: planId) } label: {
                            HStack {
                                if state.pending { ProgressView().controlSize(.small) }
                                Text("Implement plan")
                            }
                            .frame(maxWidth: .infinity, minHeight: 44)
                            .contentShape(Rectangle())
                        }
                        .buttonStyle(.borderedProminent)
                        .accessibilityIdentifier("plan-implement-\(planId)")
                        Button { interactions.continueCodexPlan(planId: planId) } label: {
                            Text("Continue planning")
                                .frame(maxWidth: .infinity, minHeight: 44)
                                .contentShape(Rectangle())
                        }
                        .buttonStyle(.bordered)
                        .accessibilityIdentifier("plan-continue-\(planId)")
                    }
                    .font(typography.toolTitleFont)
                    .disabled(!state.canAct)
                }
            }
            .padding(12)
        }
    }
}
