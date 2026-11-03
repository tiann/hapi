import SwiftUI
import UIKit
import UniformTypeIdentifiers

/// A selection-aware multiline input on every supported iOS version. UIKit
/// owns selection and IME marked text while editing; SwiftUI owns the draft.
struct ComposerTextView: UIViewRepresentable {
    @Binding var text: String
    @Binding var selection: NSRange
    @Binding var isFocused: Bool
    @Binding var isComposing: Bool
    let font: UIFont
    let accessibilityLabel: String
    /// Mac: a bare Return submits through this handler (true = consumed);
    /// Shift/Option-Return and IME commits still edit the text.
    var onReturn: (() -> Bool)? = nil
    /// Pasted images and copied files become attachments instead of text.
    var onPasteItems: (([NSItemProvider]) -> Void)? = nil

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
        view.onReturn = onReturn
        view.onPasteItems = onPasteItems
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
        var onReturn: (() -> Bool)?
        var onPasteItems: (([NSItemProvider]) -> Void)?

        /// Only image-only clipboards and copied files; anything with text
        /// keeps the normal text paste.
        private var pastesAttachments: Bool {
            guard onPasteItems != nil else { return false }
            let board = UIPasteboard.general
            return board.types.contains(UTType.fileURL.identifier) || (board.hasImages && !board.hasStrings)
        }

        override func canPerformAction(_ action: Selector, withSender sender: Any?) -> Bool {
            if action == #selector(paste(_:)), pastesAttachments { return true }
            return super.canPerformAction(action, withSender: sender)
        }

        override func paste(_ sender: Any?) {
            if pastesAttachments, let onPasteItems {
                onPasteItems(UIPasteboard.general.itemProviders)
                return
            }
            super.paste(sender)
        }

        #if targetEnvironment(macCatalyst)
        override func pressesBegan(_ presses: Set<UIPress>, with event: UIPressesEvent?) {
            if markedTextRange == nil, let key = presses.first?.key,
               key.keyCode == .keyboardReturnOrEnter || key.keyCode == .keypadEnter,
               key.modifierFlags.isDisjoint(with: [.shift, .alternate, .command, .control]),
               onReturn?() == true {
                return
            }
            super.pressesBegan(presses, with: event)
        }
        #endif

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
