import Foundation
import HapiProtocol

/// New-session form state + the pure mapping/validation logic around it
/// (A-M3c) — the iOS counterpart of the Android reference's
/// `NewSessionForm.kt`, which itself ports the web create form
/// (`web/src/components/NewSession/index.tsx`, `handleCreate`). Everything
/// here is UI-free so package tests can assert the exact spawn body against
/// `SpawnSessionRequestSchema`.
///
/// Unlike the Android original (open strings everywhere), enum-backed fields
/// use the `HapiProtocol` catalog types directly — a draft holding a value
/// these enums cannot represent fails to decode and degrades to no draft,
/// which is the same end state as the web's try/catch around
/// `loadNewSessionFormDraft`.
public struct NewSessionForm: Codable, Equatable, Sendable {
    public var machineId: String?
    public var directory: String
    /// Flavor from ``AgentFlavor/creatableFlavors``.
    public var agent: AgentFlavor
    /// `'auto'` = no explicit model (claude presets / codex catalog ids).
    public var model: String
    /// Claude launch effort; `'auto'` = omit.
    public var effort: String
    /// Codex reasoning effort; `'default'` = omit.
    public var modelReasoningEffort: String
    /// Native permission mode for grok + codex-family flavors.
    public var permissionMode: PermissionMode
    /// HAPI YOLO preference for the remaining flavors (claude/agy/cursor/pi).
    public var yolo: Bool
    public var sessionType: SpawnSessionType
    public var worktreeName: String
    /// Codex; only sent while the fast tier is visible.
    public var serviceTier: ServiceTier
    /// Codex collaboration mode.
    public var collaborationMode: CodexCollaborationMode
    /// Copilot; always sent for copilot.
    public var copilotAgentMode: CopilotAgentMode

    public init(
        machineId: String? = nil,
        directory: String = "",
        agent: AgentFlavor = .claude,
        model: String = "auto",
        effort: String = "auto",
        modelReasoningEffort: String = "default",
        permissionMode: PermissionMode = .default,
        yolo: Bool = false,
        sessionType: SpawnSessionType = .simple,
        worktreeName: String = "",
        serviceTier: ServiceTier = .standard,
        collaborationMode: CodexCollaborationMode = .default,
        copilotAgentMode: CopilotAgentMode = .interactive
    ) {
        self.machineId = machineId
        self.directory = directory
        self.agent = agent
        self.model = model
        self.effort = effort
        self.modelReasoningEffort = modelReasoningEffort
        self.permissionMode = permissionMode
        self.yolo = yolo
        self.sessionType = sessionType
        self.worktreeName = worktreeName
        self.serviceTier = serviceTier
        self.collaborationMode = collaborationMode
        self.copilotAgentMode = copilotAgentMode
    }

    public var trimmedDirectory: String {
        directory.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    // Manual decode with per-field defaults so a draft written by an older
    // app version (missing keys) still restores, mirroring kotlinx defaults
    // on the Android side. Encoding stays synthesized.
    private enum CodingKeys: String, CodingKey {
        case machineId, directory, agent, model, effort, modelReasoningEffort
        case permissionMode, yolo, sessionType, worktreeName, serviceTier
        case collaborationMode, copilotAgentMode
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        machineId = try container.decodeIfPresent(String.self, forKey: .machineId)
        directory = try container.decodeIfPresent(String.self, forKey: .directory) ?? ""
        agent = try container.decodeIfPresent(AgentFlavor.self, forKey: .agent) ?? .claude
        model = try container.decodeIfPresent(String.self, forKey: .model) ?? "auto"
        effort = try container.decodeIfPresent(String.self, forKey: .effort) ?? "auto"
        modelReasoningEffort = try container.decodeIfPresent(String.self, forKey: .modelReasoningEffort)
            ?? "default"
        permissionMode = try container.decodeIfPresent(PermissionMode.self, forKey: .permissionMode)
            ?? .default
        yolo = try container.decodeIfPresent(Bool.self, forKey: .yolo) ?? false
        sessionType = try container.decodeIfPresent(SpawnSessionType.self, forKey: .sessionType)
            ?? .simple
        worktreeName = try container.decodeIfPresent(String.self, forKey: .worktreeName) ?? ""
        serviceTier = try container.decodeIfPresent(ServiceTier.self, forKey: .serviceTier)
            ?? .standard
        collaborationMode = try container.decodeIfPresent(
            CodexCollaborationMode.self,
            forKey: .collaborationMode
        ) ?? .default
        copilotAgentMode = try container.decodeIfPresent(CopilotAgentMode.self, forKey: .copilotAgentMode)
            ?? .interactive
    }
}

/// Pure new-session logic (Android `NewSessionLogic` port; web reference in
/// each doc comment).
public enum NewSessionLogic {
    // MARK: - Permission control routing

