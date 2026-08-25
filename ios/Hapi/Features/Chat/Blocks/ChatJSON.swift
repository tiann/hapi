import Foundation
import HapiProtocol

// App-side JSONValue conveniences. HapiProtocol keeps its own accessors
// internal (they encode JS semantics for the pipeline port); these are the
// small read-only subset the chat presentation layer needs.

extension JSONValue {
    var chatObject: [String: JSONValue]? {
        if case .object(let value) = self { return value }
        return nil
    }

    var chatArray: [JSONValue]? {
        if case .array(let value) = self { return value }
        return nil
    }

    var chatString: String? {
        if case .string(let value) = self { return value }
        return nil
    }

    var chatNumber: Double? {
        if case .number(let value) = self { return value }
        return nil
    }

    /// Object member lookup; nil for arrays/scalars/missing keys.
    subscript(chatKey key: String) -> JSONValue? {
        chatObject?[key]
    }
}

/// First string value among `keys` (the app-side twin of the pipeline's
/// internal `getInputStringAny`).
func chatInputString(_ input: JSONValue?, _ keys: [String]) -> String? {
    guard let object = input?.chatObject else { return nil }
    for key in keys {
        if let value = object[key]?.chatString {
            return value
        }
    }
    return nil
}

/// Web `truncate`: hard cap with a trailing ellipsis.
func chatTruncate(_ text: String, _ limit: Int) -> String {
    guard text.count > limit else { return text }
    return String(text.prefix(limit)) + "…"
}

/// Pretty JSON for generic tool inputs/results: sorted keys, 2-space indent,
/// whole numbers printed without a trailing `.0`. Display-only (never feeds
/// the normative projection).
func chatPrettyJSON(_ value: JSONValue) -> String {
    var output = ""
    appendJSON(value, indent: 0, into: &output)
    return output
}

private func appendJSON(_ value: JSONValue, indent: Int, into output: inout String) {
    let pad = String(repeating: "  ", count: indent)
    let childPad = String(repeating: "  ", count: indent + 1)
    switch value {
    case .null:
        output += "null"
    case .bool(let flag):
        output += flag ? "true" : "false"
    case .number(let number):
        output += formatJSONNumber(number)
    case .string(let text):
        output += quoteJSONString(text)
    case .array(let items):
        if items.isEmpty {
            output += "[]"
            return
        }
        output += "[\n"
        for (index, item) in items.enumerated() {
            output += childPad
            appendJSON(item, indent: indent + 1, into: &output)
            output += index == items.count - 1 ? "\n" : ",\n"
        }
        output += pad + "]"
    case .object(let members):
        if members.isEmpty {
            output += "{}"
            return
        }
        output += "{\n"
        let keys = members.keys.sorted()
        for (index, key) in keys.enumerated() {
            output += childPad + quoteJSONString(key) + ": "
            appendJSON(members[key] ?? .null, indent: indent + 1, into: &output)
            output += index == keys.count - 1 ? "\n" : ",\n"
        }
        output += pad + "}"
    }
}

func formatJSONNumber(_ number: Double) -> String {
    if number.rounded() == number, abs(number) < 1e15 {
        return String(Int64(number))
    }
    return String(number)
}

private func quoteJSONString(_ text: String) -> String {
    var escaped = "\""
    for scalar in text.unicodeScalars {
        switch scalar {
        case "\"": escaped += "\\\""
        case "\\": escaped += "\\\\"
        case "\n": escaped += "\\n"
        case "\r": escaped += "\\r"
        case "\t": escaped += "\\t"
        default:
            if scalar.value < 0x20 {
                escaped += String(format: "\\u%04x", scalar.value)
            } else {
                escaped.unicodeScalars.append(scalar)
            }
        }
    }
    return escaped + "\""
}
