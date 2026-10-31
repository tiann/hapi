import Foundation
@testable import HapiClient
import HapiProtocol
import Testing

/// Composer `/` autocomplete: the Android `SlashCommandsTest` cases plus the
/// web Levenshtein tail (`useSlashCommands`).
@Suite("Slash command suggestions")
struct SlashCommandSuggestionsTests {
    @Test func onlyALoneLeadingTokenOpensTheMenu() {
        #expect(SlashCommandSuggestions.query(of: "/") == "")
        #expect(SlashCommandSuggestions.query(of: "/co") == "co")
        #expect(SlashCommandSuggestions.query(of: "/foo:bar") == "foo:bar")
        #expect(SlashCommandSuggestions.query(of: "/compact now") == nil)
        #expect(SlashCommandSuggestions.query(of: "hi /co") == nil)
        #expect(SlashCommandSuggestions.query(of: "") == nil)
    }

    @Test func rpcEntriesOverrideMetadataNamesAndTakeTheLaterPosition() {
        let merged = SlashCommandSuggestions.merge(
            metadataNames: ["/deploy", "Compact", "  "],
            fetched: [SlashCommand(name: "compact", description: "Summarize", source: "builtin")]
        )
        #expect(merged.map(\.name) == ["deploy", "compact"])
        #expect(merged.last?.description == "Summarize")
        #expect(merged.first?.source == "session")
    }

    @Test func rankingIsExactPrefixContainsThenCloseTypos() {
        let commands = ["review", "compact", "context", "co", "status", "plan"].map {
            SlashCommand(name: $0, source: "builtin")
        }
        #expect(SlashCommandSuggestions.filter(commands, query: "co").map(\.name) == ["co", "compact", "context"])
        #expect(SlashCommandSuggestions.filter(commands, query: "CONT").map(\.name) == ["context", "co"])
        #expect(SlashCommandSuggestions.filter(commands, query: "stauts").map(\.name) == ["status"])
        #expect(SlashCommandSuggestions.filter(commands, query: "").count == 6)
        #expect(SlashCommandSuggestions.levenshtein("kitten", "sitting") == 3)
    }
}