    /// Flavors sharing the codex-style native permission select
    /// (`web/src/lib/codexFamilyPermissionAgents.ts`). Gemini is listed for
    /// completeness though it is not creatable.
    public static let codexFamilyPermissionAgents: Set<AgentFlavor> = [
        .codex, .gemini, .kimi, .copilot, .opencode,
    ]

    public static func usesCodexFamilyPermissionModes(_ flavor: AgentFlavor) -> Bool {
        codexFamilyPermissionAgents.contains(flavor)
    }

    /// Flavors whose permission control is the native-mode select.
    public static func usesNativePermissionSelect(_ flavor: AgentFlavor) -> Bool {
        flavor == .grok || usesCodexFamilyPermissionModes(flavor)
    }

    /// `resolveHapiYoloPermissionMode` (`shared/src/agentConfig.ts`) — the
    /// native mode the HAPI YOLO toggle maps to, for the toggle's caption.
    public static func hapiYoloNativeMode(for flavor: AgentFlavor) -> PermissionMode? {
        switch flavor {
        case .claude, .grok: return .bypassPermissions
        case .agy: return .alwaysProceed
        case .codex, .copilot, .cursor, .gemini, .kimi, .opencode: return .yolo
        case .dsh, .pi, .other: return nil
        }
    }

    // MARK: - Spawn body

    /// Exact spawn body (`POST /api/machines/:id/spawn`), field-for-field
    /// port of the web `handleCreate` mapping:
    /// - `model`/`effort` only for flavors whose picker exists in this v1
    ///   (claude static list, codex machine catalog; others send no model);
    /// - `yolo` for non-grok/non-codex-family flavors — **including `false`**;
    /// - `permissionMode` for grok + codex-family — including `'default'`;
    /// - `sessionType` always; `worktreeName` only for worktree and non-blank;
    /// - `serviceTier` only while the codex fast tier is visible (then also
    ///   `'standard'`); `collaborationMode` only when not `'default'`;
    /// - `copilotAgentMode` always for copilot;
    /// - `startingMode` omitted = the runner's `'remote'` default (v1 fixes
    ///   remote; pty is deferred, matching the web create form).
    public static func buildSpawnRequest(
        form: NewSessionForm,
        codexFastTierVisible: Bool
    ) -> SpawnRequest {
        let agent = form.agent
        let codexFamily = usesCodexFamilyPermissionModes(agent)
        let isGrok = agent == .grok
        // v1 model pickers: claude (static presets) and codex (machine
        // catalog). Other flavors' discovery endpoints are TODO(M4+), so
        // their model is never sent.
        let resolvedModel: String? = ((agent == .claude || agent == .codex) && form.model != "auto")
            ? form.model
            : nil
        let trimmedWorktreeName = form.worktreeName.trimmingCharacters(in: .whitespacesAndNewlines)
        return SpawnRequest(
            directory: form.trimmedDirectory,
            agent: agent,
            model: resolvedModel,
            effort: (agent == .claude && form.effort != "auto") ? form.effort : nil,
            modelReasoningEffort: (agent == .codex && form.modelReasoningEffort != "default")
                ? form.modelReasoningEffort
                : nil,
            yolo: (agent == .dsh || isGrok || codexFamily) ? nil : form.yolo,
            permissionMode: (isGrok || codexFamily) ? form.permissionMode : nil,
            sessionType: form.sessionType,
            worktreeName: (form.sessionType == .worktree && !trimmedWorktreeName.isEmpty)
                ? trimmedWorktreeName
                : nil,
            serviceTier: (agent == .codex && codexFastTierVisible) ? form.serviceTier : nil,
            collaborationMode: (agent == .codex && form.collaborationMode != .default)
                ? form.collaborationMode
                : nil,
            copilotAgentMode: agent == .copilot ? form.copilotAgentMode : nil,
            startingMode: nil
        )
    }

