import SwiftUI
import UIKit

/// SwiftUI's interactiveDismissDisabled blocks the gesture silently. Forward
/// presentation callbacks while offering the same discard choice as Cancel.
struct ScratchlistDismissGuard: UIViewControllerRepresentable {
    let blocked: Bool
    let onAttempt: () -> Void

    func makeCoordinator() -> Coordinator { Coordinator() }
    func makeUIViewController(context: Context) -> UIViewController { UIViewController() }
    func updateUIViewController(_ controller: UIViewController, context: Context) {
        context.coordinator.blocked = blocked
        context.coordinator.onAttempt = onAttempt
        DispatchQueue.main.async { [weak controller, coordinator = context.coordinator] in
            guard var root = controller else { return }
            while let parent = root.parent { root = parent }
            guard let presentation = root.presentationController else { return }
            if presentation.delegate !== coordinator {
                coordinator.previous = presentation.delegate
                presentation.delegate = coordinator
            }
        }
    }

    final class Coordinator: NSObject, UIAdaptivePresentationControllerDelegate {
        var blocked = false
        var onAttempt: (() -> Void)?
        weak var previous: (any UIAdaptivePresentationControllerDelegate)?

        func presentationControllerShouldDismiss(_ controller: UIPresentationController) -> Bool {
            !blocked && (previous?.presentationControllerShouldDismiss?(controller) ?? true)
        }
        func presentationControllerDidAttemptToDismiss(_ controller: UIPresentationController) {
            if blocked { onAttempt?() }
            else { previous?.presentationControllerDidAttemptToDismiss?(controller) }
        }
        func presentationControllerWillDismiss(_ controller: UIPresentationController) {
            previous?.presentationControllerWillDismiss?(controller)
        }
        func presentationControllerDidDismiss(_ controller: UIPresentationController) {
            previous?.presentationControllerDidDismiss?(controller)
        }
    }
}
