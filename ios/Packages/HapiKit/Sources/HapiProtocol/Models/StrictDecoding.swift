import Foundation

/// A pass-through coding key used to enumerate whatever keys a JSON object
/// actually carries (the synthesized `CodingKeys` enums cannot represent
/// unknown keys).
struct AnyCodingKey: CodingKey {
    let stringValue: String
    let intValue: Int?

    init?(stringValue: String) {
        self.stringValue = stringValue
        self.intValue = nil
    }

    init?(intValue: Int) {
        self.stringValue = String(intValue)
        self.intValue = intValue
    }
}

/// Mirror of zod's `.strict()`: throw when the payload carries a key outside
/// `known`. Used by the patch types whose strictness discriminates the
/// `Session | SessionPatch` and `Machine | MachinePatch | null` unions.
func rejectUnknownKeys(in decoder: Decoder, known: Set<String>, payloadName: String) throws {
    let container = try decoder.container(keyedBy: AnyCodingKey.self)
    for key in container.allKeys where !known.contains(key.stringValue) {
        throw DecodingError.dataCorrupted(DecodingError.Context(
            codingPath: decoder.codingPath,
            debugDescription: "Unknown key '\(key.stringValue)' in strict \(payloadName) payload"
        ))
    }
}