    // MARK: - Directory autocomplete

    /// Parent listing target for the autocomplete dropdown.
    public struct ParentQuery: Equatable, Sendable {
        /// Absolute directory to `POST list-directory`.
        public let parent: String
        /// Typed tail the entries are prefix-filtered by (case-insensitive).
        public let prefix: String
        /// Separator used by the typed path; suggestions preserve it.
        public let separator: String

        public init(parent: String, prefix: String, separator: String = "/") {
            self.parent = parent
            self.prefix = prefix
            self.separator = separator
        }
    }

    /// Derives the list-directory request from the typed text: list the
    /// parent of the path segment being typed. Only absolute paths
    /// autocomplete (the hub lists runner-local absolute paths).
    ///
    /// `/data/gi` → list `/data`, prefix `gi`; `/data/` → list `/data`, no
    /// prefix; `/` → list `/`; relative text → nil (no request).
    public static func parentQuery(for input: String) -> ParentQuery? {
        let text = input.trimmingCharacters(in: .whitespacesAndNewlines)
        let characters = Array(text)
        let isPosix = characters.first == "/"
        let isDrive = characters.count >= 3
            && characters[0].isLetter
            && characters[1] == ":"
            && isPathSeparator(characters[2])
        let isUNC = characters.count >= 2
            && ((characters[0] == "\\" && characters[1] == "\\")
                || (characters[0] == "/" && characters[1] == "/"))
        guard isPosix || isDrive || isUNC,
              let separatorIndex = characters.lastIndex(where: isPathSeparator)
        else {
            return nil
        }

        let separator = String(characters[separatorIndex])
        let rawParent = String(characters[..<separatorIndex])
        let parent: String
        if separatorIndex == 0 {
            parent = separator
        } else if isDrivePrefix(rawParent) {
            parent = rawParent + separator
        } else if rawParent.isEmpty, isUNC {
            parent = separator + separator
        } else {
            parent = rawParent
        }
        return ParentQuery(
            parent: parent,
            prefix: String(characters.dropFirst(separatorIndex + 1)),
            separator: separator
        )
    }

    /// Joins a listed entry back into a full suggestion path, then filters
    /// to directories matching the typed prefix, capped like the web (8).
    public static func buildSuggestions(
        query: ParentQuery,
        entries: [MachineDirectoryEntry],
        limit: Int = 8
    ) -> [String] {
        let base = query.parent.hasSuffix("/") || query.parent.hasSuffix("\\")
            ? query.parent
            : query.parent + query.separator
        let loweredPrefix = query.prefix.lowercased()
        return entries
            .filter { $0.type == .directory }
            .filter { loweredPrefix.isEmpty || $0.name.lowercased().hasPrefix(loweredPrefix) }
            .prefix(limit)
            .map { "\(base)\($0.name)" }
    }

    private static func isPathSeparator(_ character: Character) -> Bool {
        character == "/" || character == "\\"
    }

    private static func isDrivePrefix(_ value: String) -> Bool {
        let characters = Array(value)
        return characters.count == 2 && characters[0].isLetter && characters[1] == ":"
    }

    // MARK: - Recent paths

    /// LRU cap per machine (web caps at 5; native chips fit a couple more).
    public static let maxRecentPaths = 8

