import HapiClient
import HapiProtocol
import SwiftUI

/// Manual pairing path for hubs without `--relay` (nothing to scan): type or
/// paste the hub URL and the access token the hub prints at startup, then
/// pair directly with inline progress and error states.
struct ManualEntryView: View {
    @Environment(\.dismiss) private var dismiss
    @Environment(AppModel.self) private var model
    @State private var hubUrl = ""
    @State private var accessToken = ""
    @State private var attempt = PairingAttempt()

    private var canPair: Bool {
        !hubUrl.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            && !accessToken.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField("http://192.168.1.20:3006", text: $hubUrl)
                        .keyboardType(.URL)
                        .textContentType(.URL)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .disabled(attempt.isPairing)
                } header: {
                    Text("Hub URL")
                } footer: {
                    Text("The address the hub prints at startup — a LAN address like http://192.168.1.20:3006, or the public tunnel URL when running with --relay.")
                }

                Section {
                    TextField("Access token", text: $accessToken)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .monospaced()
                        .disabled(attempt.isPairing)
                } header: {
                    Text("Access token")
                } footer: {
                    Text("Printed by the hub at startup, and shown in the web app under Settings → Companion Pairing. Pasting a full pairing link into either field also works.")
                }

                if let failure = attempt.failure {
                    Section {
                        PairingErrorView(failure: failure)
                    }
                }

                Section {
                    Button {
                        pairNow()
                    } label: {
                        if attempt.isPairing {
                            HStack(spacing: 8) {
                                ProgressView()
                                Text("Pairing…")
                            }
                            .frame(maxWidth: .infinity)
                        } else {
                            Text(attempt.failure == nil ? String(localized: "Pair") : String(localized: "Try Again"))
                                .frame(maxWidth: .infinity)
                        }
                    }
                    .disabled((!canPair && parsePastedLink() == nil) || attempt.isPairing)
                }
            }
            .navigationTitle("Enter Hub Details")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") {
                        dismiss()
                    }
                }
            }
            .interactiveDismissDisabled(attempt.isPairing)
        }
    }

    /// Convenience: a whole pairing link pasted into either field carries
    /// both values at once.
    private func parsePastedLink() -> BindLink? {
        BindLink.parse(hubUrl) ?? BindLink.parse(accessToken)
    }

    private func pairNow() {
        if let link = parsePastedLink() {
            attempt.pair(model, hubUrl: link.hubUrl, accessToken: link.accessToken)
            return
        }
        var address = hubUrl.trimmingCharacters(in: .whitespacesAndNewlines)
        // Typing the scheme on a phone is annoying; local hubs serve plain
        // HTTP.
        if !address.isEmpty, !address.contains("://") {
            address = "http://\(address)"
        }
        attempt.pair(
            model,
            hubUrl: address,
            accessToken: accessToken.trimmingCharacters(in: .whitespacesAndNewlines)
        )
    }
}
