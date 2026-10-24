package app.hapi.companion.feature.chat

import app.hapi.companion.feature.newsession.CursorModels
import app.hapi.protocol.wire.CodexModelSummary
import app.hapi.protocol.wire.GrokReasoningEffortOption
import app.hapi.protocol.wire.OpencodeModelSummary
import app.hapi.protocol.wire.OpencodeReasoningEffortOption
import app.hapi.protocol.wire.PiModelSummary
import app.hapi.protocol.wire.PiSelectedModelRef
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * Slice C decision table: flavor → session-config section visibility and row
 * values, hand-computed from the web truth (`codexFastMode.ts`,
 * `codexReasoningEffortOptions.ts`, the opencode/grok/pi RPC branches, and the
 * cursor variant rows of `sessionChatCursorModel.ts`).
 */
class SessionConfigSectionsTest {

    private fun codexModel(
        id: String,
        default: Boolean = false,
        efforts: List<String>? = null,
        tiers: List<String>? = null,
    ) = CodexModelSummary(
        id = id,
        displayName = id.replaceFirstChar { it.uppercaseChar() },
        isDefault = default,
        supportedReasoningEfforts = efforts,
        serviceTiers = tiers,
    )

    // ------------------------------------------------------- fast mode gate --

    @Test
    fun `fast mode requires a non-empty catalog and an advertising active model`() {
        val tiers = listOf("standard", "fast")
        // Empty/null catalog → false (section hidden until authoritative).
        assertFalse(SessionConfigSections.advertisesFastTier("gpt-5.3", null))
        assertFalse(SessionConfigSections.advertisesFastTier("gpt-5.3", emptyList()))
        // Exact (case-insensitive) id match against the session model.
        assertTrue(SessionConfigSections.advertisesFastTier(" GPT-5.3 ", listOf(codexModel("gpt-5.3", tiers = tiers))))
        // A set model with no catalog row has no authoritative answer (web
        // `findActiveModel` does not fall back to the default row).
        assertFalse(SessionConfigSections.advertisesFastTier("other", listOf(codexModel("gpt-5.3", default = true, tiers = tiers))))
        // Blank/auto session model → the default row decides. Note the
        // advertised-tier check is `/fast/i` containment — `priority` only
        // counts as a persisted tier VALUE (see isFastServiceTier above).
        assertFalse(SessionConfigSections.advertisesFastTier(null, listOf(codexModel("gpt-5.3-mini", default = true, tiers = listOf("priority")))))
        assertTrue(SessionConfigSections.advertisesFastTier(null, listOf(codexModel("gpt-5.3", default = true, tiers = listOf("FASTRACK")))))
        assertFalse(SessionConfigSections.advertisesFastTier(null, listOf(codexModel("gpt-5.3", default = true, tiers = listOf("standard")))))
    }

    @Test
    fun `isFastServiceTier accepts fast and priority in any case and displayed maps to standard`() {
        assertTrue(SessionConfigSections.isFastServiceTier("fast"))
        assertTrue(SessionConfigSections.isFastServiceTier("Priority"))
        assertFalse(SessionConfigSections.isFastServiceTier("standard"))
        assertFalse(SessionConfigSections.isFastServiceTier(null))
        assertFalse(SessionConfigSections.isFastServiceTier("faster"))
        // A persisted null (no override) still renders as the standard row.
        assertEquals("standard", SessionConfigSections.displayedServiceTier(null))
        assertEquals("fast", SessionConfigSections.displayedServiceTier("priority"))
        assertEquals("standard", SessionConfigSections.displayedServiceTier("standard"))
    }

    // -------------------------------------------------- codex reasoning effort --

    @Test
    fun `codex efforts come from the active model row with normalization`() {
        val models = listOf(
            codexModel("gpt-5.3-mini", default = true, efforts = listOf("low")),
            codexModel("gpt-5.3", efforts = listOf(" High ", "", "high", "XHIGH")),
        )
        // Selection row wins over the default row; trim/lowercase/dedupe.
        assertEquals(listOf("high", "xhigh"), SessionConfigSections.codexModelReasoningEfforts(models, "gpt-5.3"))
        // No selection → default row.
        assertEquals(listOf("low"), SessionConfigSections.codexModelReasoningEfforts(models, null))
        // Unknown selection row without efforts → null (falls to presets).
        assertNull(SessionConfigSections.codexModelReasoningEfforts(models, "unknown"))
        // Empty catalog → null.
        assertNull(SessionConfigSections.codexModelReasoningEfforts(emptyList(), "gpt-5.3"))
    }

