import Foundation
import HapiProtocol
import Testing

@Suite("JSONValue wire coding")
struct JSONValueTests {
    private func decode(_ json: String) throws -> JSONValue {
        try JSONDecoder().decode(JSONValue.self, from: Data(json.utf8))
    }

    private func encode(_ value: JSONValue) throws -> String {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        return String(decoding: try encoder.encode(value), as: UTF8.self)
    }

    @Test func decodesEveryScalarKind() throws {
        #expect(try decode("null") == .null)
        #expect(try decode("true") == .bool(true))
        #expect(try decode("false") == .bool(false))
        #expect(try decode("42") == .number(42))
        #expect(try decode("-7.5") == .number(-7.5))
        #expect(try decode("\"hapi\"") == .string("hapi"))
    }

    @Test func decodesEmptyContainers() throws {
        #expect(try decode("{}") == .object([:]))
        #expect(try decode("[]") == .array([]))
    }

    @Test func distinguishesBoolsNumbersAndStrings() throws {
        #expect(try decode("1") == .number(1))
        #expect(try decode("1") != .bool(true))
        #expect(try decode("true") == .bool(true))
        #expect(try decode("true") != .number(1))
        #expect(try decode("\"true\"") == .string("true"))
        #expect(try decode("\"null\"") == .string("null"))
    }

    @Test func decodesNestedDocument() throws {
        let json = """
        {
            "id": "sess_1",
            "seq": 7,
            "ratio": 0.5,
            "active": true,
            "archived": false,
            "parent": null,
            "tags": ["ios", "m0"],
            "meta": {"nested": {"deep": [1, {"leaf": null}]}}
        }
        """
        let expected: JSONValue = [
            "id": "sess_1",
            "seq": 7,
            "ratio": 0.5,
            "active": true,
            "archived": false,
            "parent": nil,
            "tags": ["ios", "m0"],
            "meta": ["nested": ["deep": [1, ["leaf": nil]]]],
        ]
        #expect(try decode(json) == expected)
    }

    @Test func roundTripsNestedComposite() throws {
        let original: JSONValue = [
            "role": "agent",
            "content": [
                "type": "output",
                "data": [
                    "blocks": [
                        ["text": "hello", "tokens": 12.5, "done": false],
                        ["text": "world", "tokens": 3, "done": true],
                    ],
                    "meta": nil,
                    "tags": ["a", "b", "c"],
                ],
            ],
            "seq": 42,
        ]
        let data = try JSONEncoder().encode(original)
        let decoded = try JSONDecoder().decode(JSONValue.self, from: data)
        #expect(decoded == original)
    }

    @Test func roundTripsScalarsAtTopLevel() throws {
        for value in [JSONValue.null, .bool(false), .number(0.25), .string("x")] {
            let data = try JSONEncoder().encode(value)
            let decoded = try JSONDecoder().decode(JSONValue.self, from: data)
            #expect(decoded == value)
        }
    }

    @Test func encodesDeterministicTextForNonNumericValues() throws {
        // Numbers are excluded here on purpose: their textual form is an
        // implementation detail of JSONEncoder; they are covered by the
        // round-trip tests above.
        let value: JSONValue = [
            "b": true,
            "a": [nil, "x"],
        ]
        #expect(try encode(value) == #"{"a":[null,"x"],"b":true}"#)
    }

    @Test func literalsBuildTheExpectedCases() {
        let object: JSONValue = ["k": 1]
        #expect(object == .object(["k": .number(1)]))

        let null: JSONValue = nil
        #expect(null == .null)

        let array: JSONValue = [true, 2.5, "s"]
        #expect(array == .array([.bool(true), .number(2.5), .string("s")]))
    }

    @Test func rejectsMalformedJSON() {
        #expect(throws: (any Error).self) {
            try JSONDecoder().decode(JSONValue.self, from: Data("{".utf8))
        }
    }
}
