package app.hapi.companion.feature.newsession

import app.hapi.protocol.wire.CopilotModelSummary
import app.hapi.protocol.wire.GrokModelSummary
import app.hapi.protocol.wire.GrokReasoningEffortOption
import app.hapi.protocol.wire.KimiModelSummary
import app.hapi.protocol.wire.OpencodeModelSummary
import app.hapi.protocol.wire.PiModelSummary
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * Pure per-flavor option builders — ports of the web memos/helpers in
 * `web/src/components/NewSession/index.tsx`, `grokModels.ts`,
 * `piThinkingLevelOptions.ts` and the cursor picker-state libs.
 */
class FlavorModelOptionsTest {

    // ------------------------------------------------------------------ grok --

    @Test
    fun `grok model options prepend the Default row`() {
        val options = FlavorModelOptions.grokModelOptions(
            listOf(GrokModelSummary(modelId = "grok-4", name = "Grok 4")),
        )
        assertEquals(listOf(OptionItem("auto", "Default"), OptionItem("grok-4", "Grok 4")), options)
    }

    @Test
    fun `grok efforts follow the effective model and fall back to the static list`() {
        val models = listOf(
            GrokModelSummary(
                modelId = "grok-4",
                name = "Grok 4",
                reasoningEfforts = listOf(
                    GrokReasoningEffortOption(value = "low"),
                    GrokReasoningEffortOption(value = "dynamic", name = "Dynamic"),
                ),
            ),
            GrokModelSummary(modelId = "grok-3", name = null),
        )
        // Selected model drives the rows; advertised names win, else the raw id.
        assertEquals(
            listOf(OptionItem("auto", "Default"), OptionItem("low", "low"), OptionItem("dynamic", "Dynamic")),
            FlavorModelOptions.grokEffortOptions(models, selectedModel = "grok-4", currentModelId = null),
        )
        // Default selection resolves through the machine's current model.
        assertEquals(
            FlavorModelOptions.grokEffortOptions(models, "grok-4", "grok-3"),
            FlavorModelOptions.grokEffortOptions(models, "auto", "grok-4"),
        )
        // No advertised efforts (or unknown current model) → static fallback.
        assertEquals(
            FlavorModelOptions.GROK_EFFORTS,
            FlavorModelOptions.grokEffortOptions(models, "auto", "grok-3"),
        )
        assertEquals(FlavorModelOptions.GROK_EFFORTS, FlavorModelOptions.grokEffortOptions(emptyList(), "auto", null))
    }

    // --------------------------------------------------------------- copilot --

    @Test
    fun `copilot options label the sentinel Auto and drop duplicate auto rows`() {
        val options = FlavorModelOptions.copilotModelOptions(
            listOf(
                CopilotModelSummary(modelId = "gpt-5.2", name = "GPT-5.2"),
                CopilotModelSummary(modelId = "auto", name = "Auto"),
            ),
        )
        assertEquals(listOf(OptionItem("auto", "Auto"), OptionItem("gpt-5.2", "GPT-5.2")), options)
    }

    // ------------------------------------------------------------------ kimi --

    @Test
    fun `kimi labels make the provider recognizable`() {
        val options = FlavorModelOptions.kimiModelOptions(
            listOf(
                KimiModelSummary(modelId = "glm-5.3-flash", name = "GLM-5.3-flash", provider = "TheHive"),
                KimiModelSummary(modelId = "k2", name = null, provider = null),
            ),
        )
        assertEquals(
            listOf(
                OptionItem("auto", "Default"),
                OptionItem("glm-5.3-flash", "TheHive — GLM-5.3-flash"),
                OptionItem("k2", "k2"),
            ),
            options,
        )
    }

    // ------------------------------------------------------------------- pi --

