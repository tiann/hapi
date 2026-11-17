import HapiClient
import SwiftUI

/// Manual pairing path for hubs without `--relay` (nothing to scan): type or
/// paste the hub URL and the access token the hub prints at startup, then
/// pair directly with inline progress and error states. The `.passkey` mode
/// asks only for the hub URL and signs in with a native passkey.
struct ManualEntryView: View {
    enum Mode {
        case accessToken
        case passkey
    }

    var mode: Mode = .accessToken

    @Environment(\.dismiss) private var dismiss
    @Environment(AppModel.self) private var model
    @State private var attempt = PairingAttempt()

    var body: some View {
        NavigationStack {
            ManualPairingFormView(
                isPairing: attempt.isPairing,
                failure: attempt.failure,
                passkeyOnly: mode == .passkey
            ) {
                attempt.failure = nil
            } onPair: { submission in
                attempt.pair(model, hubUrl: submission.hubURL, accessToken: submission.accessToken)
            } onPasskeySignIn: { hubURL in
                attempt.signInWithPasskey(model, hubUrl: hubURL)
            }
            .navigationTitle(mode == .passkey
                ? String(localized: "Sign in with a Passkey")
                : String(localized: "Enter Hub Details"))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") {
                        dismiss()
                    }
                    .disabled(attempt.isPairing)
                }
            }
            .interactiveDismissDisabled(attempt.isPairing)
        }
    }
}

/// The production form also runs without AppModel in app-hosted interaction
/// tests. Only the explicit submit action can invoke onPair.
struct ManualPairingFormView: View {
    let isPairing: Bool
    let failure: PairingFailure?
    /// Hub URL only: hides the access token and Pair button, and makes the
    /// passkey button the submit action.
    var passkeyOnly = false
    var onEdit: () -> Void
    var onPair: (ManualPairingForm.Submission) -> Void
    /// URL-only native passkey sign-in (shown in `passkeyOnly` mode).
    var onPasskeySignIn: ((String) -> Void)? = nil

    @Environment(\.dynamicTypeSize) private var typeSize
    @Environment(\.locale) private var locale
    @State private var form = ManualPairingForm()
    @State private var focusedField: ManualPairingForm.Field? = .address

    var body: some View {
        Form {
            Section {
                let layout = typeSize.isAccessibilitySize
                    ? AnyLayout(VStackLayout(alignment: .leading, spacing: 0))
                    : AnyLayout(HStackLayout(spacing: 12))
                layout {
                    Menu {
                        Picker("Connection protocol", selection: Binding(
                            get: { form.scheme },
                            set: { value in
                                guard !isPairing else { return }
                                form.selectScheme(value)
                                onEdit()
                            }
                        )) {
                            ForEach(ManualPairingForm.Scheme.allCases, id: \.self) { scheme in
                                Text(verbatim: scheme.prefix).tag(scheme)
                            }
                        }
                    } label: {
                        HStack(spacing: 4) {
                            Text(verbatim: form.scheme.prefix)
                            Image(systemName: "chevron.down").font(.caption)
                        }
                        .fixedSize()
                        .frame(minHeight: 44)
                    }
                    // The label draws its own chevron; Mac menus add another.
                    .menuIndicator(.hidden)
                    .accessibilityLabel("Connection protocol")
                    .accessibilityValue(form.scheme.prefix)
                    .accessibilityIdentifier("pairing.scheme")
                    .disabled(isPairing)

                    input(.address)
                }
                inputError(for: .address)
            } header: {
                Text("Hub URL")
            } footer: {
                VStack(alignment: .leading, spacing: 8) {
                    Text("Enter your hub address without the protocol, or paste a full URL or pairing link.")
                    if form.scheme == .http {
                        Label("HTTP is unencrypted and may be restricted by iOS. HTTPS is recommended.", systemImage: "exclamationmark.triangle")
                    }
                }
            }

            if !passkeyOnly {
                tokenSections
            }

            if let failure {
                Section { PairingErrorView(failure: failure) }
            }

            if !passkeyOnly {
                pairSection
            }

            if passkeyOnly, onPasskeySignIn != nil {
                passkeySection
            }
        }
    }

    @ViewBuilder
    private var tokenSections: some View {
        Section {
            input(.accessToken)
            inputError(for: .accessToken)
        } header: {
            Text("Access token")
        } footer: {
            Text("Printed by the hub at startup, or available in web Settings → Companion Pairing. You can also paste a pairing link here.")
        }

        if form.didImportLink {
            Section {
                Label("Pairing details filled in. Review them, then tap Pair.", systemImage: "checkmark.circle")
                    .foregroundStyle(.secondary)
                    .accessibilityIdentifier("pairing.imported")
            }
        }
    }

    private var pairSection: some View {
        Section {
            Button(action: pairNow) {
                if isPairing {
                    HStack(spacing: 8) {
                        ProgressView()
                            .progressViewStyle(.circular)
                        Text("Pairing…")
                    }
                    .frame(maxWidth: .infinity)
                } else {
                    Text(failure == nil ? LocalizedStringKey("Pair") : LocalizedStringKey("Try Again"))
                        .frame(maxWidth: .infinity)
                }
            }
            .accessibilityIdentifier("pairing.submit")
            .disabled(form.submission == nil || isPairing)
        }
    }

