import HapiProtocol
import Testing

@Suite("Cursor model parameters")
struct CursorModelCatalogTests {
    private func catalog(_ acp: [String] = [], skus: [String] = []) -> CursorModelCatalog {
        CursorModelCatalog(response: AgentModelsResponse(success: true,
            availableModels: acp.map { AgentModelSummary(modelId: $0) },
            cliModelSkus: skus.map { AgentModelSummary(modelId: $0) }))
    }

    @Test func choosesAdvertisedWiresPreservingOtherParameters() throws {
        let ids = [
            "a[context=64k,thinking=true,reasoning_effort=high,fast=false]",
            "a[fast=true,reasoning_effort=high,context=64k,thinking=true]",
            "a[context=64k,thinking=false,reasoning_effort=high,fast=false]",
            "a[context=32k,thinking=true,reasoning_effort=high,fast=false]",
            "a[context=64k,thinking=true,reasoning_effort=low,fast=false]",
        ]
        let catalog = catalog(ids)
        let fields = catalog.fields(for: ids[0])
        #expect(catalog.defaultWire(for: "a") == ids[0])
        #expect(fields.map(\.title) == ["Reasoning effort", "Thinking", "Context window", "Fast mode"])
        for (field, wire) in zip(fields, [ids[4], ids[2], ids[3], ids[1]]) {
            #expect(field.choices.map(\.wire) == [ids[0], wire])
        }
        let sparse = try #require(catalog.fields(for: ids[1]).first { $0.title == "Thinking" })
        #expect(sparse.choices.map(\.wire) == [ids[1], nil])
    }

    @Test func skuParametersUseOnlyAdvertisedSuffixesAndMaintainFamily() {
        let catalog = catalog(["grok", "grok-ultra-high", "grok-low"], skus: [
            "cursor-grok-medium", "cursor-grok-high", "cursor-grok-high-fast",
        ])
        #expect(catalog.families == ["grok"])
        #expect(!catalog.contains("grok-high"))
        #expect(!catalog.contains("grok-low"))
        let fields = catalog.fields(for: "cursor-grok-medium")
        #expect(fields.map(\.title) == ["Reasoning effort", "Fast mode"])
        #expect(fields[1].choices.map(\.wire) == ["cursor-grok-medium", nil])
        #expect(catalog.fields(for: "cursor-grok-high")[1].choices.last?.wire == "cursor-grok-high-fast")

        let named = self.catalog(skus: ["thinking-machine-high", "thinking-machine-low"])
        #expect(named.fields(for: "thinking-machine-low").map(\.title) == ["Reasoning effort"])
        #expect(named.defaultWire(for: "thinking-machine") == "thinking-machine-high")
    }

    @Test func mixedCatalogUsesSKUParametersAndMatchesOnlyConfirmedSettings() {
        let current = "a[context=272k,reasoning=medium,fast=false]"
        let skus = ["a-low", "a-medium", "a-medium-fast"]
        let mixed = catalog([current], skus: skus)
        for selection in [current, "a-medium"] {
            let fields = mixed.fields(for: selection)
            #expect(fields.map(\.title) == ["Reasoning effort", "Fast mode"])
            #expect(fields.first?.choices.compactMap(\.wire) == ["a-low", selection])
            #expect(fields.last?.choices.compactMap(\.wire) == [selection, "a-medium-fast"])
        }
        for alternative in [
            "a[context=272k,reasoning=high,fast=false]",
            "a[context=1m,reasoning=medium,fast=false]",
            "a[custom=unknown,reasoning=medium,fast=false]",
        ] {
            let all = [current, alternative] + skus
            let mixed = catalog([current, alternative], skus: skus)
            for selection in [alternative, "a-low", current] {
                let fields = mixed.fields(for: selection)
                #expect(fields.map(\.title) == ["Variant"])
                #expect(fields.first?.choices.compactMap(\.wire) == all)
            }
        }
    }

    @Test func bareACPBaseRetainsUnsetParameterAlongsideExplicitWireChoices() {
        let ids = ["a", "a[fast=false]", "a[fast=true]"]
        let fields = catalog(ids).fields(for: "a[fast=false]")
        #expect(fields.map(\.title) == ["Fast mode"])
        #expect(fields.first?.choices.map(\.label) == ["Default", "Standard", "Fast"])
        #expect(fields.first?.choices.compactMap(\.wire) == ids)
    }

    @Test func wholeVariantsRetainCoupledUnknownAndAmbiguousCombinations() {
        for ids in [
            ["a[effort=low,fast=true]", "a[effort=high,fast=false]"],
            ["a[effort=low,custom=X]", "a[effort=low,custom=Y]"],
            ["a[effort=low,fast=true]", "a[fast=true,effort=low]"],
        ] {
            let fields = catalog(ids).fields(for: ids[0])
            #expect(fields.map(\.title) == ["Variant"])
            #expect(fields.first?.choices.compactMap(\.wire) == ids)
        }
        let effort = catalog(["a[effort=low]", "a[effort=high]"])
        #expect(effort.fields(for: "a[effort=low]").map(\.title) == ["Effort"])
    }

    @Test func autoAndStaleStateNeverCreateSelectableCatalogRows() {
        let catalog = catalog(["default", "default[]", "auto", "a[fast=true]", "a[fast=true]", "a[fast=false"])
        #expect(catalog.options.map(\.modelId) == ["a[fast=true]"])
        #expect(catalog.contains("auto"))
        #expect(!catalog.contains("default[]"))
        #expect(!catalog.contains("a"))
        #expect(catalog.family(for: "a[fast=false]") == nil)
        #expect(CursorModelCatalog.selectionValue("default[]") == "default")
        #expect(CursorModelCatalog.selectionValue("auto") == "auto")
        #expect(CursorModelCatalog(response: AgentModelsResponse(success: false,
            cliModelSkus: [AgentModelSummary(modelId: "stale")])).options.isEmpty)
    }
}
