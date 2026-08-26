import Foundation

/// Per-session composer draft persistence (A-M3ab — the Android `ChatDrafts`
/// twin). Production backing is `UserDefaults`, keys scoped by hub; tests use
/// an in-memory map. All access happens on the main actor (the composer's
/// isolation), so implementations may be plain synchronous stores.
@MainActor
public protocol ChatDrafts: AnyObject {
    /// The saved draft, or nil when none.
    func load(sessionId: String) -> String?

    /// Persist `text`; blank clears the key.
    func save(sessionId: String, text: String)

    func clear(sessionId: String)

    /// Resume/reopen returned a different id: carry the draft across —
    /// never clobbering a draft already typed in the target session.
    func move(fromSessionId: String, toSessionId: String)
}

/// `UserDefaults`-backed drafts, keyed `chat-draft:<scope>:<sessionId>`
/// (scope = normalized hub origin, so multi-hub drafts never collide).
public final class UserDefaultsChatDrafts: ChatDrafts {
    private let defaults: UserDefaults
    private let scope: String

    public init(scope: String, defaults: UserDefaults = .standard) {
        self.scope = scope
        self.defaults = defaults
    }

    private func key(_ sessionId: String) -> String {
        "chat-draft:\(scope):\(sessionId)"
    }

    public func load(sessionId: String) -> String? {
        let value = defaults.string(forKey: key(sessionId))
        guard let value, !value.isEmpty else { return nil }
        return value
    }

    public func save(sessionId: String, text: String) {
        if text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            defaults.removeObject(forKey: key(sessionId))
        } else {
            defaults.set(text, forKey: key(sessionId))
        }
    }

    public func clear(sessionId: String) {
        defaults.removeObject(forKey: key(sessionId))
    }

    public func move(fromSessionId: String, toSessionId: String) {
        guard fromSessionId != toSessionId else { return }
        guard let draft = load(sessionId: fromSessionId) else { return }
        defaults.removeObject(forKey: key(fromSessionId))
        if load(sessionId: toSessionId)?.isEmpty != false {
            defaults.set(draft, forKey: key(toSessionId))
        }
    }
}
