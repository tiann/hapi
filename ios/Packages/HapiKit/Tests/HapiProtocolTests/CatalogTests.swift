import Foundation
import HapiProtocol
import Testing

/// Checks of the mode/flavor catalogs: exhaustively against the generated
/// `shared/fixtures/catalogs/modes.json` (track K, from `shared/src/modes.ts`),
/// plus inline spot checks transcribed from `shared/src/modes.ts`,
/// `shared/src/flavors.ts`, and `shared/src/copilotModes.ts` for fast
/// diagnosis when the generated catalog and the port disagree.
@Suite("Mode and flavor catalogs")
struct CatalogTests {
    // MARK: - Generated catalog (shared/fixtures/catalogs/modes.json)

    private struct GeneratedModesCatalog: Decodable {
        struct PermissionEntry: Decodable {
            let label: String
            let mode: PermissionMode
            let tone: PermissionModeTone
        }

        struct CollaborationEntry: Decodable {
            let label: String
            let mode: CodexCollaborationMode
        }

        let codexCollaborationModes: [CollaborationEntry]
        let permissionModesByFlavor: [String: [PermissionEntry]]
    }

    /// Same resolution as FixtureDecodingTests: this file lives in
    /// `ios/Packages/HapiKit/Tests/HapiProtocolTests/`, so the package root is
    /// three levels up and the repo fixtures sit at `../../../shared/fixtures`.
    private static func generatedCatalogURL() -> URL {
        URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent() // Tests/HapiProtocolTests
            .deletingLastPathComponent() // Tests
            .deletingLastPathComponent() // package root: ios/Packages/HapiKit
            .appendingPathComponent("../../../shared/fixtures/catalogs/modes.json")
            .standardizedFileURL
    }

    @Test func portMatchesGeneratedModesCatalogExactly() throws {
        let data = try Data(contentsOf: Self.generatedCatalogURL())
        let catalog = try JSONDecoder().decode(GeneratedModesCatalog.self, from: data)

        // Every known flavor is present in the generated catalog and vice
        // versa (the catalog only carries known flavors).
        #expect(
            catalog.permissionModesByFlavor.keys.sorted()
                == AgentFlavor.knownFlavors.map(\.rawValue).sorted()
        )

