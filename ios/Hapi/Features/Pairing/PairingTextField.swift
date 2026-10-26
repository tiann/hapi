import SwiftUI
import UIKit

/// A narrow bridge for this form: distinguish a user-initiated system paste
/// from typing, without inspecting UIPasteboard or rewriting each keystroke.
struct PairingTextField: UIViewRepresentable {
    @Binding var text: String
    @Binding var focusedField: ManualPairingForm.Field?
    let field: ManualPairingForm.Field
    let placeholder: String
    let accessibilityLabel: String
    let isEnabled: Bool
    var onPaste: (String) -> Bool
    var onEndEditing: () -> Void
    var onReturn: () -> Void

    @ScaledMetric(relativeTo: .body) private var fontSize = 17

    func makeCoordinator() -> Coordinator { Coordinator(self) }

    func makeUIView(context: Context) -> NativeField {
        let view = NativeField()
        view.delegate = context.coordinator
        view.pasteDelegate = context.coordinator
        view.addTarget(context.coordinator, action: #selector(Coordinator.changed(_:)), for: .editingChanged)
        view.autocapitalizationType = .none
        view.autocorrectionType = .no
        view.spellCheckingType = .no
        view.smartQuotesType = .no
        view.smartDashesType = .no
        view.clearButtonMode = .whileEditing
        view.setContentHuggingPriority(.defaultLow, for: .horizontal)
        view.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        return view
    }

    func updateUIView(_ view: NativeField, context: Context) {
        context.coordinator.owner = self
        // Avoid resetting the selection/marked text on ordinary keystrokes.
        if view.text != text { view.text = text }
        view.placeholder = placeholder
        view.accessibilityLabel = accessibilityLabel
        view.accessibilityIdentifier = field == .address ? "pairing.address" : "pairing.accessToken"
        view.font = field == .address
            ? .systemFont(ofSize: fontSize)
            : .monospacedSystemFont(ofSize: fontSize, weight: .regular)
        view.keyboardType = field == .address ? .URL : .default
        view.textContentType = field == .address ? .URL : nil
        view.returnKeyType = field == .address ? .next : .go
        view.allowsEditing = isEnabled
        view.wantsFocus = focusedField == field && isEnabled
        view.updateFocus()
    }

    func sizeThatFits(_ proposal: ProposedViewSize, uiView: NativeField, context: Context) -> CGSize? {
        CGSize(width: proposal.width ?? max(0, uiView.intrinsicContentSize.width),
               height: max(44, uiView.intrinsicContentSize.height))
    }

    static func dismantleUIView(_ uiView: NativeField, coordinator: Coordinator) {
        uiView.wantsFocus = false
        uiView.delegate = nil
        uiView.pasteDelegate = nil
    }

    final class NativeField: UITextField {
        var wantsFocus = false
        var allowsEditing = true

        override func didMoveToWindow() {
            super.didMoveToWindow()
            updateFocus()
        }

        func updateFocus() {
            // Disabling/focusing a field can trigger UIKit layout and editing
            // callbacks. Do that outside SwiftUI's updateUIView transaction.
            DispatchQueue.main.async { [weak self] in
                guard let self else { return }
                if isEnabled != allowsEditing { isEnabled = allowsEditing }
                if wantsFocus, isEnabled, window != nil, !isFirstResponder {
                    becomeFirstResponder()
                } else if !wantsFocus, isFirstResponder {
                    resignFirstResponder()
                }
            }
        }
    }

    final class Coordinator: NSObject, UITextFieldDelegate, UITextPasteDelegate {
        var owner: PairingTextField

        init(_ owner: PairingTextField) { self.owner = owner }

        @objc func changed(_ textField: UITextField) {
            guard owner.isEnabled else { return }
            owner.text = textField.text ?? ""
        }

        func textFieldDidBeginEditing(_ textField: UITextField) {
            if owner.focusedField != owner.field { owner.focusedField = owner.field }
        }

        func textFieldDidEndEditing(_ textField: UITextField) {
            // Disabling a focused UITextField can synchronously end editing
            // inside updateUIView. Don't mutate SwiftUI state in that callback.
            guard owner.isEnabled else { return }
            if owner.focusedField == owner.field { owner.focusedField = nil }
            owner.onEndEditing()
        }

        func textFieldShouldReturn(_ textField: UITextField) -> Bool {
            if owner.isEnabled { owner.onReturn() }
            return false
        }

        func textField(_ textField: UITextField, shouldChangeCharactersIn range: NSRange, replacementString string: String) -> Bool {
            owner.isEnabled
        }

        func textFieldShouldClear(_ textField: UITextField) -> Bool {
            owner.isEnabled
        }

        func textPasteConfigurationSupporting(
            _ textPasteConfigurationSupporting: any UITextPasteConfigurationSupporting,
            performPasteOf attributedString: NSAttributedString,
            to textRange: UITextRange
        ) -> UITextRange {
            guard owner.isEnabled,
                  let textField = textPasteConfigurationSupporting as? UITextField,
                  textField.isEnabled else { return textRange }
            if owner.onPaste(attributedString.string) {
                textField.text = owner.text
                textField.selectedTextRange = textField.textRange(from: textField.endOfDocument, to: textField.endOfDocument)
            } else {
                // Honor the system's replacement range for ordinary text.
                textField.replace(textRange, withText: attributedString.string.trimmingCharacters(in: .whitespacesAndNewlines))
                changed(textField)
            }
            return textField.selectedTextRange ?? textRange
        }
    }
}
