import HapiClient
import HapiUI
import SwiftUI

/// Switches the app root on pairing state and hosts the presentation that
/// must survive that switch: the deep-link pairing confirm sheet, the
/// "already paired" notice, the HapiUI palette resolved from the persisted
/// theme choice (A-M4e: system follows the OS scheme, explicit modes
/// override it, OLED = dark palette on pure black), and the app-wide
/// markdown link handler.
struct RootView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.colorScheme) private var colorScheme
    @State private var themePrefs = ThemePrefs()

    var body: some View {
        @Bindable var model = model
        Group {
            switch model.state {
            case .unpaired:
                PairingFlowView()
            case .paired:
                if let session = model.session {
                    // `.id` resets navigation + list state on hub switch —
                    // each hub gets a fresh HomeView over its own stores.
                    HomeView(session: session)
                        .id(session.hubUrl)
                } else {
                    // Defensive: .paired always carries a session; fall back
                    // to pairing rather than a dead screen.
                    PairingFlowView()
                }
            }
        }
        .sheet(item: $model.pendingPairing) { pending in
            NavigationStack {
                PairingConfirmView(pending: pending)
                    .toolbar {
                        ToolbarItem(placement: .cancellationAction) {
                            Button("Cancel") {
                                model.pendingPairing = nil
                            }
                        }
                    }
            }
        }
        .alert(
            "Hub already paired",
            isPresented: Binding(
                get: { model.infoNotice != nil },
                set: { presented in
                    if !presented {
                        model.infoNotice = nil
                    }
                }
            )
        ) {
            Button("OK") {
                model.infoNotice = nil
            }
        } message: {
            Text(model.infoNotice ?? "")
        }
        .hapiTheme(themePrefs.mode.hapiTheme(systemColorScheme: colorScheme))
        // Explicit modes force the presentation's chrome to match their
        // palette; `.system` passes nil so the OS scheme flows through.
        // (Under an explicit mode `colorScheme` reflects the override, but
        // the palette resolution only consults it in `.system` mode.)
        .preferredColorScheme(themePrefs.mode.preferredColorScheme)
        .environment(themePrefs)
        .handlesHapiLinks()
    }
}

#Preview {
    RootView()
        .environment(AppModel(
            registry: HubRegistry(defaults: UserDefaults(suiteName: "preview") ?? .standard),
            credentialStore: InMemoryCredentialStore()
        ))
}