    @Test
    fun `codex options use dynamic values and inject an out-of-list current`() {
        // Dynamic path: Default first, then the dynamic rows in order.
        val dynamic = SessionConfigSections.codexReasoningEffortOptions("high", listOf("low", "high"))
        assertEquals(
            listOf(null to "Default", "low" to "Low", "high" to "High"),
            dynamic.map { it.value to it.label },
        )
        // Current outside the dynamic list is injected right after Default.
        val injected = SessionConfigSections.codexReasoningEffortOptions("max", listOf("low"))
        assertEquals(
            listOf(null to "Default", "max" to "Max", "low" to "Low"),
            injected.map { it.value to it.label },
        )
        // No dynamic efforts → static presets (current "default"/blank normalizes to Default row).
        val presets = SessionConfigSections.codexReasoningEffortOptions(" default ", null)
        assertEquals(
            listOf(null to "Default", "low" to "Low", "medium" to "Medium", "high" to "High", "xhigh" to "XHigh"),
            presets.map { it.value to it.label },
        )
        // Out-of-list current is injected before the presets too.
        val presetInjected = SessionConfigSections.codexReasoningEffortOptions("ultra", emptyList())
        assertEquals("ultra", presetInjected[1].value)
        assertEquals("Ultra", presetInjected[1].label)
    }

    // ------------------------------------------------- opencode / grok rows --

    @Test
    fun `opencode rows hide on empty rpc list and prefer provider names`() {
        assertNull(SessionConfigSections.opencodeReasoningEffortOptions("high", null))
        assertNull(SessionConfigSections.opencodeReasoningEffortOptions("high", emptyList()))
        val rows = SessionConfigSections.opencodeReasoningEffortOptions(
            "high",
            listOf(
                OpencodeReasoningEffortOption("low", "Low effort"),
                OpencodeReasoningEffortOption("high"),
            ),
        )!!
        assertEquals(
            listOf(null to "Default", "low" to "Low effort", "high" to "High"),
            rows.map { it.value to it.label },
        )
    }

    @Test
    fun `grok rows are default-first without current injection`() {
        assertNull(SessionConfigSections.grokReasoningEffortOptions(null))
        assertNull(SessionConfigSections.grokReasoningEffortOptions(emptyList()))
        val rows = SessionConfigSections.grokReasoningEffortOptions(
            listOf(GrokReasoningEffortOption("high"), GrokReasoningEffortOption("ask", "Ask first")),
        )!!
        // An unknown current is NOT injected (renders unselected on the web).
        assertEquals(
            listOf(null to "Default", "high" to "high", "ask" to "Ask first"),
            rows.map { it.value to it.label },
        )
    }

    // ------------------------------------------------------------ pi rows --

    @Test
    fun `pi selection prefers the provider-qualified ref over the bare model id`() {
        val models = listOf(
            PiModelSummary(provider = "pi", modelId = "0.5-pro", reasoning = true, thinkingLevelMap = mapOf("high" to null)),
            PiModelSummary(provider = "other", modelId = "0.5-pro", reasoning = true),
        )
        // Bare id alone is ambiguous → first row.
        assertEquals("pi", SessionConfigSections.piSelectedModel(models, "0.5-pro", null)?.provider)
        // The metadata ref disambiguates.
        assertEquals(
            "other",
            SessionConfigSections.piSelectedModel(models, "0.5-pro", PiSelectedModelRef("other", "0.5-pro"))?.provider,
        )
        // Unresolved ref → null row → section hidden.
        assertNull(SessionConfigSections.piSelectedModel(models, "0.5-pro", PiSelectedModelRef("gone", "x")))
    }

