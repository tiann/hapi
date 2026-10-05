import Foundation
import HapiClient
import HapiProtocol

/// UI-only input policy. The service still receives an absolute origin and
/// an opaque token; no clipboard access or networking happens in this model.
struct ManualPairingForm {
    enum Field: Hashable {
        case address, accessToken
    }

    enum Scheme: String, CaseIterable {
        case https, http

        var prefix: String { "\(rawValue)://" }
    }

    enum InputError: Equatable {
        case invalidAddress, invalidLink, missingToken
    }

    struct Submission: Equatable {
        let hubURL: String
        let accessToken: String
    }

    private(set) var scheme: Scheme = .https
    private(set) var address = ""
    private(set) var accessToken = ""
    private(set) var didImportLink = false
    private var validatedFields: Set<Field> = []

    var submission: Submission? {
        guard validationError(for: .address) == nil,
              validationError(for: .accessToken) == nil,
              let origin = normalizedAddress(address) else { return nil }
        return Submission(hubURL: origin, accessToken: trimmed(accessToken))
    }

    func text(for field: Field) -> String {
        field == .address ? address : accessToken
    }

    func error(for field: Field) -> InputError? {
        validatedFields.contains(field) ? validationError(for: field) : nil
    }

    mutating func edit(_ text: String, in field: Field) {
        if field == .address { address = text } else { accessToken = text }
        didImportLink = false
    }

    mutating func selectScheme(_ value: Scheme) {
        // First consume a manually typed explicit scheme, then honor the menu
        // choice. Otherwise an old "https://" in the draft could override it.
        if !trimmed(address).isEmpty { finishEditing(.address) }
        scheme = value
        didImportLink = false
    }

    /// Returns true only when the entire paste replaces a field (or the form).
    /// Ordinary text is left to the text control's selection/insertion rules.
    @discardableResult
    mutating func paste(_ raw: String, into field: Field) -> Bool {
        if Self.looksLikePairingLink(raw) {
            edit(raw, in: field)
            finishEditing(field)
            return true
        }
        if field == .address, raw.contains("://") {
            edit(raw, in: field)
            finishEditing(field)
            return true
        }
        return false
    }

    mutating func finishEditing(_ field: Field) {
        let raw = trimmed(text(for: field))
        validatedFields.insert(field)
        if Self.looksLikePairingLink(raw) {
            guard raw.removingPercentEncoding != nil,
                  let link = BindLink.parse(raw),
                  let origin = normalizedAddress(link.hubUrl) else { return }
            applyOrigin(origin)
            accessToken = trimmed(link.accessToken)
            didImportLink = true
            validatedFields = [.address, .accessToken]
        } else if field == .address {
            if let origin = normalizedAddress(raw) { applyOrigin(origin) }
        } else {
            accessToken = raw
        }
    }

    private func validationError(for field: Field) -> InputError? {
        let raw = trimmed(text(for: field))
        // Never fall back to the web frontend origin for a broken pairing
        // link, or send a pasted link verbatim as an access token.
        if Self.looksLikePairingLink(raw) { return .invalidLink }
        if field == .address {
            return normalizedAddress(raw) == nil ? .invalidAddress : nil
        }
        return raw.isEmpty ? .missingToken : nil
    }

    private func normalizedAddress(_ raw: String) -> String? {
        let value = trimmed(raw)
        guard !value.isEmpty, !value.contains(where: \.isWhitespace),
              value.removingPercentEncoding != nil else { return nil }
        let absolute = value.contains("://") ? value : scheme.prefix + value
        guard let components = URLComponents(string: absolute),
              components.user == nil, components.password == nil,
              let host = components.host, !host.isEmpty,
              !host.contains(where: \.isWhitespace) else { return nil }
        if let port = components.port, !(1...65535).contains(port) { return nil }
        return HubURLNormalization.normalize(absolute)
    }

    private mutating func applyOrigin(_ origin: String) {
        // Origins come exclusively from HubURLNormalization (http or https).
        scheme = origin.hasPrefix(Scheme.http.prefix) ? .http : .https
        address = String(origin.dropFirst(scheme.prefix.count))
    }

    private static func looksLikePairingLink(_ raw: String) -> Bool {
        let value = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        if value.lowercased().hasPrefix("hapicompanion:") { return true }
        guard value.contains("://") else { return false }
        guard let queryStart = value.firstIndex(of: "?") else { return false }
        let query = value[value.index(after: queryStart)...].prefix { $0 != "#" }
        return query.split(separator: "&").contains { item in
            let key = item.prefix { $0 != "=" }
            let decoded = String(key).replacingOccurrences(of: "+", with: " ").removingPercentEncoding
            return decoded == "hub" || decoded == "token"
        }
    }

    private func trimmed(_ value: String) -> String {
        value.trimmingCharacters(in: .whitespacesAndNewlines)
    }
}