    @Test
    fun `pi model values are provider-qualified with a Default row`() {
        val options = FlavorModelOptions.piModelOptions(
            listOf(
                PiModelSummary(provider = "anthropic", modelId = "claude", name = "Claude"),
                PiModelSummary(provider = "", modelId = "grok", name = null),
            ),
        )
        assertEquals(
            listOf(
                OptionItem("auto", "Default"),
                OptionItem("anthropic/claude", "Claude"),
                OptionItem("unknown/grok", "grok"),
            ),
            options,
        )
    }

    @Test
    fun `pi selection resolves by provider-qualified value then bare id`() {
        val models = listOf(
            PiModelSummary(provider = "anthropic", modelId = "claude"),
            PiModelSummary(provider = "openai", modelId = "claude"),
        )
        assertNull(FlavorModelOptions.resolvePiSelectedModel(models, "auto"))
        assertEquals(
            "openai",
            FlavorModelOptions.resolvePiSelectedModel(models, "openai/claude")?.provider,
        )
        // Bare legacy id: first catalog row wins.
        assertEquals(
            "anthropic",
            FlavorModelOptions.resolvePiSelectedModel(models, "claude")?.provider,
        )
        assertNull(FlavorModelOptions.resolvePiSelectedModel(models, "other/nope"))
    }

    @Test
    fun `pi thinking level support honors null mappings and explicit xhigh-max entries`() {
        val map = mapOf("low" to "low", "high" to null)
        assertTrue(FlavorModelOptions.isThinkingLevelSupported("low", map))
        assertFalse(FlavorModelOptions.isThinkingLevelSupported("high", map))
        // Unmapped standard levels default to supported; xhigh/max need an entry.
        assertTrue(FlavorModelOptions.isThinkingLevelSupported("medium", map))
        assertFalse(FlavorModelOptions.isThinkingLevelSupported("xhigh", map))
        assertFalse(FlavorModelOptions.isThinkingLevelSupported("max", map))
        assertFalse(FlavorModelOptions.isThinkingLevelSupported("xhigh", null))
        assertTrue(FlavorModelOptions.isThinkingLevelSupported("off", null))
        assertTrue(FlavorModelOptions.isThinkingLevelSupported("max", mapOf("max" to "max")))
    }

    @Test
    fun `pi thinking level options filter by the map and keep a non-standard current level`() {
        val options = FlavorModelOptions.piThinkingLevelOptions(
            currentLevel = "ultra",
            thinkingLevelMap = mapOf("ultra" to "ultra", "high" to null),
        )
        // Non-standard current first, then standard levels minus the null-mapped high.
        assertEquals("ultra", options.first().value)
        // Null-mapped high drops; xhigh/max stay out without explicit entries.
        assertEquals(listOf("ultra", "off", "minimal", "low", "medium"), options.map { it.value })

        // normalize: empty/default/auto mean "let Pi decide".
        assertNull(FlavorModelOptions.normalizePiThinkingLevel(null))
        assertNull(FlavorModelOptions.normalizePiThinkingLevel("auto"))
        assertNull(FlavorModelOptions.normalizePiThinkingLevel(" Default "))
        assertEquals("high", FlavorModelOptions.normalizePiThinkingLevel(" High "))
    }

    // -------------------------------------------------------------- opencode --

    @Test
    fun `opencode effort validity switches between static and dynamic variant lists`() {
        val static = FlavorModelOptions.OPENCODE_REASONING_EFFORTS
        // Static fallback keeps default+low..max but drops codex's xhigh.
        assertFalse(static.any { it.value == "xhigh" })
        assertTrue(FlavorModelOptions.isOpencodeReasoningEffortValid("default", null))
        assertTrue(FlavorModelOptions.isOpencodeReasoningEffortValid("max", null))
        assertFalse(FlavorModelOptions.isOpencodeReasoningEffortValid("bogus", null))
        // Dynamic list replaces the static set entirely (even emptier).
        assertFalse(FlavorModelOptions.isOpencodeReasoningEffortValid("high", listOf("low")))
        assertFalse(FlavorModelOptions.isOpencodeReasoningEffortValid("low", emptyList()))
        assertTrue(FlavorModelOptions.isOpencodeReasoningEffortValid("low", listOf("low")))
    }
}