    /// Dedupe-to-front LRU push (web `addRecentPath`). Blank input is a no-op.
    public static func pushRecent(
        _ existing: [String],
        path: String,
        cap: Int = maxRecentPaths
    ) -> [String] {
        let trimmed = path.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return existing }
        return Array(([trimmed] + existing.filter { $0 != trimmed }).prefix(cap))
    }

    // MARK: - Worktree

    /// Client-side worktree-name check. The runner slugs the name to
    /// `[a-z0-9-]` (`cli/src/runner/worktree.ts` `toSlug`); a name with no
    /// alphanumeric characters slugs to nothing and the spawn fails server
    /// side, so reject it up front. Empty is fine — the runner generates a
    /// `MMDD-xxxx` default.
    public static func worktreeNameError(_ name: String) -> String? {
        let trimmed = name.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return nil }
        let hasAlphanumeric = trimmed.contains { $0.isLetter || $0.isNumber }
        return hasAlphanumeric ? nil : "Name needs at least one letter or digit"
    }

    // MARK: - Codex catalog

    /// Active catalog entry for `model` (`'auto'` → the default row).
    public static func resolveCodexModel(
        models: [CodexModelSummary],
        model: String
    ) -> CodexModelSummary? {
        let normalized = model.trimmingCharacters(in: .whitespacesAndNewlines)
        if normalized.isEmpty || normalized == "auto" {
            return models.first { $0.isDefault } ?? models.first
        }
        return models.first { $0.id == normalized }
    }

    /// `codexModelAdvertisesFastTier`: the fast-mode control only appears
    /// when the active model's catalog row advertises a fast service tier.
    /// Empty catalog → hidden (no authoritative answer yet).
    public static func codexModelAdvertisesFastTier(
        model: String,
        models: [CodexModelSummary]
    ) -> Bool {
        guard !models.isEmpty else { return false }
        let normalized = model.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        let active: CodexModelSummary?
        if !normalized.isEmpty && normalized != "auto" {
            active = models.first {
                $0.id.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() == normalized
            }
        } else {
            active = models.first { $0.isDefault }
        }
        return active?.serviceTiers?.contains {
            $0.trimmingCharacters(in: .whitespacesAndNewlines).lowercased().contains("fast")
        } == true
    }

    /// Supported reasoning efforts of the active codex model, normalized
    /// (trim/lowercase/dedupe — `getCodexModelReasoningEfforts`); nil when
    /// the catalog does not advertise any (fall back to the static list).
    public static func codexReasoningEfforts(
        models: [CodexModelSummary],
        model: String
    ) -> [String]? {
        guard let efforts = resolveCodexModel(models: models, model: model)?
            .supportedReasoningEfforts
        else {
            return nil
        }
        var seen = Set<String>()
        let normalized = efforts
            .map { $0.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() }
            .filter { !$0.isEmpty && seen.insert($0).inserted }
        return normalized.isEmpty ? nil : normalized
    }

    // MARK: - Drafts

    /// Draft sanitization on restore (web `loadNewSessionFormDraft`): an
    /// uncreatable/unknown agent coerces to claude and drops the
    /// agent-dependent fields; a permission mode outside the flavor's
    /// catalog resets to default. (The Android original also re-normalizes
    /// serviceTier/collaborationMode/copilotAgentMode/sessionType strings —
    /// here those are enum-constrained already.)
    public static func sanitizeDraft(_ draft: NewSessionForm) -> NewSessionForm {
        let creatable = AgentFlavor.creatableFlavors.contains(draft.agent)
        var base = creatable ? draft : NewSessionForm(
            machineId: draft.machineId,
            directory: draft.directory,
            agent: .claude,
            yolo: draft.yolo,
            sessionType: draft.sessionType,
            worktreeName: draft.worktreeName
        )
        if !base.agent.permissionModes.contains(base.permissionMode) {
            base.permissionMode = .default
        }
        return base
    }
}
