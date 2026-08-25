import Foundation
import HapiProtocol

/// `POST /api/visibility` reporting (A-M3ab — the Android `VisibilityReporter`
/// twin): tracks the hub-minted subscription id of every live SSE pipe (fed
/// by ``onHandshake(key:subscriptionId:)`` from each pipe's handshake) and
/// reports foreground/background flips so the hub can suppress redundant push
/// notifications while the app is visibly connected.
///
/// Connect-time visibility already rides the SSE URL (`SSEClient` sends
/// `visibility=visible`), so only *transitions after connect* need a POST. A
/// `404` means the subscription died server-side — the entry is dropped (the
/// reconnect handshake re-registers a fresh id). Entries for closed pipes
/// self-heal the same way: the next flip 404s and prunes them.
@MainActor
public final class VisibilityReporter {
    private let setVisibility: @Sendable (String, VisibilityState) async throws -> Void
    private var subscriptionIds: [String: String] = [:]
    private var foreground = true

    public init(setVisibility: @escaping @Sendable (String, VisibilityState) async throws -> Void) {
        self.setVisibility = setVisibility
    }

    /// Handshake hook: remember `subscriptionId` for the pipe identified by
    /// `key` (e.g. `"global"`, `"session:<id>"`). Nil ids (older hubs) are
    /// ignored.
    public func onHandshake(key: String, subscriptionId: String?) {
        guard let subscriptionId else { return }
        subscriptionIds[key] = subscriptionId
    }

    /// Lifecycle input: report the flip to every tracked live subscription.
    public func setForeground(_ isForeground: Bool) {
        guard foreground != isForeground else { return }
        foreground = isForeground
        let visibility: VisibilityState = isForeground ? .visible : .hidden
        let snapshot = subscriptionIds
        let post = setVisibility
        Task { [weak self] in
            for (key, subscriptionId) in snapshot {
                do {
                    try await post(subscriptionId, visibility)
                } catch let error as APIError where error.status == 404 {
                    // Dead subscription — forget it unless a reconnect
                    // already stored a fresh id under the same key.
                    if let self, self.subscriptionIds[key] == subscriptionId {
                        self.subscriptionIds.removeValue(forKey: key)
                    }
                } catch {
                    // Transient/offline — the next flip retries, and the
                    // reconnect handshake re-syncs connect-time visibility.
                }
            }
        }
    }
}
