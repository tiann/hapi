import HapiClient
import Observation

/// Inline pairing progress/error state shared by manual entry (token or
/// passkey), QR scan, and the deep-link confirm step.
@Observable @MainActor
final class PairingAttempt {
    private(set) var isPairing = false
    var failure: PairingFailure?

    func pair(_ model: AppModel, hubUrl: String, accessToken: String) {
        guard !isPairing else { return }
        isPairing = true
        failure = nil
        Task {
            do {
                try await model.pair(hubUrl: hubUrl, accessToken: accessToken)
                // Success: AppModel flips to .paired and tears down the
                // presenting hierarchy; nothing to do here.
            } catch let pairingFailure as PairingFailure {
                failure = pairingFailure
            } catch {
                failure = .unreachable
            }
            isPairing = false
        }
    }

    /// URL-only passkey sign-in. Dismissing the system sheet is not an
    /// error: the form simply returns to its idle state.
    func signInWithPasskey(_ model: AppModel, hubUrl: String) {
        guard !isPairing else { return }
        isPairing = true
        failure = nil
        Task {
            do {
                try await model.signInWithPasskey(hubUrl: hubUrl)
            } catch PasskeyError.canceled {
                // Silent.
            } catch let pairingFailure as PairingFailure {
                failure = pairingFailure
            } catch {
                failure = .unreachable
            }
            isPairing = false
        }
    }
}
