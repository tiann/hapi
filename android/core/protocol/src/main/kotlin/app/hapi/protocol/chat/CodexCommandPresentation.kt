package app.hapi.protocol.chat

import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement

/** Port of `web/src/chat/codexCommandPresentation.ts` (grouping eligibility inputs). */

sealed class CodexCommandAction {
    abstract val command: String

    data class Read(override val command: String, val name: String, val path: String) : CodexCommandAction()
    data class ListFiles(override val command: String, val path: String?) : CodexCommandAction()
    data class Search(override val command: String, val query: String?, val path: String?) : CodexCommandAction()
    data class Unknown(override val command: String) : CodexCommandAction()
}

/** TS local `asString`: non-empty strings only. */
private fun nonEmptyString(value: JsonElement?): String? =
    asString(value)?.takeIf { it.isNotEmpty() }

private fun parseAction(value: JsonElement?): CodexCommandAction? {
    val action = asObject(value) ?: return null
    val type = nonEmptyString(action["type"]) ?: return null
    val command = nonEmptyString(action["command"]) ?: return null

    return when (type) {
        "read" -> {
            val name = nonEmptyString(action["name"])
            val path = nonEmptyString(action["path"])
            if (name != null && path != null) CodexCommandAction.Read(command, name, path) else null
        }
        "listFiles" -> CodexCommandAction.ListFiles(command, nonEmptyString(action["path"]))
        "search" -> CodexCommandAction.Search(command, nonEmptyString(action["query"]), nonEmptyString(action["path"]))
        "unknown" -> CodexCommandAction.Unknown(command)
        else -> null
    }
}

fun getCodexCommandActions(block: ToolCallBlock): List<CodexCommandAction> {
    if (block.tool.name != "CodexBash") return emptyList()
    val input = asObject(block.tool.input) ?: return emptyList()
    val raw = input["command_actions"].orNull() ?: input["commandActions"]
    val array = raw as? JsonArray ?: return emptyList()
    return array.mapNotNull(::parseAction)
}

fun isCodexExplorationTool(block: ToolCallBlock): Boolean {
    val input = asObject(block.tool.input)
    val source = nonEmptyString(input?.get("command_source").orNull() ?: input?.get("commandSource"))
    if (source?.lowercase() == "usershell") return false

    val actions = getCodexCommandActions(block)
    return actions.isNotEmpty() && actions.all {
        it is CodexCommandAction.Read || it is CodexCommandAction.ListFiles || it is CodexCommandAction.Search
    }
}