    @Test
    fun `pi thinking rows hide on unresolved or non-reasoning models`() {
        // xhigh mapped to null = unsupported; max needs an explicit entry.
        val reasoning = PiModelSummary(
            provider = "pi",
            modelId = "0.5-pro",
            reasoning = true,
            thinkingLevelMap = mapOf("xhigh" to null),
        )
        assertNull(SessionConfigSections.piThinkingOptions("high", null))
        assertNull(SessionConfigSections.piThinkingOptions("high", PiModelSummary(provider = "pi", modelId = "0.5-flash", reasoning = false)))
        val rows = SessionConfigSections.piThinkingOptions("high", reasoning)!!
        assertEquals(
            listOf("off" to "Off", "minimal" to "Minimal", "low" to "Low", "medium" to "Medium", "high" to "High"),
            rows.map { it.value to it.label },
        )
    }

    // -------------------------------------------------------- cursor variant --

    private fun sessionPicker(
        sessionModel: String?,
        currentModelId: String?,
        sessionModels: List<OpencodeModelSummary> = listOf(
            OpencodeModelSummary("composer-2.5[fast=true]"),
            OpencodeModelSummary("composer-2.5[]"),
        ),
        machineSkus: List<OpencodeModelSummary> = listOf(
            OpencodeModelSummary("composer-2.5"),
            OpencodeModelSummary("composer-2.5-high"),
            OpencodeModelSummary("composer-2.5-high-fast"),
        ),
    ) = CursorModels.buildSessionPickerState(
        sessionModels = sessionModels,
        machineModels = emptyList(),
        cliSkus = machineSkus,
        sessionModel = sessionModel,
        sessionCurrentModelId = currentModelId,
    )

    @Test
    fun `cursor variant rows pin the default sku first when skus replace wires`() {
        val options = SessionConfigSections.cursorVariantOptions(sessionPicker("composer-2.5[fast=true]", null))!!
        // The catalog default is the first advertised ACP wire (`[fast=true]`);
        // skus replace the raw wires, so the default re-pins as its best sku —
        // ahead of the sku advertise order (`composer-2.5` was first).
        assertEquals(
            listOf("composer-2.5-high-fast", "composer-2.5", "composer-2.5-high"),
            options.map { it.value },
        )
        // Flat label: sku rows carry no name → the id is the label.
        assertEquals("composer-2.5-high-fast", options.first().label)
    }

    @Test
    fun `cursor variant rows keep raw wire order when no skus attach`() {
        // Without CLI skus the ACP wires themselves are the rows, default first.
        val options = SessionConfigSections.cursorVariantOptions(
            sessionPicker(
                sessionModel = "composer-2.5[fast=true]",
                currentModelId = null,
                machineSkus = emptyList(),
            ),
        )!!
        assertEquals(
            listOf("composer-2.5[fast=true]", "composer-2.5[]"),
            options.map { it.value },
        )
        assertEquals("fast=true", options.first().label)
        assertEquals("(default)", options[1].label)
    }

    @Test
    fun `cursor variant rows hide without a multi-variant base`() {
        assertNull(
            SessionConfigSections.cursorVariantOptions(
                sessionPicker(
                    sessionModel = "solo-1[]",
                    currentModelId = null,
                    sessionModels = listOf(OpencodeModelSummary("solo-1[]")),
                    machineSkus = emptyList(),
                ),
            ),
        )
        assertNull(SessionConfigSections.cursorVariantOptions(null))
    }

    @Test
    fun `cursor variant highlight matches exact skus and best sku for a stored ACP wire`() {
        val options = SessionConfigSections.cursorVariantOptions(sessionPicker("composer-2.5[fast=true]", null))!!
        // Exact sku id wins.
        assertEquals("composer-2.5-high", SessionConfigSections.cursorVariantSelected("composer-2.5-high", options))
        // Hub-persisted ACP wire → best-scoring sku (fast=true matches -fast).
        assertEquals("composer-2.5-high-fast", SessionConfigSections.cursorVariantSelected("composer-2.5[fast=true]", options))
        // Unknown, non-wire value → unselected.
        assertNull(SessionConfigSections.cursorVariantSelected("gpt-9", options))
        assertNull(SessionConfigSections.cursorVariantSelected(null, options))
    }
}
