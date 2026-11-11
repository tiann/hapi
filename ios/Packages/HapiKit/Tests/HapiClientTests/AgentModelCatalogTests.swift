import Foundation
import HapiClient
import HapiProtocol
import Testing

/// Discovered-agent model catalogs: wire decoding, the web option builders
/// (`grokModels.ts`, `piThinkingLevelOptions.ts`, `cursorCliSku.ts`) and
/// the create-form reconciliation.
@Suite("Agent model catalogs")
struct AgentModelCatalogTests {
    private func decode(_ json: String) throws -> AgentModelsResponse {
        try HapiJSON.decoder.decode(AgentModelsResponse.self, from: Data(json.utf8))
    }

    @Test func decodesTheUnionOfPerFlavorShapes() throws {
        let response = try decode("""
        {"success":true,"currentModelId":"grok-4","autoPermissionModeSupported":false,
         "availableModels":[
           {"modelId":"grok-4","name":"Grok 4","reasoningEfforts":[{"value":"high","name":"High","isDefault":true}]},
           {"modelId":"m","provider":"anthropic","reasoning":true,"thinkingLevelMap":{"off":null,"max":"max"}}
         ]}
        """)
        #expect(response.currentModelId == "grok-4")
        #expect(response.autoPermissionModeSupported == false)
        let pi = try #require(response.availableModels?.last)
        #expect(pi.thinkingLevelMap?["off"] == .some(nil))
        #expect(pi.thinkingLevelMap?["max"] == .some("max"))
        #expect(response.availableModels?.first?.reasoningEfforts == [AgentReasoningEffortOption(value: "high", name: "High")])
    }

    @Test func scopesFollowTheWebAgentDescriptors() {
        #expect(AgentModelCatalog.scope(for: .agy) == .machine)
        #expect(AgentModelCatalog.scope(for: .pi) == .machine)
        #expect(AgentModelCatalog.scope(for: .grok) == .directory)
        #expect(AgentModelCatalog.scope(for: .opencode) == .directory)
        #expect(AgentModelCatalog.scope(for: .claude) == nil)
        #expect(AgentModelCatalog.scope(for: .codex) == nil)
        #expect(AgentModelCatalog.scope(for: .gemini) == nil)
    }

