import SwiftUI

/// Available before pairing as well as in settings; never includes hub credentials.
struct PrivacyPolicyLink: View {
    private static let destination = URL(string: "https://hapi.run/docs/privacy")

    var body: some View {
        if let destination = Self.destination {
            Link("Privacy Policy", destination: destination)
                .accessibilityIdentifier("privacyPolicyLink")
        }
    }
}
