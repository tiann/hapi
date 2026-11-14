import Foundation
import HapiProtocol

/// Hub-provided reopen failure text (the Android `formatReopenError` port):
/// a `{error, missing?}` body becomes `"<error> (missing: a, b)"`. Nil when
/// the failure carries no hub message, so the caller shows its own
/// localized fallback.
public func formatReopenError(_ error: any Error) -> String? {
    guard let message = hubErrorMessage(error),
          let body = (error as? APIError)?.body,
          let value = try? HapiJSON.decoder.decode(JSONValue.self, from: Data(body.utf8)),
          case .object(let object) = value else {
        return nil
    }
    var missing: [String] = []
    if case .array(let items)? = object["missing"] {
        missing = items.compactMap { item in
            if case .string(let field) = item { return field }
            return nil
        }
    }
    return missing.isEmpty ? message : "\(message) (missing: \(missing.joined(separator: ", ")))"
}

/// The hub's `{error}` text, or nil when the failure carries none.
public func hubErrorMessage(_ error: any Error) -> String? {
    guard let body = (error as? APIError)?.body,
          let value = try? HapiJSON.decoder.decode(JSONValue.self, from: Data(body.utf8)),
          case .object(let object) = value,
          case .string(let message)? = object["error"],
          !message.isEmpty else {
        return nil
    }
    return message
}

/// `DELETE /sessions/:id` answers 409 while the session is active (or
/// became active again) — the caller shows "archive first" wording.
public func isActiveSessionConflict(_ error: any Error) -> Bool {
    (error as? APIError)?.status == 409
}
