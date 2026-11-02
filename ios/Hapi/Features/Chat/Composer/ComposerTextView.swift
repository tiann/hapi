import SwiftUI
import UIKit

/// A selection-aware multiline input on every supported iOS version. UIKit
/// owns selection and IME marked text while editing; SwiftUI owns the draft.
struct ComposerTextView: UIViewRepresentable {
    @Binding var text: String
    @Binding var selection: NSRange
    @Binding var isFocused: Bool
    @Binding var isComposing: Bool
    let font: UIFont
    let accessibilityLabel: String

    func makeCoordinator() -> Coordinator { Coordinator(self) }

    func makeUIView(context: Context) -> NativeTextView {
        let view = NativeTextView()
        view.backgroundColor = .clear
        view.textContainerInset = .zero
        view.textContainer.lineFragmentPadding = 0
        view.contentInset = .zero
        view.smartQuotesType = .no
        view.smartDashesType = .no
        view.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        view.delegate = context.coordinator
        return view
    }

    func updateUIView(_ view: NativeTextView, context: Context) {
        let coordinator = context.coordinator
        coordinator.owner = self
        coordinator.applying = true
        defer { coordinator.applying = false }
        view.font = font
        view.textColor = .label
        view.accessibilityLabel = accessibilityLabel
        view.accessibilityIdentifier = "composer.text"
        let changedText = view.text != text
        let changedSelection = selection != coordinator.lastBoundSelection
        // Native feedback may reach SwiftUI in the same turn as a prefill.
        // Only an offset different from the live caret is a new edit intent.
        let requestedSelection = changedSelection && selection != view.selectedRange
        coordinator.lastBoundSelection = selection
        // Never reassign ordinary keystrokes: that would discard marked text.
        if changedText { view.text = text }
        let desired = changedText && !requestedSelection
            ? NSRange(location: text.utf16.count, length: 0) : selection
        let start = min(desired.location, text.utf16.count)
        let clamped = NSRange(location: start, length: min(desired.length, text.utf16.count - start))
        if changedText || changedSelection, view.markedTextRange == nil, view.selectedRange != clamped {
            view.selectedRange = clamped
        }
        if changedText {
            // Programmatic prefill/send/mention edits can move the caret. Publish
            // only after updateUIView, and only if no newer edit has overtaken it.
            let expected = text
            DispatchQueue.main.async { [weak view, weak coordinator] in
                guard let view, let coordinator, view.text == expected,
                      coordinator.owner.text == expected else { return }
                coordinator.publishSelection(view)
            }
        }
        view.wantsFocus = isFocused
        view.updateFocus()
    }

    func sizeThatFits(_ proposal: ProposedViewSize, uiView: NativeTextView, context: Context) -> CGSize? {
        guard let width = proposal.width, width > 0 else { return nil }
        let height = uiView.sizeThatFits(CGSize(width: width, height: .greatestFiniteMagnitude)).height
        let maximum = ceil(font.lineHeight * 6)
        uiView.isScrollEnabled = height > maximum
        return CGSize(width: width, height: min(maximum, max(ceil(font.lineHeight), height)))
    }

    static func dismantleUIView(_ uiView: NativeTextView, coordinator: Coordinator) {
        uiView.wantsFocus = false
        uiView.delegate = nil
    }

    final class NativeTextView: UITextView {
        var wantsFocus = false

        override func didMoveToWindow() {
            super.didMoveToWindow()
            updateFocus()
        }

        func updateFocus() {
            DispatchQueue.main.async { [weak self] in
                guard let self else { return }
                if wantsFocus, window != nil, !isFirstResponder { becomeFirstResponder() }
                else if !wantsFocus, isFirstResponder { resignFirstResponder() }
            }
        }
    }

    final class Coordinator: NSObject, UITextViewDelegate {
        var owner: ComposerTextView
        var applying = false
        var lastBoundSelection: NSRange

        init(_ owner: ComposerTextView) {
            self.owner = owner
            self.lastBoundSelection = owner.selection
        }

        func textViewDidChange(_ textView: UITextView) {
            guard !applying else { return }
            owner.text = textView.text
            publishSelection(textView)
            textView.invalidateIntrinsicContentSize()
        }

        func textViewDidChangeSelection(_ textView: UITextView) {
            guard !applying, textView.text == owner.text else { return }
            publishSelection(textView)
        }

        func publishSelection(_ textView: UITextView) {
            if owner.selection != textView.selectedRange { owner.selection = textView.selectedRange }
            let composing = textView.markedTextRange != nil
            if owner.isComposing != composing { owner.isComposing = composing }
        }

        func textViewDidBeginEditing(_ textView: UITextView) {
            if !applying { owner.isFocused = true }
        }

        func textViewDidEndEditing(_ textView: UITextView) {
            if !applying { owner.isFocused = false; owner.isComposing = false }
        }
    }
}