/**
 * Cursor wire/sku parsing and the dual-vs-flat picker state — ports of
 * `shared/src/cursorCliSku.ts` and `web/src/lib/cursorPickerState.ts`.
 */
class CursorModelsTest {

    private fun model(id: String, name: String? = null) = OpencodeModelSummary(modelId = id, name = name)

    @Test
    fun `wire and sku id decomposition`() {
        assertTrue(CursorModels.isAcpWireModelId("composer-2.5[fast=true]"))
        assertTrue(CursorModels.isAcpWireModelId("default[]"))
        assertFalse(CursorModels.isAcpWireModelId("gpt-5.5-high"))
        assertEquals("composer-2.5", CursorModels.baseId("composer-2.5[fast=true]"))
        assertEquals("fast=true", CursorModels.variantId("composer-2.5[fast=true]"))
        assertEquals("(default)", CursorModels.variantLabel("composer-2.5[]"))
        assertEquals("gpt-5.5", CursorModels.cliSkuBaseId("gpt-5.5-extra-high-fast"))
        assertEquals("gpt-5.5", CursorModels.cliSkuBaseId("gpt-5.5-thinking"))
        assertTrue(CursorModels.isCliSkuVariantId("gpt-5.5-high"))
        assertFalse(CursorModels.isCliSkuVariantId("gpt-5.5"))
        // Spawn pinning: auto-ish ids normalize to `auto`, empty omits.
        assertEquals("auto", CursorModels.spawnModelId("default[]"))
        assertEquals("auto", CursorModels.spawnModelId("DEFAULT"))
        assertEquals("x[fast=true]", CursorModels.spawnModelId("x[fast=true]"))
        assertNull(CursorModels.spawnModelId("  "))
        // The legacy cursor- family prefix must not break base matching.
        assertTrue(CursorModels.baseMatches("cursor-composer", "composer"))
    }

    @Test
    fun `catalog groups wires by base, injects current and sorts bases`() {
        val catalog = CursorModels.buildCatalog(
            listOf(
                model("zeta-1[fast=true]"),
                model("zeta-1[smart=true]"),
                model("alpha-2"),
                model("auto"), // sentinel dropped
            ),
            currentModel = "unlisted-9[mode=x]", // catalog-eligible → injected
        )
        assertEquals(listOf("auto", "alpha-2", "unlisted-9", "zeta-1"), catalog.baseOptions.map { it.value })
        assertEquals(
            listOf("fast=true", "smart=true"),
            catalog.variantsByBase.getValue("zeta-1").map { it.label },
        )
        assertEquals("zeta-1", catalog.wireToBase.getValue("zeta-1[fast=true]"))
        assertTrue(CursorModels.hasMultiVariantBases(catalog))
    }

    @Test
    fun `cli skus attach under a matching base and hide raw wires`() {
        val catalog = CursorModels.buildCatalog(
            listOf(model("composer-2.5[fast=true]"), model("composer-2.5[smart=true]")),
        )
        val withSkus = CursorModels.appendCliSkus(
            catalog,
            listOf(
                model("composer-2.5-high-fast", name = "High & Fast"),
                model("cursor-composer-2.5-low", name = "Low"), // legacy prefix still matches
                model("orphan-9-high"), // unknown base dropped
            ),
        )
        val variants = withSkus.variantsByBase.getValue("composer-2.5")
        // Skus append after the raw ACP wires (they replace them in the
        // rendered variant list, so relative order there is what matters).
        assertEquals(
            listOf("composer-2.5[fast=true]", "composer-2.5[smart=true]", "composer-2.5-high-fast", "cursor-composer-2.5-low"),
            variants.map { it.wireId },
        )
        assertEquals(
            listOf("composer-2.5-high-fast", "cursor-composer-2.5-low"),
            CursorModels.resolveVariantOptions("composer-2.5", withSkus).map { it.wireId },
        )
    }

