import Foundation

/// Canonical form of a hub URL: the lowercased origin, nothing else.
///
/// Everything credential- or connection-shaped is keyed by this string
/// (Keychain accounts, registry entries, `AuthManager` storage keys), so the
/// same hub typed as `https://Hub.example.com/` and scanned as
/// `https://hub.example.com` collapses to one identity.
public enum HubURLNormalization {
    /// `raw` → `scheme://host[:port]`, or `nil` when it is not an absolute
    /// http(s) URL. Trims whitespace, lowercases scheme/host, drops any
    /// path/query/fragment (including the trailing slash) and default ports.
    public static func normalize(_ raw: String) -> String? {
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty,
              let components = URLComponents(string: trimmed),
              let scheme = components.scheme?.lowercased(),
              scheme == "http" || scheme == "https",
              var host = components.host?.lowercased(),
              !host.isEmpty else {
            return nil
        }
        // URLComponents strips the brackets from IPv6 literals; restore them
        // (defensively: only when not already bracketed).
        if host.contains(":") && !host.hasPrefix("[") {
            host = "[\(host)]"
        }
        var origin = "\(scheme)://\(host)"
        if let port = components.port {
            let isDefault = (scheme == "https" && port == 443) || (scheme == "http" && port == 80)
            if !isDefault {
                origin += ":\(port)"
            }
        }
        return origin
    }
}

/// Ordered set of paired hubs plus the active selection, persisted in
/// `UserDefaults` (URLs only — secrets live in the ``CredentialStoring``
/// Keychain store).
///
/// `UserDefaults` is injectable for tests; all URLs are normalized on the way
/// in, so lookups never miss on formatting differences.
public final class HubRegistry: @unchecked Sendable {
    public static let hubsDefaultsKey = "run.hapi.hubs"
    public static let activeHubDefaultsKey = "run.hapi.activeHub"

    private let defaults: UserDefaults
    /// Serializes read-modify-write cycles on the stored array.
    private let lock = NSLock()

    public init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
    }

    /// Paired hub origins, in pairing order.
    public var hubs: [String] {
        lock.lock()
        defer { lock.unlock() }
        return storedHubs()
    }

    /// The active hub origin. Falls back to the first paired hub when the
    /// stored selection is missing or no longer registered.
    public var activeHub: String? {
        lock.lock()
        defer { lock.unlock() }
        let hubs = storedHubs()
        if let active = defaults.string(forKey: Self.activeHubDefaultsKey), hubs.contains(active) {
            return active
        }
        return hubs.first
    }

    /// Normalizes and registers a hub. Returns the normalized origin, or
    /// `nil` when `raw` is not a valid hub URL. The first registered hub
    /// becomes active automatically; re-registering is a no-op.
    @discardableResult
    public func register(_ raw: String) -> String? {
        guard let normalized = HubURLNormalization.normalize(raw) else { return nil }
        lock.lock()
        defer { lock.unlock() }
        var hubs = storedHubs()
        if !hubs.contains(normalized) {
            hubs.append(normalized)
            defaults.set(hubs, forKey: Self.hubsDefaultsKey)
        }
        if defaults.string(forKey: Self.activeHubDefaultsKey) == nil {
            defaults.set(normalized, forKey: Self.activeHubDefaultsKey)
        }
        return normalized
    }

    /// Selects the active hub. Returns `false` when the URL is invalid or
    /// not registered.
    @discardableResult
    public func setActiveHub(_ raw: String) -> Bool {
        guard let normalized = HubURLNormalization.normalize(raw) else { return false }
        lock.lock()
        defer { lock.unlock() }
        guard storedHubs().contains(normalized) else { return false }
        defaults.set(normalized, forKey: Self.activeHubDefaultsKey)
        return true
    }

    /// Unregisters a hub. When it was active, the first remaining hub (if
    /// any) becomes active. Credential cleanup is the caller's job.
    public func remove(_ raw: String) {
        guard let normalized = HubURLNormalization.normalize(raw) else { return }
        lock.lock()
        defer { lock.unlock() }
        var hubs = storedHubs()
        guard let index = hubs.firstIndex(of: normalized) else { return }
        hubs.remove(at: index)
        defaults.set(hubs, forKey: Self.hubsDefaultsKey)
        if defaults.string(forKey: Self.activeHubDefaultsKey) == normalized {
            if let next = hubs.first {
                defaults.set(next, forKey: Self.activeHubDefaultsKey)
            } else {
                defaults.removeObject(forKey: Self.activeHubDefaultsKey)
            }
        }
    }

    private func storedHubs() -> [String] {
        defaults.stringArray(forKey: Self.hubsDefaultsKey) ?? []
    }
}
