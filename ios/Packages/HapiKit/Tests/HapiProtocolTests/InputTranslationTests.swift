import Foundation
import HapiProtocol
import Testing

/// Per-session input translation: the hub-owned `metadata.translateInput`
/// toggle, the `/api/features` availability flag, and `meta.translatedFrom`
/// on translated user prompts.
@Suite("Input translation")
struct InputTranslationTests {
    private static func session(metadata: String) -> String {
        #"{"id":"s1","namespace":"default","seq":1,"createdAt":1,"updatedAt":2,"active":true,"activeAt":0,"metadata":\#(metadata),"metadataVersion":3,"agentStateVersion":1,"thinking":false,"thinkingAt":0}"#
    }

    @Test func metadataDecodesTheToggleAndTreatsAbsentAsOff() throws {
        let on = try JSONDecoder().decode(
            Session.self,
            from: Data(Self.session(metadata: #"{"path":"/repo","host":"h","translateInput":true}"#).utf8)
        )
        #expect(on.metadata?.translateInput == true)
        #expect(try JSONDecoder().decode(Session.self, from: JSONEncoder().encode(on)) == on)

        let off = try JSONDecoder().decode(
            Session.self,
            from: Data(Self.session(metadata: #"{"path":"/repo","host":"h","translateInput":false}"#).utf8)
        )
        #expect(off.metadata?.translateInput == false)

        let absent = try JSONDecoder().decode(
            Session.self,
            from: Data(Self.session(metadata: #"{"path":"/repo","host":"h"}"#).utf8)
        )
        #expect(absent.metadata?.translateInput == nil)
    }

    @Test func metadataPatchCarriesTheToggleIntoTheDetail() throws {
        let session = try JSONDecoder().decode(
            Session.self,
            from: Data(Self.session(metadata: #"{"path":"/repo","host":"h"}"#).utf8)
        )
        let patch = try JSONDecoder().decode(
            SessionPatch.self,
            from: Data(#"{"metadata":{"version":4,"value":{"path":"/repo","host":"h","translateInput":true}}}"#.utf8)
        )
        #expect(applySessionDetailPatch(session: session, patch: patch)?.metadata?.translateInput == true)
    }

    @Test func featuresAvailabilityDefaultsToFalse() throws {
        let available = try JSONDecoder().decode(
            HubFeaturesResponse.self,
            from: Data(#"{"githubPrAwareness":{"enabled":false,"source":"default"},"inputTranslation":{"available":true}}"#.utf8)
        )
        #expect(available.isInputTranslationAvailable)

        let unavailable = try JSONDecoder().decode(
            HubFeaturesResponse.self,
            from: Data(#"{"inputTranslation":{"available":false}}"#.utf8)
        )
        #expect(!unavailable.isInputTranslationAvailable)

        let olderHub = try JSONDecoder().decode(
            HubFeaturesResponse.self,
            from: Data(#"{"githubPrAwareness":{"enabled":true,"source":"env"}}"#.utf8)
        )
        #expect(olderHub.inputTranslation == nil)
        #expect(!olderHub.isInputTranslationAvailable)
    }

    private static func userBlock(meta: String) throws -> UserTextBlock? {
        let content = try JSONDecoder().decode(
            JSONValue.self,
            from: Data(#"{"role":"user","content":{"type":"text","text":"Fix the login bug"},"meta":\#(meta)}"#.utf8)
        )
        let message = DecryptedMessage(id: "m1", localId: "l1", content: content, createdAt: 1_700_000_000_000)
        let normalized = try #require(normalizeDecryptedMessage(message))
        for block in reduceChatBlocks([normalized], agentState: nil).blocks {
            if case .userText(let user) = block { return user }
        }
        return nil
    }

    @Test func translatedUserPromptExposesWhatTheUserTyped() throws {
        let block = try #require(try Self.userBlock(meta: #"{"sentFrom":"webapp","translatedFrom":"修复登录问题"}"#))
        #expect(block.text == "Fix the login bug")
        #expect(block.translatedFrom == "修复登录问题")
    }

    @Test func untranslatedOrMalformedMetaHasNoTranslatedFrom() throws {
        let plain = try #require(try Self.userBlock(meta: #"{"sentFrom":"webapp"}"#))
        #expect(plain.translatedFrom == nil)

        let nonString = try #require(try Self.userBlock(meta: #"{"sentFrom":"webapp","translatedFrom":42}"#))
        #expect(nonString.translatedFrom == nil)
        #expect(nonString.text == "Fix the login bug")
    }
}