    @Test func newSessionRowsPerFlavor() throws {
        let copilot = AgentModelsResponse(success: true, availableModels: [
            AgentModelSummary(modelId: "auto", name: "Auto"),
            AgentModelSummary(modelId: "gpt-5", name: "GPT-5"),
            AgentModelSummary(modelId: "gpt-5", name: "dupe"),
        ])
        #expect(AgentModelCatalog.newSessionModelOptions(flavor: .copilot, response: copilot) == [
            NewSessionOption(value: "auto", label: "Auto"),
            NewSessionOption(value: "gpt-5", label: "GPT-5"),
        ])

        let kimi = AgentModelsResponse(success: true, availableModels: [
            AgentModelSummary(modelId: "glm", name: "GLM-5", provider: "TheHive"),
            AgentModelSummary(modelId: "k2"),
        ])
        #expect(AgentModelCatalog.newSessionModelOptions(flavor: .kimi, response: kimi).map(\.label)
            == ["Default", "TheHive — GLM-5", "k2"])

        let pi = AgentModelsResponse(success: true, availableModels: [
            AgentModelSummary(modelId: "sonnet", name: "Sonnet", provider: "anthropic"),
        ])
        #expect(AgentModelCatalog.newSessionModelOptions(flavor: .pi, response: pi).last
            == NewSessionOption(value: "anthropic/sonnet", label: "anthropic — Sonnet"))

        let opencode = AgentModelsResponse(success: true, availableModels: [
            AgentModelSummary(modelId: "openai/gpt-5", name: "GPT-5"),
            AgentModelSummary(modelId: "openai/o3"),
        ], currentModelId: "openai/o3")
        #expect(AgentModelCatalog.newSessionModelOptions(flavor: .opencode, response: opencode).map(\.label)
            == ["Default", "GPT-5", "openai/o3 (default)"])

        let cursor = AgentModelsResponse(success: true, availableModels: [
            AgentModelSummary(modelId: "auto"),
            AgentModelSummary(modelId: "composer-2.5[fast=true]"),
            AgentModelSummary(modelId: "composer-2.5"),
            AgentModelSummary(modelId: "gpt-5.5-high-fast"),
        ])
        #expect(AgentModelCatalog.newSessionModelOptions(flavor: .cursor, response: cursor).map(\.value)
            == ["auto", "composer-2.5[fast=true]", "composer-2.5"])
    }

    @Test func grokEffortsFollowTheEffectiveModel() {
        let response = AgentModelsResponse(success: true, availableModels: [
            AgentModelSummary(modelId: "grok-4", reasoningEfforts: [AgentReasoningEffortOption(value: "xhigh", name: "Extra")]),
            AgentModelSummary(modelId: "grok-mini"),
        ], currentModelId: "grok-4")
        #expect(AgentModelCatalog.grokEffortOptions(response: response, model: "auto").map(\.value) == ["auto", "xhigh"])
        #expect(AgentModelCatalog.grokEffortOptions(response: response, model: "grok-mini").map(\.value)
            == ["auto", "low", "medium", "high"])
        #expect(AgentModelCatalog.grokEffortOptions(response: nil, model: "auto").count == 4)
    }

    @Test func piThinkingLevelsHonorTheMap() {
        #expect(AgentModelCatalog.piThinkingLevels(map: nil) == ["off", "minimal", "low", "medium", "high"])
        #expect(AgentModelCatalog.piThinkingLevels(map: ["off": nil, "xhigh": "xhigh", "max": nil])
            == ["minimal", "low", "medium", "high", "xhigh"])

        let response = AgentModelsResponse(success: true, availableModels: [
            AgentModelSummary(modelId: "plain", provider: "p", reasoning: false),
            AgentModelSummary(modelId: "deep", provider: "p", reasoning: true, thinkingLevelMap: ["max": "max"]),
        ])
        #expect(AgentModelCatalog.piEffortOptions(response: response, model: "p/plain") == nil)
        #expect(AgentModelCatalog.piEffortOptions(response: response, model: "p/deep")?.map(\.value)
            == ["auto", "off", "minimal", "low", "medium", "high", "max"])
        #expect(AgentModelCatalog.piEffortOptions(response: response, model: "p/deep")?.last?.label == "Max")
    }

    @Test func opencodeVariantsFollowTheEffectiveModel() {
        let response = AgentModelsResponse(success: true, currentModelId: "openai/gpt-5")
        let variants = ["openai/gpt-5": ["minimal", "high"], "local/llama": []]
        #expect(AgentModelCatalog.opencodeReasoningEffortOptions(variants: variants, response: response, model: "auto")?
            .map(\.value) == ["default", "minimal", "high"])
        #expect(AgentModelCatalog.opencodeReasoningEffortOptions(variants: variants, response: response, model: "local/llama") == nil)
        // Unknown variants: the static levels.
        #expect(AgentModelCatalog.opencodeReasoningEffortOptions(variants: nil, response: response, model: "auto")?
            .map(\.value) == ["default", "low", "medium", "high", "max"])
    }

    @Test func reconciliationResetsWhatTheCatalogNoLongerOffers() {
        let grok = AgentModelsResponse(success: true, availableModels: [
            AgentModelSummary(modelId: "grok-4", reasoningEfforts: [AgentReasoningEffortOption(value: "high")]),
        ])
        let stale = NewSessionLogic.reconcileAgentModelSelections(
            NewSessionForm(agent: .grok, model: "grok-3", effort: "high"),
            response: grok,
            variants: nil
        )
        #expect(stale.model == "auto")
        #expect(stale.effort == "high", "the static fallback still offers high")
        let kept = NewSessionLogic.reconcileAgentModelSelections(
            NewSessionForm(agent: .grok, model: "grok-4", effort: "low"),
            response: grok,
            variants: nil
        )
        #expect(kept.model == "grok-4")
        #expect(kept.effort == "auto", "grok-4 only advertises high")

        let opencode = NewSessionLogic.reconcileAgentModelSelections(
            NewSessionForm(agent: .opencode, model: "openai/gpt-5", modelReasoningEffort: "max"),
            response: AgentModelsResponse(success: true, availableModels: [AgentModelSummary(modelId: "openai/gpt-5")]),
            variants: ["openai/gpt-5": ["high"]]
        )
        #expect(opencode.model == "openai/gpt-5")
        #expect(opencode.modelReasoningEffort == "default")

        // Flavors without a discovered catalog are left alone.
        let claude = NewSessionForm(agent: .claude, model: "opus")
        #expect(NewSessionLogic.reconcileAgentModelSelections(
            claude, response: AgentModelsResponse(success: true), variants: nil
        ) == claude)
    }
}

