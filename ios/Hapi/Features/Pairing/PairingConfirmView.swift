import HapiClient
import SwiftUI

/// Confirmation step for the deep-link path (`hapicompanion://bind`) — the
/// one entry where an external link initiates pairing, so an explicit user
/// confirmation stays in between. Manual entry and QR scan pair inline.
///
/// On success `AppModel` clears all pairing presentation state and flips to
/// `.paired`, which dismisses this view's container — nothing to do here.
struct PairingConfirmView: View {
    let pending: PendingPairing

    @Environment(AppModel.self) private var model
    @State private var attempt = PairingAttempt()

    private var isAddingAnotherHub: Bool {
        if case .paired = model.state { return true }
        return false
    }

    var body: some View {
        Form {
            Section {
                LabeledContent("Hub") {
                    Text(pending.hubUrl)
                        .multilineTextAlignment(.trailing)
                        .textSelection(.enabled)
                }
                LabeledContent("Access token") {
                    Text(HubDisplay.maskedToken(pending.accessToken))
                        .monospaced()
                }
            } footer: {
                Text(isAddingAnotherHub
                    ? String(localized: "This hub will be added to your paired hubs and become active.")
                    : String(localized: "The app checks the hub is reachable, then exchanges the token for a session."))
            }

            if let failure = attempt.failure {
                Section {
                    PairingErrorView(failure: failure)
                }
            }

            Section {
                Button {
                    attempt.pair(model, hubUrl: pending.hubUrl, accessToken: pending.accessToken)
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
                .disabled(attempt.isPairing)
            }
        }
        .navigationTitle(isAddingAnotherHub ? String(localized: "Add Hub") : String(localized: "Pair"))
        .navigationBarTitleDisplayMode(.inline)
        .interactiveDismissDisabled(attempt.isPairing)
    }
}

/// The pairing screen's error states, one presentation per
/// ``PairingFailure`` case.
struct PairingErrorView: View {
    let failure: PairingFailure

    var body: some View {
        Label {
            VStack(alignment: .leading, spacing: 4) {
                Text(title)
                    .font(.headline)
                Text(message)
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
            }
        } icon: {
            Image(systemName: icon)
                .foregroundStyle(.red)
        }
    }

    private var icon: String {
        switch failure {
        case .invalidHubURL: "questionmark.circle"
        case .unreachable: "wifi.exclamationmark"
        case .protocolMismatch: "arrow.triangle.2.circlepath"
        case .invalidAccessToken: "key"
        case .hubError: "exclamationmark.triangle"
        case .storageFailure: "externaldrive.badge.xmark"
        }
    }

    private var title: String {
        switch failure {
        case .invalidHubURL: String(localized: "Invalid hub URL")
        case .unreachable: String(localized: "Hub unreachable")
        case .protocolMismatch: String(localized: "Version mismatch")
        case .invalidAccessToken: String(localized: "Token rejected")
        case .hubError: String(localized: "Hub error")
        case .storageFailure: String(localized: "Could not save")
        }
    }

    private var message: String {
        switch failure {
        case .invalidHubURL:
            String(localized: "Enter the hub's full address, e.g. http://192.168.1.20:3006.")
        case .unreachable:
            String(localized: "No HAPI hub answered at this address. Check that the hub is running and that this device can reach it (same network, or the relay tunnel is up).")
        case .protocolMismatch(let hubVersion, let supportedVersion):
            String(
                format: String(localized: "The hub speaks protocol v%lld, this app supports v%lld. Update the older side, then try again."),
                Int64(hubVersion),
                Int64(supportedVersion)
            )
        case .invalidAccessToken:
            String(localized: "The hub rejected this access token — it may have been rotated. Get a fresh pairing code from the hub and try again.")
        case .hubError(let status):
            String(
                format: String(localized: "The hub answered unexpectedly (HTTP %lld). Try again in a moment."),
                Int64(status)
            )
        case .storageFailure:
            String(localized: "Pairing succeeded but the credentials could not be stored on this device. Try again.")
        }
    }
}
