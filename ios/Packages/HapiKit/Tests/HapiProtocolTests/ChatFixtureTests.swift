import Foundation
import HapiProtocol
import Testing

/// Golden conformance suite for the chat pipeline port: every fixture in
/// `shared/fixtures/chat/` is decoded, run through the ported pipeline
/// (normalize → reduce → group → normative projection), serialized to
/// canonical JSON and compared byte-for-byte against the stored `expected`.
///
/// One parameterized test case per fixture file, so a red CI run names the
/// exact fixtures that diverge; on mismatch the failure message carries a
/// line-level diff (first divergence with context) to make the macOS CI
/// output directly actionable from a Linux dev box.
@Suite("Chat pipeline golden fixtures")
struct ChatFixtureTests {
    /// Highest fixture document schema this suite understands. Mirrors the
    /// README rule: fail loudly when the on-disk version is newer.
    private static let supportedFixtureVersion = 1

    private struct ChatFixtureDocument: Decodable {
        struct Input: Decodable {
            let messages: [DecryptedMessage]
            let agentState: AgentState?
            let options: Options
        }

        struct Options: Decodable {
            let hasMoreMessages: Bool
        }

        let fixtureVersion: Int
        let name: String
        let input: Input
        let expected: JSONValue
    }

    /// Repo-root `shared/fixtures`, resolved from this file's own location
    /// (same scheme as FixtureDecodingTests):
    /// `ios/Packages/HapiKit/Tests/HapiProtocolTests/…` → package root →
    /// `../../../shared/fixtures`.
    private static func fixturesDirectory() -> URL {
        URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent() // Tests/HapiProtocolTests
            .deletingLastPathComponent() // Tests
            .deletingLastPathComponent() // package root: ios/Packages/HapiKit
            .appendingPathComponent("../../../shared/fixtures")
            .standardizedFileURL
    }

    /// Sorted fixture file names — the parameterized-test argument list.
    /// Missing directory yields an empty list, which the guard test flags.
    static let chatFixtureNames: [String] = {
        let chatDirectory = fixturesDirectory().appendingPathComponent("chat")
        let contents = (try? FileManager.default.contentsOfDirectory(
            at: chatDirectory,
            includingPropertiesForKeys: nil
        )) ?? []
        return contents
            .filter { $0.pathExtension == "json" }
            .map { $0.lastPathComponent }
            .sorted()
    }()

    private static func fixtureURL(_ fileName: String) -> URL {
        fixturesDirectory().appendingPathComponent("chat").appendingPathComponent(fileName)
    }

    @Test func hasChatFixturesOnDisk() {
        #expect(
            !Self.chatFixtureNames.isEmpty,
            "no chat fixtures found under \(Self.fixturesDirectory().path)"
        )
    }

    @Test func fixturesVersionIsSupported() throws {
        let versionFile = Self.fixturesDirectory().appendingPathComponent("VERSION")
        let text = try String(contentsOf: versionFile, encoding: .utf8)
            .trimmingCharacters(in: .whitespacesAndNewlines)
        let version = try #require(Int(text), "VERSION must be a single integer, got: \(text)")
        #expect(
            version <= Self.supportedFixtureVersion,
            "fixtures were regenerated with a newer schema (\(version)); update the pipeline port"
        )
    }

    @Test("fixture", arguments: ChatFixtureTests.chatFixtureNames)
    func fixtureMatchesPipeline(_ fileName: String) throws {
        let data = try Data(contentsOf: Self.fixtureURL(fileName))
        let document = try JSONDecoder().decode(ChatFixtureDocument.self, from: data)

        #expect(document.fixtureVersion <= Self.supportedFixtureVersion,
                "\(fileName) uses fixtureVersion \(document.fixtureVersion)")
        #expect("\(document.name).json" == fileName, "\(fileName) name field mismatch")

        let projected = runChatFixturePipeline(
            messages: document.input.messages,
            agentState: document.input.agentState,
            hasMoreMessages: document.input.options.hasMoreMessages
        )

        let actual = toCanonicalJSON(projected)
        let expected = toCanonicalJSON(document.expected)

        if actual != expected {
            Issue.record(Comment(rawValue: Self.diff(expected: expected, actual: actual, label: fileName)))
        }
    }

    /// Readable line-level diff: the first differing line with surrounding
    /// context from both documents, so the CI log pinpoints the divergence
    /// without downloading artifacts.
    private static func diff(expected: String, actual: String, label: String) -> String {
        let expectedLines = expected.components(separatedBy: "\n")
        let actualLines = actual.components(separatedBy: "\n")
        let commonCount = min(expectedLines.count, actualLines.count)

        var firstDiff = commonCount
        for index in 0..<commonCount where expectedLines[index] != actualLines[index] {
            firstDiff = index
            break
        }
        if firstDiff == commonCount && expectedLines.count == actualLines.count {
            return "\(label): documents differ but no differing line found (line-ending issue?)"
        }

        let contextStart = max(0, firstDiff - 3)
        func window(_ lines: [String]) -> String {
            let end = min(lines.count, firstDiff + 4)
            guard contextStart < end else { return "  <past end of document>" }
            return lines[contextStart..<end].enumerated().map { offset, line in
                let lineNumber = contextStart + offset + 1
                let marker = (contextStart + offset) == firstDiff ? ">" : " "
                return String(format: "%@ %4d | %@", marker, lineNumber, line)
            }.joined(separator: "\n")
        }

        return """
        \(label): projection mismatch at line \(firstDiff + 1) \
        (expected \(expectedLines.count) lines, actual \(actualLines.count))
        --- expected (fixture) ---
        \(window(expectedLines))
        --- actual (port) ---
        \(window(actualLines))
        """
    }
}
