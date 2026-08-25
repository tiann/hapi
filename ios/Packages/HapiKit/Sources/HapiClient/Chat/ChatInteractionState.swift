import Foundation
import HapiProtocol

// Value types + pure mapping logic of the chat interaction layer (A-M3ab),
// mirroring the Android `ChatViewModel`'s M3 surface. The stateful
// orchestration lives in `ChatInteractor`.

// MARK: - Composer

/// Composer bar state.
public struct ComposerState: Equatable, Sendable {
    public let text: String
    /// A send (or its inactive-session resume) is in flight — spinner on the
    /// send button.
    public let isSending: Bool
    /// A turn is active: long-press send offers Steer; an empty draft shows Stop.
    public let canSteer: Bool

    public init(text: String, isSending: Bool, canSteer: Bool) {
        self.text = text
        self.isSending = isSending
        self.canSteer = canSteer
    }
}

/// One row of the queued-messages bar (uninvoked sends).
public struct QueuedMessageRow: Equatable, Sendable, Identifiable {
    public let id: String
    public let localId: String?
    public let text: String
    public let attachmentNames: [String]
    public let scheduledAt: Int?
    /// Server echo has landed (`id != localId`) and no queued operation is in
    /// flight — Cancel/Edit act only then (web `computeCanCancel`).
    public let canAct: Bool
    /// Steer offered: turn active, not future-scheduled, actionable.
    public let canSteer: Bool
    public let indeterminate: Bool

    public init(
        id: String,
        localId: String?,
        text: String,
        attachmentNames: [String],
        scheduledAt: Int?,
        canAct: Bool,
        canSteer: Bool,
        indeterminate: Bool = false
    ) {
        self.id = id
        self.localId = localId
        self.text = text
        self.attachmentNames = attachmentNames
        self.scheduledAt = scheduledAt
        self.canAct = canAct
        self.canSteer = canSteer
        self.indeterminate = indeterminate
    }
}

// MARK: - Permissions

/// Optimistic-permission UI state layered over the reduced blocks.
public enum PermissionRowOverride: Equatable, Sendable {
    /// Decision POSTed; waiting for the agentState patch to settle it.
    case resolving

    /// The hub said the request is no longer pending (404/409) — benign.
    case alreadyHandled
}

/// A permission decision the UI can request (bodies mirror
/// `PermissionFooter.tsx` / `AskUserQuestionFooter.tsx` /
/// `RequestUserInputFooter.tsx`).
public enum PermissionAction: Equatable, Sendable {
    /// Plain allow — `{}` (claude family) or `{"decision":"approved"}`
    /// (codex family).
    case allow

    /// Claude: `{"allowTools":[…]}`; everyone else:
    /// `{"decision":"approved_for_session"}`.
    case allowForSession

    /// Claude edit tools: `{"mode":"acceptEdits"}`.
    case allowAllEdits

    /// Plain deny — `{}`.
    case deny

    /// Codex family: deny with `{"decision":"abort"}`.
    case abort

    /// AskUserQuestion: flat `{"<key>": ["label", …]}`.
    case flatAnswers([String: [String]])

    /// request_user_input: nested `{"<fieldId>": {"answers": […]}}`.
    case nestedAnswers([String: [String]])
}

/// `PermissionFooter.isCodexSession` twin: codex family or cursor flavor, or
/// a codex-dialect tool name — selects both the button set and the plain
/// allow body.
public func isCodexPermissionUX(flavor: String?, toolName: String?) -> Bool {
    if isCodexFamilyFlavor(flavor) || flavor == "cursor" {
        return true
    }
    guard let toolName else { return false }
    return toolName.hasPrefix("Codex")
        || toolName.hasPrefix("Gemini")
        || toolName.hasPrefix("OpenCode")
        || toolName.hasPrefix("Copilot")
        || toolName.hasPrefix("Cursor")
}

/// The web footer's tool-name gates.
public enum PermissionGates {
    /// Tools whose approval may offer "Allow all edits" (claude).
    public static let editTools: Set<String> = ["Edit", "MultiEdit", "Write", "NotebookEdit"]

    /// Tools that never offer "Allow for this session".
    public static let hideAllowForSession: Set<String> =
        editTools.union(["exit_plan_mode", "ExitPlanMode", "CursorCreatePlan"])
}

