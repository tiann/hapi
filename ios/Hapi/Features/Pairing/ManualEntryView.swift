import HapiClient
import SwiftUI

/// Manual pairing path for hubs without `--relay` (nothing to scan): type or
/// paste the hub URL and the access token the hub prints at startup, then
/// pair directly with inline progress and error states. The `.passkey` mode
/// asks only for the hub URL and signs in with a native passkey that must
/// belong to that hub (used when the passkey does not name its hub).
struct ManualEntryView: View {
    enum Mode {
        case accessToken
        case passkey
    }

    let mode: Mode

    @Environment(\.dismiss) private var dismiss
    @Environment(AppModel.self) private var model
    @State private var attempt: PairingAttempt

    /// `initialFailure` explains why the form opened (e.g. a passkey without
    /// its hub address); editing the form clears it.
    init(mode: Mode = .accessToken, initialFailure: PairingFailure? = nil) {
        self.mode = mode
        _attempt = State(initialValue: PairingAttempt(failure: initialFailure))
    }

    var body: some View {
        NavigationStack {
            ManualPairingFormView(
                isPairing: attempt.isPairing,
                failure: attempt.failure,
                passkeyOnly: mode == .passkey
            ) {
                attempt.failure = nil
            } onPair: { submission in
                attempt.pair(
                    model,
                    hubUrl: submission.hubURL,
                    accessToken: submission.accessToken,
                    cloudflareAccessToken: submission.cloudflareAccessToken
                )
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
    @State private var showCloudflareAccess = false
    @State private var cloudflareAccessToken = ""

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
                cloudflareAccessSection
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
        .onChange(of: form.passkeyHubURL) { _, _ in
            cloudflareAccessToken = ""
        }
        .onChange(of: failure) { _, result in
            if result == .cloudflareAccessRequired {
                showCloudflareAccess = true
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

    private var cloudflareAccessSection: some View {
        Section {
            DisclosureGroup("Cloudflare Access", isExpanded: $showCloudflareAccess) {
                SecureField("Application token", text: $cloudflareAccessToken)
                    .autocorrectionDisabled()
                    .textInputAutocapitalization(.never)
                    .accessibilityIdentifier("pairing.cloudflareAccessToken")
                    .disabled(isPairing)
                Text("For hubs behind Cloudflare Access, enter the application token issued after you sign in with cloudflared.")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }
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
        guard var submission = form.submission else { return }
        let token = cloudflareAccessToken.trimmingCharacters(in: .whitespacesAndNewlines)
        submission.cloudflareAccessToken = token.isEmpty ? nil : token
        focusedField = nil
        onPair(submission)
    }
}
