import SwiftUI
import UIKit

/// Mac window chrome: a unified toolbar (its title is the navigation title,
/// so keep it visible), and a minimum size that still fits sidebar + chat.
/// A no-op on iOS.
struct MacWindowConfigurator: UIViewRepresentable {
    func makeUIView(context: Context) -> UIView { ProbeView() }
    func updateUIView(_ uiView: UIView, context: Context) {}

    private final class ProbeView: UIView {
        override func didMoveToWindow() {
            super.didMoveToWindow()
            #if targetEnvironment(macCatalyst)
            guard let scene = window?.windowScene else { return }
            scene.sizeRestrictions?.minimumSize = CGSize(width: 480, height: 480)
            scene.titlebar?.toolbarStyle = .unified
            #endif
        }
    }
}

/// Mac sheets default to a small fixed form size that clips long forms;
/// page sizing gives settings, new-session and pairing forms room. iOS keeps
/// its system sheet sizes and detents.
private struct MacSheetSizing: ViewModifier {
    func body(content: Content) -> some View {
        #if targetEnvironment(macCatalyst)
        if #available(macCatalyst 18.0, *) {
            content.presentationSizing(.page)
        } else {
            content
        }
        #else
        content
        #endif
    }
}

extension View {
    func macSheetSizing() -> some View { modifier(MacSheetSizing()) }
}