    private var passkeySection: some View {
        Section {
            Button(action: signInWithPasskey) {
                if isPairing {
                    HStack(spacing: 8) {
                        ProgressView()
                            .progressViewStyle(.circular)
                        Text("Signing in…")
                    }
                    .frame(maxWidth: .infinity)
                } else {
                    Label("Sign in with a Passkey", systemImage: "person.badge.key")
                        .frame(maxWidth: .infinity)
                }
            }
            .accessibilityIdentifier("pairing.passkey")
            .disabled(form.passkeyHubURL == nil || isPairing)
        } footer: {
            Text("Uses a passkey you added for this hub in Settings → Passkeys. No access token needed.")
        }
    }

    private func input(_ field: ManualPairingForm.Field) -> some View {
        PairingTextField(
            text: Binding(get: { form.text(for: field) }, set: { value in
                guard !isPairing else { return }
                form.edit(value, in: field)
                onEdit()
            }),
            focusedField: $focusedField,
            field: field,
            placeholder: field == .address
                ? String(localized: LocalizedStringResource("Domain or IP address", locale: locale))
                : String(localized: LocalizedStringResource("Access token", locale: locale)),
            accessibilityLabel: field == .address
                ? String(localized: LocalizedStringResource("Hub URL", locale: locale))
                : String(localized: LocalizedStringResource("Access token", locale: locale)),
            isEnabled: !isPairing,
            onPaste: { raw in
                guard !isPairing else { return false }
                let handled = form.paste(raw, into: field)
                if handled { onEdit() }
                return handled
            },
            onEndEditing: {
                guard !isPairing else { return }
                form.finishEditing(field)
            },
            onReturn: {
                guard !isPairing else { return }
                if field == .address && passkeyOnly {
                    signInWithPasskey()
                } else if field == .address {
                    form.finishEditing(field)
                    focusedField = .accessToken
                } else {
                    pairNow()
                }
            }
        )
    }

    @ViewBuilder
    private func inputError(for field: ManualPairingForm.Field) -> some View {
        if let error = form.error(for: field) {
            let message: LocalizedStringKey = switch error {
            case .invalidAddress: "Enter a valid hub domain or IP address, with an optional port."
            case .invalidLink: "This pairing link is invalid or incomplete. Copy the full link from your hub."
            case .missingToken: "Enter the access token printed by your hub."
            }
            Label(message, systemImage: "exclamationmark.circle")
                .font(.footnote)
                .foregroundStyle(.red)
                .accessibilityIdentifier(field == .address ? "pairing.addressError" : "pairing.tokenError")
        }
    }

    private func signInWithPasskey() {
        guard !isPairing else { return }
        form.finishEditing(.address)
        guard let hubURL = form.passkeyHubURL else { return }
        focusedField = nil
        onPasskeySignIn?(hubURL)
    }

    private func pairNow() {
        guard !isPairing else { return }
        form.finishEditing(.address)
        form.finishEditing(.accessToken)
        guard let submission = form.submission else { return }
        focusedField = nil
        onPair(submission)
    }
}

/// Discovery is a locator-only local ceremony. Confirm before contacting the
/// recovered Hub, then obtain a separate, Hub-bound authentication challenge.
struct PasskeyDiscoveryView: View {
    @Environment(\.dismiss) private var dismiss
    @Environment(AppModel.self) private var model
    @State private var attempt = PairingAttempt()
    @State private var discoveredHub: String?
    @State private var finding = false
    @State private var discoveryError: String?
    @State private var showManual = false

    private var busy: Bool { finding || attempt.isPairing }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    Text("Choose a passkey to find its Hub. This step does not sign you in.")
                    Button("Find Hub with a Passkey") {
                        finding = true
                        discoveredHub = nil
                        discoveryError = nil
                        attempt.failure = nil
                        Task {
                            defer { finding = false }
                            do {
                                discoveredHub = try await NativePasskeys.discoverHub(authenticator: PlatformPasskeyAuthenticator())
                            } catch PasskeyError.canceled {
                                // Silent; no Hub request has been made.
                            } catch {
                                discoveryError = String(localized: "Could not find the Hub. Try again or enter its address manually.")
                            }
                        }
                    }
                    .disabled(busy)
                }
                if let hub = discoveredHub {
                    Section {
                        Text(hub).textSelection(.enabled)
                        Text("Confirm this Hub before connecting. A separate passkey check will sign you in.")
                        Button("Sign in with a Passkey") { attempt.signInWithPasskey(model, hubUrl: hub) }
                            .disabled(busy)
                    }
                }
                if busy { ProgressView() }
                if let discoveryError { Text(discoveryError).foregroundStyle(.red) }
                if let failure = attempt.failure { PairingErrorView(failure: failure) }
                Section {
                    Button("Enter Hub address manually") { showManual = true }.disabled(busy)
                }
            }
            .navigationTitle("Sign in with a Passkey")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() }.disabled(busy) }
            }
            .interactiveDismissDisabled(busy)
            .sheet(isPresented: $showManual) { ManualEntryView(mode: .passkey).macSheetSizing() }
        }
    }
}
