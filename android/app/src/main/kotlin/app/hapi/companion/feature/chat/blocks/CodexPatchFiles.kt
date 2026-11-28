package app.hapi.companion.feature.chat.blocks

import app.hapi.protocol.chat.getInputString
import app.hapi.protocol.chat.getInputStringAny
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject

internal data class CodexPatchFile(val path: String, val diff: String?)

internal fun codexPatchFiles(input: JsonElement?): List<CodexPatchFile> {
    fun file(path: String, change: JsonElement): CodexPatchFile {
        val kind = getInputString((change as? JsonObject)?.get("kind"), "type") ?: getInputString(change, "type")
        val diff = if (kind == "update") getInputStringAny(change, listOf("unified_diff", "diff")) else null
        return CodexPatchFile(path, diff?.takeUnless { it.isBlank() })
    }
    return when (val changes = (input as? JsonObject)?.get("changes")) {
        is JsonObject -> changes.map { (path, change) -> file(path, change) }
        is JsonArray -> changes.mapNotNull { change -> getInputStringAny(change, listOf("path"))?.let { file(it, change) } }
        else -> emptyList()
    }
}
