import Foundation
import HapiProtocol
import Testing

/// Decodes every golden chat fixture's `input` with the HapiProtocol wire
/// models. The full pipeline conformance (`expected` blocks) is an M2 gate;
/// this suite pins the earlier contract: every fixture input is a valid
/// `[DecryptedMessage]` (+ optional `AgentState`) for this decoder.
@Suite("Golden fixture decoding")
struct FixtureDecodingTests {
    /// Highest fixture document schema this suite understands. Mirrors the
    /// README rule: fail loudly when the on-disk version is newer.
    private static let supportedFixtureVersion = 1

    private struct ChatFixture: Decodable {
        struct Input: Decodable {
            let messages: [DecryptedMessage]
            let agentState: AgentState?
        }

        let fixtureVersion: Int
        let name: String
        let input: Input
    }

    /// Repo-root `shared/fixtures`, resolved from this file's own location:
    /// `ios/Packages/HapiKit/Tests/HapiProtocolTests/FixtureDecodingTests.swift`
    /// → up 3 directories to the package root (`ios/Packages/HapiKit`)
    /// → `../../../shared/fixtures` (the layout documented in
    /// `shared/fixtures/README.md` and `ios/README.md`).
    private static func fixturesDirectory() -> URL {
        URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent() // Tests/HapiProtocolTests
            .deletingLastPathComponent() // Tests
            .deletingLastPathComponent() // package root: ios/Packages/HapiKit
            .appendingPathComponent("../../../shared/fixtures")
            .standardizedFileURL
    }

    private static func chatFixtureFiles() throws -> [URL] {
        let chatDirectory = fixturesDirectory().appendingPathComponent("chat")
        return try FileManager.default
            .contentsOfDirectory(at: chatDirectory, includingPropertiesForKeys: nil)
            .filter { $0.pathExtension == "json" }
            .sorted { $0.lastPathComponent < $1.lastPathComponent }
    }

    private static func loadFixture(named name: String) throws -> ChatFixture {
        let file = fixturesDirectory()
            .appendingPathComponent("chat")
            .appendingPathComponent("\(name).json")
        return try JSONDecoder().decode(ChatFixture.self, from: Data(contentsOf: file))
    }

    @Test func fixturesVersionFileIsSupported() throws {
        let versionFile = Self.fixturesDirectory().appendingPathComponent("VERSION")
        let text = try String(contentsOf: versionFile, encoding: .utf8)
            .trimmingCharacters(in: .whitespacesAndNewlines)
        let version = try #require(Int(text), "VERSION must be a single integer, got: \(text)")
        #expect(
            version <= Self.supportedFixtureVersion,
            "fixtures were regenerated with a newer schema (\(version)); update the decoder support"
        )
    }

    @Test func decodesEveryChatFixtureInput() throws {
        let files = try Self.chatFixtureFiles()
        #expect(!files.isEmpty, "no chat fixtures found under \(Self.fixturesDirectory().path)")
        for file in files {
            let data = try Data(contentsOf: file)
            let fixture: ChatFixture
            do {
                fixture = try JSONDecoder().decode(ChatFixture.self, from: data)
            } catch {
                Issue.record("failed to decode \(file.lastPathComponent): \(error)")
                continue
            }
            #expect(
                fixture.fixtureVersion <= Self.supportedFixtureVersion,
                "\(file.lastPathComponent) uses fixtureVersion \(fixture.fixtureVersion)"
            )
            #expect(
                fixture.name == file.deletingPathExtension().lastPathComponent,
                "\(file.lastPathComponent) name field mismatch"
            )
        }
    }

    @Test func decodesClaudeAssistantTextMessageFields() throws {
        let fixture = try Self.loadFixture(named: "claude-assistant-text")
        let messages = fixture.input.messages
        try #require(messages.count == 2)

        #expect(messages[0].id == "msg-user-001")
        #expect(messages[0].seq == 1)
        #expect(messages[0].localId == "local-9e1c2b6a")
        #expect(messages[0].createdAt == 1_755_000_000_000)
        #expect(messages[0].invokedAt == 1_755_000_000_350)
        #expect(messages[0].scheduledAt == nil)

        #expect(messages[1].id == "msg-agent-002")
        #expect(messages[1].seq == 2)
        #expect(messages[1].localId == nil)
        #expect(messages[1].createdAt == 1_755_000_005_200)
        #expect(messages[1].invokedAt == nil)

        // The role-wrapped envelope survives verbatim as JSONValue.
        let userEnvelope = try #require(messages[0].content.testObjectValue)
        #expect(userEnvelope["role"] == "user")
        let agentEnvelope = try #require(messages[1].content.testObjectValue)
        #expect(agentEnvelope["role"] == "agent")
        let payload = try #require(agentEnvelope["content"]?.testObjectValue)
        #expect(payload["type"] == "output")
    }

    @Test func decodesPendingPermissionAgentState() throws {
        let fixture = try Self.loadFixture(named: "permission-synthesized-pending")
        let agentState = try #require(fixture.input.agentState)
        let requests = try #require(agentState.requests)
        let request = try #require(requests["req-01J5XKQ8TZ3M"])
        #expect(request.tool == "Bash")
        #expect(request.createdAt == 1_755_000_006_000)
        #expect(request.arguments == JSONValue.object([
            "command": "bun add zod",
            "description": "Install zod",
        ]))
        #expect(agentState.completedRequests?.isEmpty == true)
    }

    @Test func decodesAttachmentMetadataFromUserAttachmentsFixture() throws {
        let fixture = try Self.loadFixture(named: "user-text-with-attachments")
        let message = try #require(fixture.input.messages.first)
        let envelope = try #require(message.content.testObjectValue)
        let payload = try #require(envelope["content"]?.testObjectValue)
        let attachmentNodes = try #require(payload["attachments"]?.testArrayValue)
        try #require(attachmentNodes.count == 2)

        // Round-trip the raw wire node into the typed attachment model.
        let data = try JSONEncoder().encode(attachmentNodes[0])
        let attachment = try JSONDecoder().decode(AttachmentMetadata.self, from: data)
        #expect(attachment.id == "att-01HZXK3Q")
        #expect(attachment.filename == "crash.log")
        #expect(attachment.mimeType == "text/plain")
        #expect(attachment.size == 18_432)
        #expect(attachment.path == "/uploads/att-01HZXK3Q/crash.log")
        #expect(attachment.previewUrl == "/api/uploads/att-01HZXK3Q/preview")
    }
}

private extension JSONValue {
    var testObjectValue: [String: JSONValue]? {
        if case .object(let value) = self { return value }
        return nil
    }

    var testArrayValue: [JSONValue]? {
        if case .array(let value) = self { return value }
        return nil
    }
}