        for (flavor, expected) in catalog.permissionModesByFlavor.sorted(by: { $0.key < $1.key }) {
            let actual = permissionModeOptions(forFlavor: flavor)
            #expect(
                actual.map(\.mode) == expected.map(\.mode),
                "mode list mismatch for flavor \(flavor)"
            )
            for (actualOption, expectedEntry) in zip(actual, expected) {
                #expect(
                    actualOption.label == expectedEntry.label,
                    "label mismatch for \(flavor)/\(expectedEntry.mode.rawValue)"
                )
                #expect(
                    actualOption.tone == expectedEntry.tone,
                    "tone mismatch for \(flavor)/\(expectedEntry.mode.rawValue)"
                )
            }
        }

        #expect(catalog.codexCollaborationModes.map(\.mode) == CodexCollaborationMode.allCases)
        for entry in catalog.codexCollaborationModes {
            #expect(entry.mode.label == entry.label)
        }
    }

    // MARK: - Permission modes per flavor (modes.ts getPermissionModesForFlavor)

    @Test func codexFamilyFlavorsShareTheCodexModeSet() {
        let expected: [PermissionMode] = [.default, .readOnly, .safeYolo, .yolo]
        #expect(permissionModes(forFlavor: "codex") == expected)
        #expect(permissionModes(forFlavor: "gemini") == expected)
        #expect(permissionModes(forFlavor: "kimi") == expected)
        #expect(permissionModes(forFlavor: "copilot") == expected)
    }

    @Test func claudeSetIsTheFallbackForNilAndUnknownFlavors() {
        let expected: [PermissionMode] = [.default, .acceptEdits, .auto, .bypassPermissions, .plan]
        #expect(permissionModes(forFlavor: "claude") == expected)
        #expect(permissionModes(forFlavor: nil) == expected)
        #expect(permissionModes(forFlavor: "some-future-agent") == expected)
    }

    @Test func remainingFlavorsMatchTheirDeclaredSets() {
        #expect(permissionModes(forFlavor: "grok") == [.default, .auto, .plan, .bypassPermissions])
        #expect(permissionModes(forFlavor: "opencode") == [.default, .plan, .yolo])
        #expect(permissionModes(forFlavor: "agy") == [.requestReview, .alwaysProceed])
        #expect(permissionModes(forFlavor: "cursor") == [.default, .plan, .ask, .debug, .autoReview, .yolo])
        // Pi has no runtime permission switching (always auto-approve).
        #expect(permissionModes(forFlavor: "pi") == [])
    }

    @Test func modeAllowanceFollowsTheFlavorSets() {
        #expect(isPermissionModeAllowed(.acceptEdits, forFlavor: "claude"))
        #expect(!isPermissionModeAllowed(.acceptEdits, forFlavor: "codex"))
        #expect(isPermissionModeAllowed(.yolo, forFlavor: "opencode"))
        #expect(!isPermissionModeAllowed(.yolo, forFlavor: "claude"))
    }

    // MARK: - Labels, tones, raw values (modes.ts data tables)

    @Test func permissionModeCatalogHasThirteenEntries() {
        #expect(PermissionMode.allCases.count == 13)
    }

    @Test func labelsMatchModesTs() {
        #expect(PermissionMode.default.label == "Default")
        #expect(PermissionMode.acceptEdits.label == "Accept Edits")
        #expect(PermissionMode.bypassPermissions.label == "Yolo")
        #expect(PermissionMode.autoReview.label == "Auto-review")
        #expect(PermissionMode.readOnly.label == "Read Only")
        #expect(PermissionMode.plan.label == "Plan Mode")
        #expect(PermissionMode.alwaysProceed.label == "Always Proceed")
    }

    @Test func tonesMatchModesTs() {
        #expect(PermissionMode.default.tone == .neutral)
        #expect(PermissionMode.plan.tone == .info)
        #expect(PermissionMode.safeYolo.tone == .warning)
        #expect(PermissionMode.yolo.tone == .danger)
        #expect(PermissionMode.bypassPermissions.tone == .danger)
        #expect(PermissionMode.alwaysProceed.tone == .danger)
        #expect(PermissionMode.requestReview.tone == .neutral)
    }

    @Test func kebabCaseWireValuesRoundTrip() throws {
        #expect(PermissionMode.readOnly.rawValue == "read-only")
        #expect(PermissionMode.safeYolo.rawValue == "safe-yolo")
        #expect(PermissionMode.requestReview.rawValue == "request-review")
        #expect(PermissionMode.alwaysProceed.rawValue == "always-proceed")
        let decoded = try JSONDecoder().decode(PermissionMode.self, from: Data("\"read-only\"".utf8))
        #expect(decoded == .readOnly)
    }

    @Test func optionListsCarryLabelAndTone() {
        let options = permissionModeOptions(forFlavor: "codex")
        #expect(options.count == 4)
        #expect(options.first == PermissionModeOption(mode: .default))
        #expect(options.first?.label == "Default")
        #expect(options.first?.tone == .neutral)
    }

    // MARK: - Agent flavors (modes.ts + flavors.ts)

    @Test func knownFlavorsMatchAgentFlavorsOrder() {
        #expect(AgentFlavor.knownFlavors.map(\.rawValue) == [
            "agy", "claude", "codex", "dsh", "copilot", "cursor",
            "gemini", "grok", "kimi", "opencode", "pi",
        ])
    }

    @Test func creatableFlavorsExcludeOnlyGemini() {
        #expect(AgentFlavor.creatableFlavors.count == 10)
        #expect(!AgentFlavor.creatableFlavors.contains(.gemini))
        #expect(AgentFlavor.creatableFlavors.contains(.claude))
    }

    @Test func unknownFlavorsAreCapturedNotCrashed() throws {
        let flavor = AgentFlavor(rawValue: "mystery")
        #expect(flavor == .other("mystery"))
        #expect(flavor.rawValue == "mystery")
        #expect(!flavor.isKnown)
        let decoded = try JSONDecoder().decode(AgentFlavor.self, from: Data("\"newagent\"".utf8))
        #expect(decoded == .other("newagent"))
        let known = try JSONDecoder().decode(AgentFlavor.self, from: Data("\"grok\"".utf8))
        #expect(known == .grok)
    }

    @Test func flavorLabelsMatchFlavorsTs() {
        #expect(AgentFlavor.agy.displayLabel == "Antigravity")
        #expect(AgentFlavor.grok.displayLabel == "Grok Build")
        #expect(AgentFlavor.opencode.displayLabel == "OpenCode")
        #expect(AgentFlavor.dsh.displayLabel == "DeepSeek Harness")
        #expect(AgentFlavor.other("x").displayLabel == "Unknown")
        #expect(flavorLabel(forFlavor: "pi") == "Pi")
        #expect(flavorLabel(forFlavor: nil) == "Unknown")
    }

    @Test func effortSupportMatchesFlavorsTs() {
        #expect(AgentFlavor.claude.supportsEffort)
        #expect(AgentFlavor.grok.supportsEffort)
        #expect(AgentFlavor.pi.supportsEffort)
        #expect(!AgentFlavor.codex.supportsEffort)
        #expect(!AgentFlavor.cursor.supportsEffort)
        #expect(supportsEffort(forFlavor: "claude"))
        #expect(!supportsEffort(forFlavor: "unknown"))
        #expect(!supportsEffort(forFlavor: nil))
    }

    @Test func modelChangeIsSupportedByEveryModelConfigFlavor() {
        for flavor in AgentFlavor.knownFlavors where flavor != .dsh {
            #expect(flavor.supportsModelChange, "\(flavor.rawValue) should support model change")
        }
        #expect(!AgentFlavor.dsh.supportsModelChange)
        #expect(!AgentFlavor.other("x").supportsModelChange)
        #expect(!supportsModelChange(forFlavor: nil))
    }

    @Test func codexFamilyMatchesFlavorsTs() {
        #expect(isCodexFamilyFlavor("codex"))
        #expect(isCodexFamilyFlavor("gemini"))
        #expect(isCodexFamilyFlavor("grok"))
        #expect(isCodexFamilyFlavor("kimi"))
        #expect(isCodexFamilyFlavor("copilot"))
        #expect(isCodexFamilyFlavor("opencode"))
        #expect(!isCodexFamilyFlavor("dsh"))
        #expect(!isCodexFamilyFlavor("claude"))
        #expect(!isCodexFamilyFlavor("cursor"))
        #expect(!isCodexFamilyFlavor("pi"))
        #expect(!isCodexFamilyFlavor("agy"))
        #expect(!isCodexFamilyFlavor(nil))
    }

    // MARK: - Codex collaboration + Copilot agent modes

    @Test func codexCollaborationModesMatchModesTs() {
        #expect(CodexCollaborationMode.allCases == [.default, .plan])
        #expect(CodexCollaborationMode.default.label == "Default")
        #expect(CodexCollaborationMode.plan.label == "Plan")
    }

    @Test func copilotAgentModesMatchCopilotModesTs() throws {
        #expect(CopilotAgentMode.allCases == [.interactive, .plan, .autopilot])
        #expect(CopilotAgentMode.autopilot.label == "Autopilot")
        // Legacy `fleet` coerces to interactive on decode and in normalize.
        let fleet = try JSONDecoder().decode(CopilotAgentMode.self, from: Data("\"fleet\"".utf8))
        #expect(fleet == .interactive)
        #expect(CopilotAgentMode.normalize("fleet") == .interactive)
        #expect(CopilotAgentMode.normalize("plan") == .plan)
        #expect(CopilotAgentMode.normalize(nil) == .interactive)
        #expect(CopilotAgentMode.normalize("bogus") == .interactive)
    }

    // MARK: - New-session catalogs (derived from the claude catalog data, #39)

    @Test func newSessionCatalogsMatchTheWebOptionLists() {
        #expect(NewSessionCatalogs.claudeModels == [
            NewSessionOption(value: "auto", label: "Default"),
            NewSessionOption(value: "sonnet", label: "Sonnet"),
            NewSessionOption(value: "sonnet[1m]", label: "Sonnet 1M"),
            NewSessionOption(value: "opus", label: "Opus"),
            NewSessionOption(value: "opus[1m]", label: "Opus 1M"),
            NewSessionOption(value: "fable", label: "Fable"),
            NewSessionOption(value: "fable[1m]", label: "Fable 1M"),
        ])
        #expect(NewSessionCatalogs.claudeEfforts == [
            NewSessionOption(value: "auto", label: "Auto"),
            NewSessionOption(value: "low", label: "Low"),
            NewSessionOption(value: "medium", label: "Medium"),
            NewSessionOption(value: "high", label: "High"),
            NewSessionOption(value: "xhigh", label: "XHigh"),
            NewSessionOption(value: "max", label: "Max"),
        ])
        #expect(NewSessionCatalogs.codexReasoningEfforts == [
            NewSessionOption(value: "default", label: "Default"),
            NewSessionOption(value: "low", label: "Low"),
            NewSessionOption(value: "medium", label: "Medium"),
            NewSessionOption(value: "high", label: "High"),
            NewSessionOption(value: "xhigh", label: "XHigh"),
        ])
        #expect(NewSessionCatalogs.effortLabel("xhigh") == "Xhigh")
    }
}
