package app.hapi.protocol.chat

import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

/**
 * Canonical JSON for golden-fixture comparison (`shared/fixtures/README.md`
 * "Acceptance bar"): recursively sorted object keys, numbers normalized to
 * their JS lexeme (integral doubles print without a fraction). Two values are
 * projection-equal iff their canonicalized trees are equal.
 */

fun canonicalizeJson(value: JsonElement): JsonElement = when (value) {
    is JsonNull -> value
    is JsonPrimitive -> {
        if (value.isString) {
            value
        } else {
            when (value.content) {
                "true", "false" -> value
                else -> value.content.toDoubleOrNull()?.let(::jsNumber) ?: value
            }
        }
    }
    is JsonArray -> JsonArray(value.map(::canonicalizeJson))
    is JsonObject -> JsonObject(value.entries.sortedBy { it.key }.associate { it.key to canonicalizeJson(it.value) })
}

/** Canonical text form (sorted keys, 4-space indent) — used for diff excerpts. */
fun toCanonicalJsonString(value: JsonElement): String {
    val sb = StringBuilder()
    appendCanonical(sb, canonicalizeJson(value), depth = 0)
    return sb.toString()
}

private fun appendCanonical(sb: StringBuilder, value: JsonElement, depth: Int) {
    when (value) {
        is JsonNull -> sb.append("null")
        is JsonPrimitive -> if (value.isString) appendJsQuoted(sb, value.content) else sb.append(value.content)
        is JsonArray -> {
            if (value.isEmpty()) {
                sb.append("[]")
                return
            }
            sb.append("[")
            value.forEachIndexed { index, item ->
                if (index > 0) sb.append(",")
                sb.append("\n").append("    ".repeat(depth + 1))
                appendCanonical(sb, item, depth + 1)
            }
            sb.append("\n").append("    ".repeat(depth)).append("]")
        }
        is JsonObject -> {
            if (value.isEmpty()) {
                sb.append("{}")
                return
            }
            sb.append("{")
            var first = true
            for ((key, item) in value) {
                if (!first) sb.append(",")
                first = false
                sb.append("\n").append("    ".repeat(depth + 1))
                appendJsQuoted(sb, key)
                sb.append(": ")
                appendCanonical(sb, item, depth + 1)
            }
            sb.append("\n").append("    ".repeat(depth)).append("}")
        }
    }
}
