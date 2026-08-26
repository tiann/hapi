import Foundation
import HapiProtocol

// Case accessors for the free-form JSON payloads the interaction layer reads
// (tool arguments, optimistic message envelopes). HapiProtocol keeps its own
// equivalents internal to the pipeline; these are HapiClient's.

extension JSONValue {
    var objectValue: [String: JSONValue]? {
        if case .object(let value) = self { return value }
        return nil
    }

    var arrayValue: [JSONValue]? {
        if case .array(let value) = self { return value }
        return nil
    }

    var stringValue: String? {
        if case .string(let value) = self { return value }
        return nil
    }

    var boolValue: Bool? {
        if case .bool(let value) = self { return value }
        return nil
    }
}

/// Port of `getInputStringAny` (`web/src/lib/toolInputUtils.ts`): first
/// non-empty string value among `keys` (JS truthiness — empty strings skip).
func inputString(_ input: JSONValue?, keys: [String]) -> String? {
    guard let object = input?.objectValue else { return nil }
    for key in keys {
        if let value = object[key]?.stringValue, !value.isEmpty {
            return value
        }
    }
    return nil
}