/// Builds the approve body for one decision — the exact `PermissionFooter`
/// mapping table. `deny`/`abort` never reach this (they use the deny
/// endpoint).
public func permissionApproveBody(
    action: PermissionAction,
    flavor: String?,
    toolName: String?,
    arguments: JSONValue?
) -> PermissionApproveRequest {
    switch action {
    case .allow:
        if isCodexPermissionUX(flavor: flavor, toolName: toolName) {
            return PermissionApproveRequest(decision: .approved)
        }
        return PermissionApproveRequest()

    case .allowForSession:
        if flavor == "claude" {
            let command = toolName == "Bash" ? inputString(arguments, keys: ["command", "cmd"]) : nil
            let toolIdentifier: String
            if toolName == "Bash", let command {
                toolIdentifier = "Bash(\(command))"
            } else {
                toolIdentifier = toolName ?? ""
            }
            return PermissionApproveRequest(allowTools: [toolIdentifier])
        }
        return PermissionApproveRequest(decision: .approvedForSession)

    case .allowAllEdits:
        return PermissionApproveRequest(mode: .acceptEdits)

    case .flatAnswers(let answers):
        return PermissionApproveRequest(answers: .object(
            answers.mapValues { values in .array(values.map(JSONValue.string)) }
        ))

    case .nestedAnswers(let answers):
        return PermissionApproveRequest(answers: .object(
            answers.mapValues { values in
                .object(["answers": .array(values.map(JSONValue.string))])
            }
        ))

    case .deny, .abort:
        assertionFailure("deny actions do not build approve bodies")
        return PermissionApproveRequest()
    }
}

// MARK: - Session config

/// Load state of the per-session codex model catalog.
public enum CodexModelsState: Equatable, Sendable {
    case idle
    case loading
    case loaded([CodexModelSummary])
    case failed
}

/// Session config sheet model.
public struct SessionConfigState: Equatable, Sendable {
    public let flavor: String?
    public let active: Bool
    /// Terminal-controlled sessions reject config posts with 409.
    public let controlledByUser: Bool
    /// Current wire mode; nil renders as the Default row.
    public let permissionMode: PermissionMode?
    /// Catalog modes for this flavor; empty → hide the section (pi).
    public let permissionModes: [PermissionModeOption]
    public let model: String?
    /// nil → hide the model section (flavor without a known catalog).
    public let modelOptions: [CatalogOption]?
    /// True while the codex model catalog loads (sheet shows a spinner row).
    public let modelOptionsLoading: Bool
    /// Claude `effort` or codex `modelReasoningEffort`, whichever applies.
    public let effort: String?
    /// nil → hide the effort section.
    public let effortOptions: [CatalogOption]?

    public init(
        flavor: String?,
        active: Bool,
        controlledByUser: Bool,
        permissionMode: PermissionMode?,
        permissionModes: [PermissionModeOption],
        model: String?,
        modelOptions: [CatalogOption]?,
        modelOptionsLoading: Bool,
        effort: String?,
        effortOptions: [CatalogOption]?
    ) {
        self.flavor = flavor
        self.active = active
        self.controlledByUser = controlledByUser
        self.permissionMode = permissionMode
        self.permissionModes = permissionModes
        self.model = model
        self.modelOptions = modelOptions
        self.modelOptionsLoading = modelOptionsLoading
        self.effort = effort
        self.effortOptions = effortOptions
    }
}

/// Catalog-driven derivation of the config sheet model (Android
/// `buildConfigUi`).
public func buildSessionConfigState(
    detail: Session?,
    summary: SessionSummary?,
    codexModels: CodexModelsState
) -> SessionConfigState {
    let flavor = detail?.metadata?.flavor ?? summary?.metadata?.flavor
    let model = detail?.model
    var modelOptions: [CatalogOption]?
    var modelOptionsLoading = false
    var effort: String?
    var effortOptions: [CatalogOption]?

    switch flavor {
    case "claude":
        modelOptions = ModelCatalog.claudeModelOptions(currentModel: model)
        effort = detail?.effort
        effortOptions = ModelCatalog.claudeEffortOptions(currentEffort: effort)
    case "codex":
        switch codexModels {
        case .loaded(let models):
            modelOptions = models.map { row in
                CatalogOption(
                    value: row.id,
                    label: row.displayName + (row.isDefault ? " · default" : "")
                )
            }
            let selected = models.first { $0.id == model } ?? models.first { $0.isDefault }
            let efforts = selected?.supportedReasoningEfforts ?? []
            if !efforts.isEmpty {
                effort = detail?.modelReasoningEffort
                effortOptions = [CatalogOption(value: nil, label: "Default")] + efforts.map { level in
                    CatalogOption(value: level, label: ModelCatalog.capitalizedFirst(level))
                }
            }
        case .loading:
            modelOptions = []
            modelOptionsLoading = true
        case .idle, .failed:
            modelOptions = []
        }
    default:
        modelOptions = nil // Generic fallback: hide the picker.
    }

    return SessionConfigState(
        flavor: flavor,
        active: detail?.active ?? summary?.active ?? false,
        controlledByUser: detail?.agentState?.controlledByUser == true,
        permissionMode: detail?.permissionMode,
        permissionModes: permissionModeOptions(forFlavor: flavor),
        model: model,
        modelOptions: modelOptions,
        modelOptionsLoading: modelOptionsLoading,
        effort: effort,
        effortOptions: effortOptions
    )
}

// MARK: - Events

/// One-shot side effects for the chat screen.
public enum ChatInteractionEvent: Equatable, Sendable {
    /// Resume returned a different session id — renavigate to it.
    case sessionSuperseded(sessionId: String)

    /// Transient failure/notice for a toast.
    case notice(String)
}
