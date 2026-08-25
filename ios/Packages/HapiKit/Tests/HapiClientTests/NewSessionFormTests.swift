import Foundation
import HapiClient
import HapiProtocol
import Testing

/// New-session pure logic (A-M3c), transcribed from the Android reference
/// suite (`NewSessionViewModelTest.kt`: `SpawnBodyTest` +
/// `NewSessionLogicTest`), which is itself asserted against the web create
/// form. Spawn bodies are compared as canonical JSON (`HapiJSON.encoder`
/// sorts keys), so a drifted field set or a leaked default fails loudly.
@Suite("New-session spawn body exactness")
struct NewSessionSpawnBodyTests {
    private func canonicalBody(_ form: NewSessionForm, codexFastTierVisible: Bool) throws -> String {
        let request = NewSessionLogic.buildSpawnRequest(
            form: form,
            codexFastTierVisible: codexFastTierVisible
        )
        let data = try HapiJSON.encoder.encode(request)
        return String(decoding: data, as: UTF8.self)
    }

    @Test func claudeSimpleSessionWithModelEffortAndYoloOff() throws {
        // Exact SpawnSessionRequestSchema field set — yolo false IS sent for
        // claude; permissionMode / reasoning / codex fields are absent.
        let body = try canonicalBody(
            NewSessionForm(
                machineId: "m1",
                directory: " /data/github/hapi ",
                agent: .claude,
                model: "opus",
                effort: "high",
                yolo: false
            ),
            codexFastTierVisible: false
        )
        #expect(body == """
        {"agent":"claude","directory":"/data/github/hapi","effort":"high",\
        "model":"opus","sessionType":"simple","yolo":false}
        """)
    }

    @Test func codexWorktreeWithReasoningEffortPermissionModePlanAndFastTier() throws {
        // yolo=true must NOT leak into the body for codex-family; the
        // worktree name is trimmed; startingMode stays unset in v1 (runner
        // defaults to remote).
        let body = try canonicalBody(
            NewSessionForm(
                machineId: "m1",
                directory: "/repo",
                agent: .codex,
                model: "gpt-5.2-codex",
                modelReasoningEffort: "high",
                permissionMode: .safeYolo,
                yolo: true,
                sessionType: .worktree,
                worktreeName: "  feature-x  ",
                serviceTier: .fast,
                collaborationMode: .plan
            ),
            codexFastTierVisible: true
        )
        #expect(body == """
        {"agent":"codex","collaborationMode":"plan","directory":"/repo",\
        "model":"gpt-5.2-codex","modelReasoningEffort":"high",\
        "permissionMode":"safe-yolo","serviceTier":"fast",\
        "sessionType":"worktree","worktreeName":"feature-x"}
        """)
    }

    @Test func grokSendsPermissionModeNotYoloCursorSendsYoloNotPermissionMode() throws {
        let grok = try canonicalBody(
            NewSessionForm(directory: "/repo", agent: .grok, permissionMode: .auto, yolo: true),
            codexFastTierVisible: false
        )
        #expect(grok == """
        {"agent":"grok","directory":"/repo","permissionMode":"auto","sessionType":"simple"}
        """)

        // Cursor has no v1 model picker: even a stashed model id is not sent.
        let cursor = try canonicalBody(
            NewSessionForm(directory: "/repo", agent: .cursor, model: "sonic", yolo: true),
            codexFastTierVisible: false
        )
        #expect(cursor == """
        {"agent":"cursor","directory":"/repo","sessionType":"simple","yolo":true}
        """)
    }

    @Test func dshUsesManagedPermissionPolicyAndOmitsYolo() throws {
        let body = try canonicalBody(
            NewSessionForm(directory: "/repo", agent: .dsh, yolo: true),
            codexFastTierVisible: false
        )
        #expect(body == """
        {"agent":"dsh","directory":"/repo","sessionType":"simple"}
        """)
    }

    @Test func codexDefaultSelectionsSendNoOptionalFieldsAndHiddenFastTierNoServiceTier() throws {
        let body = try canonicalBody(
            NewSessionForm(directory: "/repo", agent: .codex, serviceTier: .fast),
            codexFastTierVisible: false
        )
        // permissionMode 'default' IS sent for codex-family.
        #expect(body == """
        {"agent":"codex","directory":"/repo","permissionMode":"default","sessionType":"simple"}
        """)
    }
}

@Suite("New-session pure logic")
struct NewSessionLogicTests {
    private func dir(_ name: String) -> MachineDirectoryEntry {
        MachineDirectoryEntry(name: name, type: .directory)
    }

    @Test func parentQueryDerivation() {
        #expect(
            NewSessionLogic.parentQuery(for: "/data/gi")
                == NewSessionLogic.ParentQuery(parent: "/data", prefix: "gi")
        )
        #expect(
            NewSessionLogic.parentQuery(for: "/data/")
                == NewSessionLogic.ParentQuery(parent: "/data", prefix: "")
        )
        #expect(
            NewSessionLogic.parentQuery(for: "/d")
                == NewSessionLogic.ParentQuery(parent: "/", prefix: "d")
        )
        #expect(
            NewSessionLogic.parentQuery(for: "/")
                == NewSessionLogic.ParentQuery(parent: "/", prefix: "")
        )
        #expect(NewSessionLogic.parentQuery(for: "relative/path") == nil)
        #expect(NewSessionLogic.parentQuery(for: "") == nil)
    }

    @Test func suggestionsFilterDirectoriesByPrefixAndJoinWithParent() {
        let query = NewSessionLogic.ParentQuery(parent: "/data", prefix: "gi")
        let entries = [
            dir("github"),
            dir("gists"),
            dir("archive"),
            MachineDirectoryEntry(name: "gitconfig", type: .file),
        ]
        #expect(
            NewSessionLogic.buildSuggestions(query: query, entries: entries)
                == ["/data/github", "/data/gists"]
        )
        // Root parent must not double the slash.
        #expect(
            NewSessionLogic.buildSuggestions(
                query: NewSessionLogic.ParentQuery(parent: "/", prefix: "da"),
                entries: [dir("data")]
            ) == ["/data"]
        )
    }

    @Test func windowsDriveAndUNCAutocompletePreserveSeparators() {
        #expect(
            NewSessionLogic.parentQuery(for: "C:\\Users\\pro")
                == NewSessionLogic.ParentQuery(parent: "C:\\Users", prefix: "pro", separator: "\\")
        )
        #expect(
            NewSessionLogic.parentQuery(for: "C:\\Use")
                == NewSessionLogic.ParentQuery(parent: "C:\\", prefix: "Use", separator: "\\")
        )
        #expect(
            NewSessionLogic.parentQuery(for: "\\\\server\\share\\pro")
                == NewSessionLogic.ParentQuery(
                    parent: "\\\\server\\share",
                    prefix: "pro",
                    separator: "\\"
                )
        )
        #expect(
            NewSessionLogic.buildSuggestions(
                query: NewSessionLogic.ParentQuery(
                    parent: "C:\\Users",
                    prefix: "pro",
                    separator: "\\"
                ),
                entries: [dir("projects")]
            ) == ["C:\\Users\\projects"]
        )
    }

    @Test func recentPathsLRUDedupesToFrontAndCapsAtEight() {
        var list: [String] = []
        for index in 1...10 {
            list = NewSessionLogic.pushRecent(list, path: "/p\(index)")
        }
        #expect(list.count == 8)
        #expect(list.first == "/p10")
        #expect(list.last == "/p3")

        list = NewSessionLogic.pushRecent(list, path: "/p5")
        #expect(list.first == "/p5")
        #expect(list.count == 8)
        #expect(Set(list).count == list.count)

        #expect(NewSessionLogic.pushRecent(list, path: "   ") == list)
    }

    @Test func worktreeNameValidation() {
        #expect(NewSessionLogic.worktreeNameError("") == nil)
        #expect(NewSessionLogic.worktreeNameError("feature-x") == nil)
        #expect(NewSessionLogic.worktreeNameError("Fix Bug #42") == nil)
        #expect(NewSessionLogic.worktreeNameError("---") != nil)
        #expect(NewSessionLogic.worktreeNameError("!!!") != nil)
    }

    @Test func codexFastTierDetectionFollowsTheActiveModel() {
        let models = [
            CodexModelSummary(
                id: "gpt-5.2-codex",
                displayName: "GPT-5.2",
                isDefault: true,
                serviceTiers: ["standard", "fast"]
            ),
            CodexModelSummary(
                id: "gpt-5.2-mini",
                displayName: "Mini",
                isDefault: false,
                serviceTiers: ["standard"]
            ),
        ]
        #expect(NewSessionLogic.codexModelAdvertisesFastTier(model: "auto", models: models))
        #expect(NewSessionLogic.codexModelAdvertisesFastTier(model: "gpt-5.2-codex", models: models))
        #expect(!NewSessionLogic.codexModelAdvertisesFastTier(model: "gpt-5.2-mini", models: models))
        #expect(!NewSessionLogic.codexModelAdvertisesFastTier(model: "auto", models: []))
    }

    @Test func codexReasoningEffortsNormalizeAndFallBackToNil() {
        let models = [
            CodexModelSummary(
                id: "gpt-5.2-codex",
                displayName: "GPT-5.2",
                isDefault: true,
                supportedReasoningEfforts: [" Low ", "medium", "MEDIUM", "", "high"]
            ),
            CodexModelSummary(id: "bare", displayName: "Bare", isDefault: false),
        ]
        #expect(
            NewSessionLogic.codexReasoningEfforts(models: models, model: "auto")
                == ["low", "medium", "high"]
        )
        // A row without advertised efforts falls back to the static list (nil).
        #expect(NewSessionLogic.codexReasoningEfforts(models: models, model: "bare") == nil)
        #expect(NewSessionLogic.codexReasoningEfforts(models: [], model: "auto") == nil)
    }

    @Test func draftSanitizationCoercesUncreatableAgentAndStalePermissionMode() {
        // Gemini is decodable (stored sessions stay viewable) but not
        // creatable: the draft coerces to claude and drops the
        // agent-dependent fields while keeping directory/yolo/session type.
        let gemini = NewSessionLogic.sanitizeDraft(
            NewSessionForm(directory: "/repo", agent: .gemini, model: "gemini-2.5-pro")
        )
        #expect(gemini.agent == .claude)
        #expect(gemini.model == "auto")
        #expect(gemini.directory == "/repo")

        let badMode = NewSessionLogic.sanitizeDraft(
            NewSessionForm(agent: .codex, permissionMode: .bypassPermissions)
        )
        #expect(badMode.permissionMode == .default)

        let goodMode = NewSessionLogic.sanitizeDraft(
            NewSessionForm(agent: .codex, permissionMode: .safeYolo)
        )
        #expect(goodMode.permissionMode == .safeYolo)
    }

    @Test func draftDecodingToleratesMissingKeysAndRoundTrips() throws {
        // Older-version draft with most keys absent → per-field defaults.
        let partial = Data(#"{"directory":"/repo","agent":"codex"}"#.utf8)
        let decoded = try HapiJSON.decoder.decode(NewSessionForm.self, from: partial)
        #expect(decoded == NewSessionForm(directory: "/repo", agent: .codex))

        // Full round-trip preserves every field.
        let full = NewSessionForm(
            machineId: "m1",
            directory: "/repo",
            agent: .copilot,
            permissionMode: .yolo,
            sessionType: .worktree,
            worktreeName: "wip",
            copilotAgentMode: .autopilot
        )
        let data = try HapiJSON.encoder.encode(full)
        #expect(try HapiJSON.decoder.decode(NewSessionForm.self, from: data) == full)

        // A value the catalog enums cannot represent fails the decode — the
        // caller treats that as "no draft" (web try/catch parity).
        let unknownMode = Data(#"{"permissionMode":"brand-new-mode"}"#.utf8)
        #expect(throws: (any Error).self) {
            try HapiJSON.decoder.decode(NewSessionForm.self, from: unknownMode)
        }
    }
}