@Suite("Agent model catalogs in session settings")
struct AgentSessionConfigTests {
    private func detail(
        flavor: String,
        model: String? = nil,
        effort: String? = nil,
        modelReasoningEffort: String? = nil,
        active: Bool = true,
        piSelectedModel: PiModelReference? = nil
    ) -> Session {
        Session(
            id: "s1", namespace: "default", seq: 1, createdAt: 1, updatedAt: 1,
            active: active, activeAt: 1,
            metadata: SessionMetadata(path: "/repo", host: "box", flavor: flavor, piSelectedModel: piSelectedModel),
            metadataVersion: 1, agentState: nil, agentStateVersion: 1, thinking: false, thinkingAt: 0,
            model: model, modelReasoningEffort: modelReasoningEffort, effort: effort
        )
    }

    @Test func rowsPerFlavorKeepAnUnlistedCurrentModelVisible() {
        let response = AgentModelsResponse(success: true, availableModels: [
            AgentModelSummary(modelId: "a", name: "A"),
            AgentModelSummary(modelId: "b"),
        ], currentModelId: "b")
        #expect(AgentModelCatalog.sessionModelOptions(flavor: .grok, response: response, currentModel: "old")
            == [CatalogOption(value: nil, label: "Default"), CatalogOption(value: "old", label: "old"),
                CatalogOption(value: "a", label: "A"), CatalogOption(value: "b", label: "b")])
        #expect(AgentModelCatalog.sessionModelOptions(flavor: .opencode, response: response, currentModel: "b").map(\.value)
            == ["a", "b"])
        #expect(AgentModelCatalog.sessionModelOptions(flavor: .dsh, response: AgentModelsResponse(success: true), currentModel: nil)
            .isEmpty)
        #expect(AgentModelCatalog.sessionModelOptions(flavor: .cursor, response: response, currentModel: "auto").first
            == CatalogOption(value: "auto", label: "Auto"))
        #expect(AgentModelCatalog.sessionCurrentModel(flavor: .cursor, response: response, sessionModel: "default[]", piSelectedModel: nil)
            == "auto")
        #expect(AgentModelCatalog.sessionCurrentModel(flavor: .opencode, response: response, sessionModel: nil, piSelectedModel: nil)
            == "b")
    }

    @Test func discoveredFlavorsStayHiddenUntilLoadedAndWhileInactive() {
        let idle = buildSessionConfigState(detail: detail(flavor: "kimi"), summary: nil, codexModels: .idle)
        #expect(idle.modelOptions == nil)
        let loading = buildSessionConfigState(detail: detail(flavor: "kimi"), summary: nil, codexModels: .idle,
                                              agentModels: .loading)
        #expect(loading.modelOptionsLoading)
        let failed = buildSessionConfigState(detail: detail(flavor: "kimi"), summary: nil, codexModels: .idle,
                                             agentModels: .failed)
        #expect(failed.modelLoadFailed)
        let inactive = buildSessionConfigState(detail: detail(flavor: "kimi", active: false), summary: nil,
                                               codexModels: .idle, agentModels: .failed)
        #expect(inactive.modelOptions == nil && !inactive.modelLoadFailed)
    }

    @Test func grokAndOpencodeEffortsComeFromTheirOptionRoutes() {
        let grok = buildSessionConfigState(
            detail: detail(flavor: "grok", effort: "high"), summary: nil, codexModels: .idle,
            agentModels: .loaded(AgentModelsResponse(success: true)),
            agentEfforts: ReasoningEffortOptionsResponse(success: true, options: [AgentReasoningEffortOption(value: "high", name: "High")])
        )
        #expect(grok.effort == "high")
        #expect(grok.effortOptions == [CatalogOption(value: nil, label: "Default"), CatalogOption(value: "high", label: "High")])

        let stale = ReasoningEffortOptionsResponse(success: true, options: [AgentReasoningEffortOption(value: "max")],
                                                   currentModelId: "old", targetModelId: "new")
        let opencode = buildSessionConfigState(
            detail: detail(flavor: "opencode", model: "new", modelReasoningEffort: "low"), summary: nil,
            codexModels: .idle, agentModels: .loaded(AgentModelsResponse(success: true)), agentEfforts: stale
        )
        #expect(opencode.effortOptions == [], "options for another model stay hidden")
        var settled = stale
        settled.currentModelId = "new"
        let ready = buildSessionConfigState(
            detail: detail(flavor: "opencode", model: "new", modelReasoningEffort: "low"), summary: nil,
            codexModels: .idle, agentModels: .loaded(AgentModelsResponse(success: true)), agentEfforts: settled
        )
        #expect(ready.effortOptions?.map(\.value) == [nil, "low", "max"])
    }

    @Test func piResolvesTheProviderAndItsThinkingLevels() {
        let response = AgentModelsResponse(success: true, availableModels: [
            AgentModelSummary(modelId: "m", name: "M", provider: "a", reasoning: true, thinkingLevelMap: ["off": nil]),
            AgentModelSummary(modelId: "m", name: "M", provider: "b", reasoning: false),
        ])
        let fromMetadata = buildSessionConfigState(
            detail: detail(flavor: "pi", model: "m", effort: "low", piSelectedModel: PiModelReference(provider: "b", modelId: "m")),
            summary: nil, codexModels: .idle, agentModels: .loaded(response)
        )
        #expect(fromMetadata.model == "b/m")
        #expect(fromMetadata.modelOptions?.map(\.value) == ["a/m", "b/m"])
        #expect(fromMetadata.effortOptions == nil, "b/m has no thinking levels")

        let fromBareId = buildSessionConfigState(
            detail: detail(flavor: "pi", model: "m", effort: "low"),
            summary: nil, codexModels: .idle, agentModels: .loaded(response)
        )
        #expect(fromBareId.model == "a/m")
        #expect(fromBareId.effortOptions?.map(\.value) == ["minimal", "low", "medium", "high"])
    }
}

