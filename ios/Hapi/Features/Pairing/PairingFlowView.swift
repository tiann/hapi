import HapiClient
import SwiftUI

/// Entry to pairing: a short self-hosted explanation plus the two ways in —
/// scan the hub's QR code, or type hub URL + access token. Used as the app
/// root while unpaired (`context: .initial`) and as the add-hub sheet from
/// the home screen (`context: .addHub`).
struct PairingFlowView: View {
    enum Context {
        /// Root screen while nothing is paired.
        case initial
        /// Presented as a sheet to pair an additional hub.
        case addHub
    }

    var context: Context = .initial

    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @State private var showScanner = false
    @State private var showManualEntry = false

    private static let docsURL = URL(string: "https://app.hapi.run/docs/")

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(spacing: 24) {
                    if context == .initial, let failedHub = model.authFailureNotice {
                        authFailureBanner(failedHub: failedHub)
                    }

                    VStack(spacing: 12) {
                        Image(systemName: "antenna.radiowaves.left.and.right")
                            .font(.system(size: 56))
                            .foregroundStyle(.tint)
                            .padding(.top, context == .initial ? 48 : 24)
                        Text(context == .initial
                            ? String(localized: "Pair with your hub")
                            : String(localized: "Add another hub"))
                            .font(.title.bold())
                        Text("HAPI is self-hosted: your agent sessions run on your own machine, served by a hub you operate. Start the hub on your computer, then pair this app with the QR code it prints — or enter the hub URL and access token by hand.")
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                        .multilineTextAlignment(.center)
                        if let docsURL = Self.docsURL {
                            Link("Setup guide", destination: docsURL)
                                .font(.subheadline)
                        }
                    }
                    .padding(.horizontal, 24)

                    VStack(spacing: 12) {
                        Button {
                            showScanner = true
                        } label: {
                            Label("Scan QR Code", systemImage: "qrcode.viewfinder")
                                .frame(maxWidth: .infinity)
                        }
                        .buttonStyle(.borderedProminent)
                        .controlSize(.large)

                        Button {
                            showManualEntry = true
                        } label: {
                            Label("Enter Manually", systemImage: "keyboard")
                                .frame(maxWidth: .infinity)
                        }
                        .buttonStyle(.bordered)
                        .controlSize(.large)
                    }
                    .padding(.horizontal, 24)
                }
                .frame(maxWidth: 480)
                .frame(maxWidth: .infinity)
            }
            .navigationTitle(context == .addHub ? String(localized: "Add Hub") : "")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                if context == .addHub {
                    ToolbarItem(placement: .cancellationAction) {
                        Button("Cancel") {
                            dismiss()
                        }
                    }
                }
            }
            .sheet(isPresented: $showScanner) {
                QRScannerView()
            }
            .sheet(isPresented: $showManualEntry) {
                ManualEntryView()
            }
        }
    }

    private func authFailureBanner(failedHub: String) -> some View {
        HStack(alignment: .top, spacing: 12) {
            Image(systemName: "exclamationmark.triangle.fill")
                .foregroundStyle(.orange)
            VStack(alignment: .leading, spacing: 4) {
                Text("Signed out of \(HubDisplay.host(failedHub))")
                    .font(.subheadline.bold())
                Text("The hub rejected the stored credentials — the access token was probably rotated. Pair again to reconnect.")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }
            Spacer(minLength: 0)
            Button {
                model.authFailureNotice = nil
            } label: {
                Image(systemName: "xmark")
                    .font(.footnote.bold())
                    .foregroundStyle(.secondary)
            }
        }
        .padding(12)
        .background(.orange.opacity(0.12), in: RoundedRectangle(cornerRadius: 12))
        .padding(.horizontal, 16)
        .padding(.top, 8)
    }
}
