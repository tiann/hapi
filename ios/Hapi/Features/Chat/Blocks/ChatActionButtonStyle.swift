import HapiUI
import SwiftUI

/// Inline chat actions own their outer size instead of adding system bordered-
/// button padding to an already-sized label. This is presentation only: plans,
/// approvals and answers keep their separate interaction paths.
struct ChatActionButtonStyle: ButtonStyle {
    enum Emphasis {
        case primary
        case secondary
        case destructive
    }

    let emphasis: Emphasis
    var fillsWidth = true
    @Environment(\.hapiTheme) private var theme
    @Environment(\.isEnabled) private var isEnabled

    private var foreground: Color {
        switch emphasis {
        case .primary: theme.background
        case .secondary: theme.textPrimary
        case .destructive: theme.danger
        }
    }

    func makeBody(configuration: Configuration) -> some View {
        let shape = RoundedRectangle(cornerRadius: 10, style: .continuous)
        configuration.label
            .multilineTextAlignment(.center)
            .padding(.horizontal, 12)
            .padding(.vertical, 10)
            .frame(minWidth: 44, maxWidth: fillsWidth ? .infinity : nil, minHeight: 44)
            .foregroundStyle(foreground)
            .background(emphasis == .primary ? theme.link : Color.clear, in: shape)
            .overlay(shape.strokeBorder(emphasis == .primary ? Color.clear : theme.divider, lineWidth: 1))
            .contentShape(shape)
            .opacity(isEnabled ? (configuration.isPressed ? 0.8 : 1) : 0.5)
    }
}
