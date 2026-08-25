import Foundation

// JavaScript-semantics helpers for the chat pipeline port.
//
// The web reference (`web/src/chat/**`) manipulates untyped JSON with
// JavaScript operators; this file pins the exact semantics the port relies
// on so every call site can stay a mechanical translation:
//
//   - `isObject(x)`         → `x != nil && typeof x === 'object'` (arrays too)
//   - property access       → object member lookup; `undefined` on arrays and
//                             non-objects (modelled as Swift `nil`)
//   - `a ?? b`              → JS nullish-coalescing over wire values, where
//                             BOTH absent-key (`undefined`, Swift `nil`) and
//                             JSON `null` fall through (`jsCoalesce`)
//   - `Boolean(x)` / `if (x)` → `jsTruthy`
//   - `asString` / `asNumber` → shared/src/utils.ts
//   - `safeStringify`       → shared/src/utils.ts (2-space JSON, sorted keys —
//                             fixture inputs are canonically sorted on disk,
//                             so sorted output matches the reference replay)

// MARK: - JSONValue accessors

extension JSONValue {
    /// `typeof value === 'object' && value !== null` — arrays included.
    var jsIsObjectLike: Bool {
        switch self {
        case .object, .array: return true
        default: return false
        }
    }

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

    var numberValue: Double? {
        if case .number(let value) = self { return value }
        return nil
    }

    var boolValue: Bool? {
        if case .bool(let value) = self { return value }
        return nil
    }

    /// JS member access `value[key]`: a value for object members, `nil`
    /// (i.e. `undefined`) for arrays, scalars and missing keys.
    subscript(key: String) -> JSONValue? {
        objectValue?[key]
    }

    /// `Boolean(value)` — JSON has no NaN, so number truthiness is `!= 0`.
    var jsTruthy: Bool {
        switch self {
        case .null: return false
        case .bool(let value): return value
        case .number(let value): return value != 0
        case .string(let value): return !value.isEmpty
        case .array, .object: return true
        }
    }
}

/// JS `a ?? b ?? …` over wire values: the first operand that is neither
/// absent (`nil`) nor JSON `null` wins; otherwise `nil`.
func jsCoalesce(_ values: JSONValue?...) -> JSONValue? {
    for value in values {
        if let value, value != .null { return value }
    }
    return nil
}

/// shared/src/utils.ts `asString` — string values only, no coercion.
func asString(_ value: JSONValue?) -> String? {
    value?.stringValue
}

/// shared/src/utils.ts `asNumber` — finite numbers only (JSON numbers always are).
func asNumber(_ value: JSONValue?) -> Double? {
    value?.numberValue
}

// MARK: - safeStringify

/// shared/src/utils.ts `safeStringify`: strings pass through raw; everything
/// else becomes `JSON.stringify(value, null, 2)`. Object keys are emitted
/// sorted — fixture inputs are canonically serialized (sorted keys), and
/// JSON.parse preserves that order, so the reference's insertion-order output
/// over fixture inputs is exactly sorted-key output.
func safeStringify(_ value: JSONValue) -> String {
    if case .string(let text) = value { return text }
    return serializeJSON(value, indent: 2)
}

// MARK: - Canonical JSON

/// Canonical serialization for fixture comparison (mirrors
/// web/scripts/fixtures/serialize.ts): recursively sorted object keys,
/// 4-space indent, LF line endings, single trailing newline. Numbers that
/// are mathematically integral (within the JS safe-integer range) serialize
/// without a fractional part, matching `JSON.stringify` — timestamps must
/// come out as `1755000000000`, never `1755000000000.0`.
public func toCanonicalJSON(_ value: JSONValue) -> String {
    serializeJSON(value, indent: 4) + "\n"
}

private func serializeJSON(_ value: JSONValue, indent: Int) -> String {
    var out = String()
    writeJSON(value, indent: indent, depth: 0, into: &out)
    return out
}

private func writeJSON(_ value: JSONValue, indent: Int, depth: Int, into out: inout String) {
    switch value {
    case .null:
        out += "null"
    case .bool(let flag):
        out += flag ? "true" : "false"
    case .number(let number):
        out += jsNumberString(number)
    case .string(let text):
        writeJSONString(text, into: &out)
    case .array(let items):
        if items.isEmpty {
            out += "[]"
            return
        }
        let pad = String(repeating: " ", count: indent * (depth + 1))
        let closePad = String(repeating: " ", count: indent * depth)
        out += "[\n"
        for (index, item) in items.enumerated() {
            out += pad
            writeJSON(item, indent: indent, depth: depth + 1, into: &out)
            out += index == items.count - 1 ? "\n" : ",\n"
        }
        out += closePad + "]"
    case .object(let members):
        if members.isEmpty {
            out += "{}"
            return
        }
        let pad = String(repeating: " ", count: indent * (depth + 1))
        let closePad = String(repeating: " ", count: indent * depth)
        // JS `Object.keys(x).sort()` compares UTF-16 code units.
        let keys = members.keys.sorted { $0.utf16.lexicographicallyPrecedes($1.utf16) }
        out += "{\n"
        for (index, key) in keys.enumerated() {
            out += pad
            writeJSONString(key, into: &out)
            out += ": "
            writeJSON(members[key]!, indent: indent, depth: depth + 1, into: &out)
            out += index == keys.count - 1 ? "\n" : ",\n"
        }
        out += closePad + "}"
    }
}