    @Test
    fun `base change resolves single-variant bases and defers multi-variant ones`() {
        val catalog = CursorModels.buildCatalog(
            listOf(model("single-1"), model("multi-1[a=1]"), model("multi-1[b=2]")),
        )
        assertEquals("auto", CursorModels.resolveWireIdForBaseChange("auto", catalog))
        assertEquals("single-1", CursorModels.resolveWireIdForBaseChange("single-1", catalog))
        assertNull(CursorModels.resolveWireIdForBaseChange("multi-1", catalog))
        assertEquals("multi-1", CursorModels.resolveBaseFromWire("multi-1[a=1]", catalog))
        assertEquals("auto", CursorModels.resolveBaseFromWire("auto", catalog))
    }

    @Test
    fun `dual picker state exposes base rows and variant placeholder semantics`() {
        val picker = CursorModels.buildNewSessionPickerState(
            machineModels = listOf(
                model("composer-2.5[fast=true]"),
                model("composer-2.5[smart=true]"),
            ),
            currentModel = "composer-2.5[smart=true]",
            cliSkus = listOf(model("composer-2.5-high"), model("composer-2.5-low")),
        )
        assertEquals(CursorModels.PickerMode.DUAL, picker.mode)
        assertEquals("composer-2.5", picker.baseKey)
        assertEquals(listOf("auto", "composer-2.5"), picker.modelOptions.map { it.value })
        // Skus replace the raw wires as the rendered variant rows.
        assertTrue(picker.showVariantPicker)
        assertEquals(listOf("composer-2.5-high", "composer-2.5-low"), picker.variantOptions.map { it.value })
        // A wire not among the current rows selects the placeholder.
        assertEquals(
            CursorModels.AUTO,
            CursorModels.variantSelectValue("composer-2.5[smart=true]", picker.variantOptions),
        )
        assertEquals("composer-2.5-high", CursorModels.variantSelectValue("composer-2.5-high", picker.variantOptions))
        // Variant clicks are valid for wires of the active base (skus and
        // raw wires both live under it in the catalog).
        assertTrue(CursorModels.isEffortWireAllowed("composer-2.5[fast=true]", picker.catalog, "composer-2.5"))
        assertTrue(CursorModels.isEffortWireAllowed("composer-2.5-low", picker.catalog, "composer-2.5"))
        assertFalse(CursorModels.isEffortWireAllowed("stranger[wire]", picker.catalog, "composer-2.5"))
        assertFalse(CursorModels.isEffortWireAllowed("composer-2.5[fast=true]", picker.catalog, null))
    }

    @Test
    fun `flat picker state lists one row per wire and hides the variant row`() {
        val picker = CursorModels.buildNewSessionPickerState(
            machineModels = listOf(model("alpha-2"), model("beta-1[x=1]")),
            currentModel = "auto",
            cliSkus = emptyList(),
        )
        assertEquals(CursorModels.PickerMode.FLAT, picker.mode)
        assertEquals(listOf("auto", "alpha-2", "beta-1[x=1]"), picker.modelOptions.map { it.value })
        assertFalse(picker.showVariantPicker)
        assertTrue(picker.variantOptions.isEmpty())
        // Effort/speed skus never surface as top-level rows; an empty catalog
        // yields only Auto (the "unavailable" hint case).
        val skusOnly = CursorModels.buildNewSessionPickerState(
            machineModels = listOf(model("gpt-5.5-high")),
            currentModel = "auto",
            cliSkus = emptyList(),
        )
        assertEquals(listOf("auto"), skusOnly.modelOptions.map { it.value })
        assertEquals(CursorModels.PickerMode.FLAT, skusOnly.mode)
    }

    @Test
    fun `new-session catalog judges the form selection without injecting current`() {
        val catalog = CursorModels.buildNewSessionCatalog(
            machineModels = listOf(model("alpha-2")),
            cliSkus = emptyList(),
        )
        // currentModel pinned at Auto: only explicit picker rows exist.
        assertEquals(listOf("auto", "alpha-2"), catalog.baseOptions.map { it.value })
    }

