import Foundation

/// One row of a `<flavor>-models` catalog for the dynamically discovered
/// agents (agy, copilot, cursor, dsh, grok, kimi, opencode, pi). The union of
/// the per-flavor `*ModelSummary` shapes in `shared/src/apiTypes.ts`; fields a
/// flavor does not send stay nil.
public struct AgentModelSummary: Codable, Equatable, Sendable {
    /// Opaque wire id, sent back verbatim (dsh ids are JSON tuples).
    public var modelId: String
    public var name: String?
    /// Kimi/Pi provider. Pi spawns as `provider/modelId` and switches with a
    /// `{provider, modelId}` reference.
    public var provider: String?
    /// Grok: efforts the model supports.
    public var reasoningEfforts: [AgentReasoningEffortOption]?
    /// Pi: `false` = the model has no thinking levels.
    public var reasoning: Bool?
    /// Pi: thinking level → provider value; `null` marks an unsupported level.
    public var thinkingLevelMap: [String: String?]?

    public init(
        modelId: String,
        name: String? = nil,
        provider: String? = nil,
        reasoningEfforts: [AgentReasoningEffortOption]? = nil,
        reasoning: Bool? = nil,
        thinkingLevelMap: [String: String?]? = nil
    ) {
        self.modelId = modelId
        self.name = name
        self.provider = provider
        self.reasoningEfforts = reasoningEfforts
        self.reasoning = reasoning
        self.thinkingLevelMap = thinkingLevelMap
    }
}

/// `GrokReasoningEffortOption` / `OpencodeReasoningEffortOption`.
public struct AgentReasoningEffortOption: Codable, Equatable, Sendable {
    public var value: String
    public var name: String?

    public init(value: String, name: String? = nil) {
        self.value = value
        self.name = name
    }
}

/// `GET /api/machines/:id/<flavor>-models` and
/// `GET /api/sessions/:id/<flavor>-models`. RPC envelope: a CLI-side failure
/// is HTTP 200 `success: false`; agy may pair `success: true` with an
/// `error` (a stale but usable catalog).
public struct AgentModelsResponse: Codable, Equatable, Sendable {
    public var success: Bool
    public var availableModels: [AgentModelSummary]?
    /// Cursor CLI SKUs (variant rows); the flat iOS picker does not use them.
    public var cliModelSkus: [AgentModelSummary]?
    /// The agent's own default (opencode/grok/copilot/kimi/dsh probes) or
    /// the running model (session routes).
    public var currentModelId: String?
    /// Grok: `false` disables the `auto` permission mode.
    public var autoPermissionModeSupported: Bool?
    public var error: String?

    public init(
        success: Bool,
        availableModels: [AgentModelSummary]? = nil,
        cliModelSkus: [AgentModelSummary]? = nil,
        currentModelId: String? = nil,
        autoPermissionModeSupported: Bool? = nil,
        error: String? = nil
    ) {
        self.success = success
        self.availableModels = availableModels
        self.cliModelSkus = cliModelSkus
        self.currentModelId = currentModelId
        self.autoPermissionModeSupported = autoPermissionModeSupported
        self.error = error
    }
}

/// `GET /api/machines/:id/opencode-model-variants`.
public struct OpencodeModelVariantsResponse: Codable, Equatable, Sendable {
    public var success: Bool
    /// Variant names keyed by `providerId/modelId`.
    public var variants: [String: [String]]?
    public var error: String?

    public init(success: Bool, variants: [String: [String]]? = nil, error: String? = nil) {
        self.success = success
        self.variants = variants
        self.error = error
    }
}

/// `GET /api/sessions/:id/grok-reasoning-effort-options` and
/// `GET /api/sessions/:id/opencode-reasoning-effort-options`.
public struct ReasoningEffortOptionsResponse: Codable, Equatable, Sendable {
    public var success: Bool
    public var options: [AgentReasoningEffortOption]?
    public var currentValue: String?
    /// OpenCode: the model the options belong to, and the requested model.
    /// The options are stale while they differ.
    public var currentModelId: String?
    public var targetModelId: String?
    public var error: String?

    public init(
        success: Bool,
        options: [AgentReasoningEffortOption]? = nil,
        currentValue: String? = nil,
        currentModelId: String? = nil,
        targetModelId: String? = nil,
        error: String? = nil
    ) {
        self.success = success
        self.options = options
        self.currentValue = currentValue
        self.currentModelId = currentModelId
        self.targetModelId = targetModelId
        self.error = error
    }
}
