package app.hapi.companion.feature.cursor

import app.hapi.protocol.wire.CursorModelSummary
import app.hapi.protocol.wire.CursorModelsResponse
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse

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

    @Test fun bareOnlyRunnerAndExplicitAccountDefault() {
        val response = catalog("model", "default[]").copy(cliModelSkus = listOf(CursorModelSummary("model-high")))
        assertFalse(CursorModelPicker.contains(response, "model-high"))
        val rows = CursorModelPicker(response, "default[]")
        assertEquals(listOf("auto", "default[]", "model"), rows.models.map { it.value })
    }
}