    // ------------------------------------------------- session-sheet merge (slice C) --

    @Test
    fun `session merge dedupes session-first, fills from machine and injects the current wire`() {
        val session = listOf(model("composer-2.5[fast=true]", "Session row"))
        val machine = listOf(
            model("composer-2.5[fast=true]", "Advertised"),
            model("composer-2.5[]"),
            model("gpt-5.5-high"), // CLI sku: never a catalog row.
        )
        val merged = CursorModels.mergeSessionModels(session, machine, currentWireId = "gpt-5.5[]")
        // Session row wins the duplicate (machine name dropped); machine fills;
        // the eligible current wire is injected last when unlisted.
        assertEquals(
            listOf(
                "composer-2.5[fast=true]" to "Session row",
                "composer-2.5[]" to null,
                "gpt-5.5[]" to null,
            ),
            merged.map { it.modelId to it.name },
        )
    }

    @Test
    fun `cli sku merge sorts longer sources first and keeps first occurrence per id`() {
        val short = listOf(model("a-1-high"), model("a-1"))
        val long = listOf(model("b-2-high"), model("a-1", "Named"), model("c-3"))
        val merged = CursorModels.mergeCliSkus(short, long)
        // The longer source iterates first (stable), first occurrence wins per id.
        assertEquals(
            listOf("b-2-high", "a-1" to "Named", "c-3", "a-1-high"),
            merged.map { if (it.modelId == "a-1") it.modelId to it.name else it.modelId },
        )
    }

    @Test
    fun `session picker hints the catalog with the live wire but selects the persisted model`() {
        val picker = CursorModels.buildSessionPickerState(
            sessionModels = listOf(model("composer-2.5[fast=true]")),
            machineModels = listOf(model("gpt-5.5[]"), model("gpt-5.5[thinking=true]")),
            cliSkus = emptyList(),
            sessionModel = null, // Hub never persisted a model override.
            sessionCurrentModelId = "gpt-5.5[thinking=true]",
        )
        // The machine's live wire joined the catalog via the hint…
        assertTrue(picker.catalog.wireToBase.containsKey("gpt-5.5[thinking=true]"))
        // …and renders selected (fallback selection = currentModelId).
        assertEquals("gpt-5.5[thinking=true]", picker.wireId)
        // A persisted session model wins the rendered selection.
        val persisted = CursorModels.buildSessionPickerState(
            sessionModels = listOf(model("composer-2.5[fast=true]")),
            machineModels = emptyList(),
            cliSkus = emptyList(),
            sessionModel = "composer-2.5[fast=true]",
            sessionCurrentModelId = "gpt-5.5[thinking=true]",
        )
        assertEquals("composer-2.5[fast=true]", persisted.wireId)
    }

    @Test
    fun `findBestCliSkuForAcpWire scores speed and effort hints and skips foreign bases`() {
        val skus = listOf("composer-2.5", "composer-2.5-high", "composer-2.5-high-fast")
        // Bare wire: every same-base sku ties at 0 → first advertise order wins.
        assertEquals("composer-2.5", CursorModels.findBestCliSkuForAcpWire("composer-2.5[]", skus))
        // fast=true: +2 for the fast sku, −1 conflicts elsewhere.
        assertEquals("composer-2.5-high-fast", CursorModels.findBestCliSkuForAcpWire("composer-2.5[fast=true]", skus))
        // effort hint: reasoning=high matches -high (absent elsewhere except -high-fast has no effort param → absent).
        assertEquals("composer-2.5-high", CursorModels.findBestCliSkuForAcpWire("composer-2.5[reasoning=high]", skus))
        // Foreign base never maps; an ACP-wire-shaped sku id is skipped.
        assertNull(CursorModels.findBestCliSkuForAcpWire("gpt-5.5[]", skus))
        assertNull(CursorModels.findBestCliSkuForAcpWire("composer-2.5[]", listOf("composer-2.5[x=1]")))
    }
}