@Suite("Agent model endpoints")
struct AgentModelEndpointTests {
    @Test func machineAndSessionRoutesCarryFlavorAndCwd() async throws {
        let performer = RecordingPerformer()
        let api = try makeStoreAPIClient(performer: performer)
        await performer.enqueue(json: #"{"success":true,"availableModels":[{"modelId":"m"}]}"#)
        let machine = try await api.machineAgentModels(machineId: "mach 1", flavor: .kimi, cwd: "/repo dir")
        #expect(machine.availableModels?.first?.modelId == "m")
        await performer.enqueue(json: #"{"success":true,"variants":{"a/b":["high"]}}"#)
        let variants = try await api.machineOpencodeModelVariants(machineId: "m1", cwd: "/repo")
        #expect(variants.variants?["a/b"] == ["high"])
        await performer.enqueue(json: #"{"success":true}"#)
        _ = try await api.sessionAgentModels(sessionId: "s1", flavor: .dsh)
        await performer.enqueue(json: #"{"success":true,"options":[{"value":"low"}],"currentModelId":"x"}"#)
        let efforts = try await api.sessionReasoningEffortOptions(sessionId: "s1", flavor: .grok)
        #expect(efforts.options?.first?.value == "low")

        let urls = await performer.requests.compactMap { $0.url }
        #expect(urls.map(\.path) == [
            "/api/machines/mach 1/kimi-models",
            "/api/machines/m1/opencode-model-variants",
            "/api/sessions/s1/dsh-models",
            "/api/sessions/s1/grok-reasoning-effort-options",
        ])
        #expect(urls.first.flatMap { URLComponents(url: $0, resolvingAgainstBaseURL: false)?.queryItems }
            == [URLQueryItem(name: "cwd", value: "/repo dir")])
    }
}
