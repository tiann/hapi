import HapiProtocol
import SwiftUI

/// Manual pairing path for hubs without `--relay` (nothing to scan): type or
/// paste the hub URL and the access token the hub prints at startup, then
/// continue into the shared confirm step.
struct ManualEntryView: View {
    @Environment(\.dismiss) private var dismiss
    @State private var hubUrl = ""
    @State private var accessToken = ""
    @State private var pending: PendingPairing?

    private var canContinue: Bool {
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
                } header: {
                    Text("Access token")
                } footer: {
                    Text("Printed by the hub at startup, and shown in the web app under Settings → Companion Pairing. Pasting a full pairing link into either field also works.")
                }

                Section {
                    Button("Continue") {
                        continueToConfirm()
                    }
                    .frame(maxWidth: .infinity)
                    .disabled(!canContinue && parsePastedLink() == nil)
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
            .navigationDestination(item: $pending) { pending in
                PairingConfirmView(pending: pending)
            }
        }
    }

    /// Convenience: a whole pairing link pasted into either field carries
    /// both values at once.
    private func parsePastedLink() -> BindLink? {
        BindLink.parse(hubUrl) ?? BindLink.parse(accessToken)
    }

    private func continueToConfirm() {
        if let link = parsePastedLink() {
            pending = PendingPairing(
                hubUrl: link.hubUrl,
                accessToken: link.accessToken,
                source: .manual
            )
            return
        }
        var address = hubUrl.trimmingCharacters(in: .whitespacesAndNewlines)
        // Typing the scheme on a phone is annoying; local hubs serve plain
        // HTTP, and the confirm step shows the resulting URL before pairing.
        if !address.isEmpty, !address.contains("://") {
            address = "http://\(address)"
        }
        pending = PendingPairing(
            hubUrl: address,
            accessToken: accessToken.trimmingCharacters(in: .whitespacesAndNewlines),
            source: .manual
        )
    }
}
