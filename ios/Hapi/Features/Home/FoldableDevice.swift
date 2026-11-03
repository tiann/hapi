import Observation
import SwiftUI
import UIKit

/// Whether this phone has a hinge (iPhone Duo) and can unfold to a
/// tablet-width display. UIKit reports hinges only asynchronously through
/// `UIHingeInteraction`, so this starts false and latches true for the
/// process; a nil update only means the probe left its hierarchy.
@MainActor @Observable
final class FoldableDevice {
    static let shared = FoldableDevice()

    private(set) var hasHinge = false

    func recordHinge() {
        if !hasHinge { hasHinge = true }
    }
}

/// Invisible view that reports a hinge to `FoldableDevice.shared`.
struct HingeProbe: UIViewRepresentable {
    func makeUIView(context: Context) -> UIView {
        let view = UIView()
        view.isUserInteractionEnabled = false
        if #available(iOS 27.1, *) {
            view.addInteraction(UIHingeInteraction { _, update in
                if update.hinge != nil { FoldableDevice.shared.recordHinge() }
            })
        }
        return view
    }

    func updateUIView(_ uiView: UIView, context: Context) {}
}
