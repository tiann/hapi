import HapiClient
import Observation

/// Inline pairing progress/error state shared by manual entry, QR scan,
/// and the deep-link confirm step.
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
}