/// `JSON.stringify` number formatting for the values this protocol carries:
/// integral doubles inside the JS safe-integer range print as integers;
/// everything else uses Swift's shortest round-trip representation (the same
/// algorithm family V8 uses, identical for the magnitudes on this wire).
func jsNumberString(_ number: Double) -> String {
    if number.rounded() == number && abs(number) <= 9_007_199_254_740_991 {
        return String(Int64(number))
    }
    return String(number)
}

private func writeJSONString(_ text: String, into out: inout String) {
    out += "\""
    for scalar in text.unicodeScalars {
        switch scalar {
        case "\"": out += "\\\""
        case "\\": out += "\\\\"
        case "\n": out += "\\n"
        case "\r": out += "\\r"
        case "\t": out += "\\t"
        case "\u{08}": out += "\\b"
        case "\u{0C}": out += "\\f"
        default:
            if scalar.value < 0x20 {
                out += String(format: "\\u%04x", scalar.value)
            } else {
                out.unicodeScalars.append(scalar)
            }
        }
    }
    out += "\""
}

// MARK: - JS string helpers

extension String {
    /// JS `String.prototype.trim()`.
    var jsTrimmed: String {
        trimmingCharacters(in: .whitespacesAndNewlines)
    }

    /// JS `String.prototype.trimEnd()`.
    var jsTrimmedEnd: String {
        var view = Substring(self)
        while let last = view.unicodeScalars.last, CharacterSet.whitespacesAndNewlines.contains(last) {
            view.removeLast()
        }
        return String(view)
    }

    /// JS `String.prototype.trimStart()`.
    var jsTrimmedStart: String {
        var view = Substring(self)
        while let first = view.unicodeScalars.first, CharacterSet.whitespacesAndNewlines.contains(first) {
            view.removeFirst()
        }
        return String(view)
    }
}

// MARK: - Regex helper

/// Thin NSRegularExpression wrapper mirroring the few JS regex operations the
/// pipeline uses. Patterns are written with `\A`/`\z` anchors where the JS
/// source used whole-string `^`/`$` (ICU treats bare `$` as
/// "before a final line terminator", JS does not).
///
/// `@unchecked Sendable`: NSRegularExpression is documented immutable and
/// thread-safe; instances here are file-scope constants.
struct JSRegex: @unchecked Sendable {
    private let regex: NSRegularExpression

    init(_ pattern: String, caseInsensitive: Bool = false, anchorsMatchLines: Bool = false) {
        var options: NSRegularExpression.Options = []
        if caseInsensitive { options.insert(.caseInsensitive) }
        if anchorsMatchLines { options.insert(.anchorsMatchLines) }
        // Patterns are compile-time constants ported from the reference;
        // a syntax error would fail every fixture, loudly.
        // swiftlint:disable:next force_try
        self.regex = try! NSRegularExpression(pattern: pattern, options: options)
    }

    /// JS `regex.test(text)`.
    func test(_ text: String) -> Bool {
        let range = NSRange(text.startIndex..., in: text)
        return regex.firstMatch(in: text, options: [], range: range) != nil
    }

    /// JS `text.match(regex)` — capture groups of the first match.
    /// Index 0 is the whole match; unmatched optional groups are `nil`.
    func firstMatch(in text: String) -> [String?]? {
        let range = NSRange(text.startIndex..., in: text)
        guard let match = regex.firstMatch(in: text, options: [], range: range) else { return nil }
        var groups: [String?] = []
        for index in 0..<match.numberOfRanges {
            let groupRange = match.range(at: index)
            if groupRange.location == NSNotFound {
                groups.append(nil)
            } else if let swiftRange = Range(groupRange, in: text) {
                groups.append(String(text[swiftRange]))
            } else {
                groups.append(nil)
            }
        }
        return groups
    }

    /// JS `text.replace(regex, '')` for a NON-global regex: removes the first
    /// match only.
    func removingFirstMatch(in text: String) -> String {
        let range = NSRange(text.startIndex..., in: text)
        guard let match = regex.firstMatch(in: text, options: [], range: range),
              let swiftRange = Range(match.range, in: text) else { return text }
        var result = text
        result.removeSubrange(swiftRange)
        return result
    }

    /// JS `text.replace(regex, '')` for a GLOBAL regex: removes every match.
    func removingAllMatches(in text: String) -> String {
        replacingAllMatches(in: text, with: "")
    }

    /// JS `text.replace(regex, template)` for a GLOBAL regex.
    func replacingAllMatches(in text: String, with template: String) -> String {
        let range = NSRange(text.startIndex..., in: text)
        return regex.stringByReplacingMatches(in: text, options: [], range: range, withTemplate: template)
    }
}
