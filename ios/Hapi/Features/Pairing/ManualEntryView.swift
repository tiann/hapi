import HapiClient
import SwiftUI

/// Manual pairing path for hubs without `--relay` (nothing to scan): type or
/// paste the hub URL and the access token the hub prints at startup, then
/// pair directly with inline progress and error states.
struct ManualEntryView: View {
    @Environment(\.dismiss) private var dismiss
    @Environment(AppModel.self) private var model
    @State private var attempt = PairingAttempt()

    var body: some View {
        NavigationStack {
            ManualPairingFormView(isPairing: attempt.isPairing, failure: attempt.failure) {
                attempt.failure = nil
            } onPair: { submission in
                attempt.pair(model, hubUrl: submission.hubURL, accessToken: submission.accessToken)
            }
            .navigationTitle("Enter Hub Details")
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
    var onEdit: () -> Void
    var onPair: (ManualPairingForm.Submission) -> Void

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

            if let failure {
                Section { PairingErrorView(failure: failure) }
            }

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
                if field == .address {
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

    private func pairNow() {
        guard !isPairing else { return }
        form.finishEditing(.address)
        form.finishEditing(.accessToken)
        guard let submission = form.submission else { return }
        focusedField = nil
        onPair(submission)
    }
}
