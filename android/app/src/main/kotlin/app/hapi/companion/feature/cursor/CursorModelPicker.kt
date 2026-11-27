package app.hapi.companion.feature.cursor

import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.res.stringResource
import app.hapi.companion.R
import app.hapi.companion.feature.newsession.OptionDropdown
import app.hapi.companion.feature.newsession.OptionItem
import app.hapi.protocol.wire.CursorModelsResponse

/** The value of every option is an actual runner ID, including when several parameters travel together. */
internal class CursorModelPicker(catalog: CursorModelsResponse, val selected: String) {
    private data class Variant(val id: String, val base: String, val params: Map<String, String>)
    private val groups: Map<String, List<Variant>>
    val models: List<OptionItem>
    val fields: Map<String, List<OptionItem>>

    init {
        val acp = catalog.availableModels.orEmpty().map { parse(it.modelId) }.filter { it.base !in defaults }
        val skus = catalog.cliModelSkus.orEmpty().map { parse(it.modelId) }
        groups = acp.groupBy { it.base }.mapValues { (base, wires) ->
            // Bare-only catalogs cannot reliably apply CLI SKU suffixes.
            val offers = if (wires.any { '[' in it.id }) skus.filter { it.base.removePrefix("cursor-") == base.removePrefix("cursor-") } else emptyList()
            // Keep ACP combinations, then add only SKU choices not already
            // represented by a wire. Preserve the exact selected ID on readback.
            val choices = wires.distinctBy { it.id }.toMutableList()
            for (sku in offers.distinctBy { it.id }) {
                val index = wires.indices.singleOrNull { i ->
                    val row = wires[i]
                    sku.params.all { (key, value) ->
                        val advertised = if (key == "reasoning") row.params["reasoning"]
                            ?: row.params["reasoning_effort"] ?: row.params["effort"] else row.params[key]
                        advertised == value
                    }
                }
                val wireIndex = index?.let { i -> choices.indexOfFirst { it.id == wires[i].id } } ?: -1
                if (wireIndex < 0) {
                    if (choices.none { it.id == sku.id }) choices.add(sku)
                } else if (sku.id == selected) {
                    choices[wireIndex] = sku.copy(params = choices[wireIndex].params)
                }
            }
            choices
        }
        val rows = groups[parse(selected).base].orEmpty()
        val picked = rows.find { it.id == selected }
        val options = groups.toSortedMap().map { (base, variants) ->
            OptionItem(variants.firstOrNull { it.id == selected }?.id ?: variants.first().id, base)
        }
        models = buildList {
            add(OptionItem("auto", "Auto"))
            if (selected != "auto" && picked == null) add(OptionItem(selected, selected))
            addAll(options)
        }
        fields = if (rows.size > 1 && picked != null) parameters(rows, picked) else emptyMap()
    }

    private fun parameters(rows: List<Variant>, picked: Variant): Map<String, List<OptionItem>> {
        val variants = mapOf("variant" to rows.map { OptionItem(it.id, it.id) })
        val keys = rows.flatMap { it.params.keys }.distinct().filter { key ->
            rows.map { it.params[key] }.distinct().size > 1
        }
        if (keys.isEmpty() || keys.any { it !in axes } || rows.distinctBy { it.params }.size != rows.size) return variants
        // With a sparse catalog, controls can stay independent when a path
        // exists between every advertised row using one-axis changes only.
        val reached = mutableSetOf(picked)
        val pending = ArrayDeque(listOf(picked))
        while (pending.isNotEmpty()) {
            val current = pending.removeFirst()
            for (candidate in rows) {
                if (candidate !in reached && keys.count { current.params[it] != candidate.params[it] } == 1) {
                    reached.add(candidate)
                    pending.addLast(candidate)
                }
            }
        }
        if (reached.size != rows.size) return variants
        return keys.associateWith { key ->
            rows.filter { row -> keys.all { it == key || row.params[it] == picked.params[it] } }.map { target ->
                val value = target.params[key]
                OptionItem(target.id, value ?: "default")
            }
        }
    }

    companion object {
        private val defaults = setOf("", "auto", "default")
        private val axes = setOf("reasoning", "reasoning_effort", "effort", "thinking", "context", "fast")
        private val suffix = Regex("-(extra-high|xhigh|high|medium|low|none|thinking|fast)$")

        private fun parse(id: String): Variant {
            if ('[' in id && id.endsWith(']')) {
                val pairs = id.substringAfter('[').dropLast(1).split(',').filter { it.isNotBlank() }.associate {
                    it.substringBefore('=').trim() to it.substringAfter('=', "true").trim()
                }
                return Variant(id, id.substringBefore('['), pairs)
            }
            var base = id
            val params = mutableMapOf("fast" to "false")
            while (true) {
                val tail = suffix.find(base) ?: break
                val value = tail.groupValues[1]
                if (value == "thinking" || value == "fast") params[value] = "true" else params["reasoning"] = value
                base = base.removeRange(tail.range)
            }
            return Variant(id, base, params)
        }

        fun contains(catalog: CursorModelsResponse, model: String): Boolean =
            model == "auto" || CursorModelPicker(catalog, model).groups.values.any { rows -> rows.any { it.id == model } }
    }
}

@Composable
internal fun CursorModelControls(
    catalog: CursorModelsResponse,
    selected: String,
    enabled: Boolean,
    onSelect: (String) -> Unit,
) {
    val picker = remember(catalog, selected) { CursorModelPicker(catalog, selected) }
    val choose = { id: String -> if (id != selected) onSelect(id) }
    OptionDropdown(stringResource(R.string.new_session_model), picker.models, selected, enabled, choose)
    for ((axis, options) in picker.fields) {
        val label = when (axis) {
            "reasoning", "reasoning_effort" -> R.string.new_session_reasoning_effort
            "effort" -> R.string.chat_config_effort
            "fast" -> R.string.new_session_fast_mode
            "thinking" -> R.string.cursor_thinking
            "context" -> R.string.cursor_context_window
            else -> R.string.cursor_model_variant
        }
        val localized = options.map {
            val value = when {
                axis == "fast" && it.label == "true" -> stringResource(R.string.new_session_fast_mode_fast)
                axis == "fast" && it.label == "false" -> stringResource(R.string.new_session_fast_mode_standard)
                else -> it.label
            }
            it.copy(label = value)
        }
        OptionDropdown(stringResource(label), localized, selected, enabled && localized.size > 1, choose)
    }
}
