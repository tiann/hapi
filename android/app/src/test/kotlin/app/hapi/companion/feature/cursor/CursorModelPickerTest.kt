package app.hapi.companion.feature.cursor

import app.hapi.protocol.wire.CursorModelSummary
import app.hapi.protocol.wire.CursorModelsResponse
import app.hapi.protocol.wire.HapiJson
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

class CursorModelPickerTest {
    private fun catalog(vararg ids: String) = CursorModelsResponse(true, ids.map { CursorModelSummary(it) })

    @Test fun changingOneAxisPreservesTheOthers() {
        val standard = "grok-4.7[context=256k,reasoning_effort=high,fast=false]"
        val fast = standard.replace("false", "true")
        val low = standard.replace("high", "low")
        val rows = catalog(standard, fast, low, low.replace("false", "true"))
        val picker = CursorModelPicker(rows, fast)
        assertEquals(listOf("auto", fast), picker.models.map { it.value })
        assertEquals(listOf(standard, fast), picker.fields.getValue("fast").map { it.value })
        assertEquals(listOf(fast, low.replace("false", "true")), picker.fields.getValue("reasoning_effort").map { it.value })
    }

    @Test fun connectedSparseCatalogKeepsAvailableIndependentChoices() {
        val low = "model[effort=low,fast=false]"
        val high = "model[effort=high,fast=false]"
        val fast = "model[effort=high,fast=true]"
        val catalog = catalog(low, high, fast)
        assertEquals(listOf(low), CursorModelPicker(catalog, low).fields.getValue("fast").map { it.value })
        assertEquals(listOf(high, fast), CursorModelPicker(catalog, high).fields.getValue("fast").map { it.value })
    }

    @Test fun coupledCatalogExposesActualCombinations() {
        val a = "model[effort=low,fast=false]"
        val b = "model[effort=high,fast=true]"
        assertEquals(listOf(a, b), CursorModelPicker(catalog(a, b), a).fields.getValue("variant").map { it.value })
    }

    @Test fun selectedCliAliasUsesTheAdvertisedFamilyAndPreservesOtherAxes() {
        for ((wireBase, skuBase) in listOf("grok-4.5" to "cursor-grok-4.5", "cursor-grok-4.5" to "grok-4.5")) {
            val standard = "$wireBase[reasoning_effort=high,fast=false]"
            val fast = standard.replace("false", "true")
            val selected = "$skuBase-high"
            val catalog = catalog(standard, fast).copy(cliModelSkus = listOf(CursorModelSummary(selected)))
            val picker = CursorModelPicker(catalog, selected)
            assertEquals(listOf("auto", selected), picker.models.map { it.value })
            assertEquals(wireBase, picker.models.last().label)
            assertEquals(listOf(selected, fast), picker.fields.getValue("fast").map { it.value })
        }
    }

    @Test fun exactFamilyOwnsTheSkuWhenBothBaseSpellingsAreAdvertised() {
        val first = "grok-4.5[reasoning_effort=high,fast=false]"
        val second = "cursor-$first"
        val selected = "cursor-grok-4.5-high"
        val catalog = catalog(first, second).copy(cliModelSkus = listOf(CursorModelSummary(selected)))
        val picker = CursorModelPicker(catalog, selected)
        assertEquals(listOf("auto", selected, first), picker.models.map { it.value })
    }

    @Test fun parameterizedBareBaseExposesOnlyAdvertisedSkuVariants() {
        val bare = "grok-4.5"
        val high = "cursor-grok-4.5-high"
        val fast = "$high-fast"
        val response = HapiJson.decodeFromString<CursorModelsResponse>(
            """{"success":true,"parameterized":true,"availableModels":[{"modelId":"$bare"}],
               "cliModelSkus":[{"modelId":"$high"},{"modelId":"$fast"}]}""",
        )
        assertTrue(CursorModelPicker.contains(response, fast))
        assertFalse(CursorModelPicker.contains(response, "cursor-grok-4.5-low"))
        val picker = CursorModelPicker(response, high)
        assertEquals(listOf("auto", high), picker.models.map { it.value })
        assertEquals(listOf(high, fast), picker.fields.getValue("fast").map { it.value })
    }

    @Test fun bareOnlyRunnerAndExplicitAccountDefault() {
        val response = catalog("model", "default[]").copy(cliModelSkus = listOf(CursorModelSummary("model-high")))
        assertFalse(CursorModelPicker.contains(response, "model-high"))
        assertFalse(CursorModelPicker.contains(response.copy(parameterized = false), "model-high"))
        val rows = CursorModelPicker(response, "default[]")
        assertEquals(listOf("auto", "default[]", "model"), rows.models.map { it.value })
    }
}
