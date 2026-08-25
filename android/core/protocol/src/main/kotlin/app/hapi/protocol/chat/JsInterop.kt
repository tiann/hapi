package app.hapi.protocol.chat

import app.hapi.protocol.wire.stringOrNull
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

/**
 * JavaScript-semantics helpers for the chat pipeline port.
 *
 * The reference implementation (`web/src/chat/`) manipulates `unknown` wire
 * values with JS semantics. This file pins the exact conventions used by the
 * Kotlin transliteration:
 *
 * - TS `undefined` (absent key) maps to Kotlin `null`.
 * - TS `null` (explicit JSON null) maps to [JsonNull].
 * - TS `a ?? b` on wire values must treat BOTH as missing — use [orNull]
 *   before Kotlin's `?:`.
 * - TS truthiness (`if (value)`) is [jsTruthy]/[isNullOrEmpty] depending on
 *   the static type at the call site.
 */

/** Collapse JSON `null` into Kotlin `null` so `?:` mirrors TS `??`. */
internal fun JsonElement?.orNull(): JsonElement? = if (this == null || this is JsonNull) null else this

/** `shared/src/utils.ts` `isObject` (arrays never carry the string keys probed after it). */
internal fun asObject(value: JsonElement?): JsonObject? = value as? JsonObject

/** `shared/src/utils.ts` `asString` — JSON string or null (numbers are not strings). */
internal fun asString(value: JsonElement?): String? = value.stringOrNull

/** `shared/src/utils.ts` `asNumber` — finite JSON number or null (strings are not numbers). */
internal fun asNumber(value: JsonElement?): Double? {
    val primitive = value as? JsonPrimitive ?: return null
    if (primitive.isString || primitive is JsonNull) return null
    val parsed = primitive.content.toDoubleOrNull() ?: return null
    return if (parsed.isFinite()) parsed else null
}

/** JS `Boolean(value)` over a wire value. */
internal fun jsTruthy(value: JsonElement?): Boolean {
    if (value == null || value is JsonNull) return false
    if (value is JsonObject || value is JsonArray) return true
    val primitive = value as? JsonPrimitive ?: return false
    if (primitive.isString) return primitive.content.isNotEmpty()
    return when (primitive.content) {
        "true" -> true
        "false" -> false
        else -> primitive.content.toDoubleOrNull()?.let { it != 0.0 && !it.isNaN() } ?: true
    }
}

/**
 * `shared/src/utils.ts` `safeStringify`: strings pass through; everything else
 * is `JSON.stringify(value, null, 2)`. Hand-rolled to reproduce
 * `JSON.stringify` output byte-for-byte (2-space indent, `": "` after keys,
 * insertion-order keys, JS string escaping, JS number formatting).
 */
internal fun safeStringify(value: JsonElement?): String {
    if (value == null) return "undefined" // TS String(undefined); unreachable from wire JSON.
    if (value is JsonPrimitive && value.isString) return value.content
    val sb = StringBuilder()
    jsStringifyInto(sb, value, indent = 2, depth = 0)
    return sb.toString()
}

private fun jsStringifyInto(sb: StringBuilder, value: JsonElement, indent: Int, depth: Int) {
    when (value) {
        is JsonNull -> sb.append("null")
        is JsonPrimitive -> {
            if (value.isString) {
                appendJsQuoted(sb, value.content)
            } else {
                // Fixture inputs are JS-canonical already; normalize the lexeme
                // through the JS number formatter for exactness.
                val number = value.content.toDoubleOrNull()
                sb.append(if (number != null) formatJsNumber(number) else value.content)
            }
        }
        is JsonArray -> {
            if (value.isEmpty()) {
                sb.append("[]")
                return
            }
            sb.append("[")
            val childPad = " ".repeat(indent * (depth + 1))
            val closePad = " ".repeat(indent * depth)
            value.forEachIndexed { index, item ->
                if (index > 0) sb.append(",")
                sb.append("\n").append(childPad)
                jsStringifyInto(sb, item, indent, depth + 1)
            }
            sb.append("\n").append(closePad).append("]")
        }
        is JsonObject -> {
            if (value.isEmpty()) {
                sb.append("{}")
                return
            }
            sb.append("{")
            val childPad = " ".repeat(indent * (depth + 1))
            val closePad = " ".repeat(indent * depth)
            var first = true
            for ((key, item) in value) {
                if (!first) sb.append(",")
                first = false
                sb.append("\n").append(childPad)
                appendJsQuoted(sb, key)
                sb.append(": ")
                jsStringifyInto(sb, item, indent, depth + 1)
            }
            sb.append("\n").append(closePad).append("}")
        }
    }
}

/** JSON.stringify string escaping: `"`, `\`, control chars; everything else verbatim. */
internal fun appendJsQuoted(sb: StringBuilder, text: String) {
    sb.append('"')
    for (ch in text) {
        when (ch) {
            '"' -> sb.append("\\\"")
            '\\' -> sb.append("\\\\")
            '\b' -> sb.append("\\b")
            '\u000C' -> sb.append("\\f")
            '\n' -> sb.append("\\n")
            '\r' -> sb.append("\\r")
            '\t' -> sb.append("\\t")
            else -> if (ch < ' ') sb.append("\\u%04x".format(ch.code)) else sb.append(ch)
        }
    }
    sb.append('"')
}

private const val MAX_SAFE_INTEGER_DOUBLE = 9.007199254740991E15

/**
 * ECMAScript Number-to-string for the values that occur in this protocol:
 * integral doubles print without a fraction (`1`, not `1.0`), everything else
 * uses the shortest round-trip form Kotlin produces (matches JS for the
 * decimal fractions in play, e.g. `0.9`).
 */
internal fun formatJsNumber(value: Double): String {
    if (value == 0.0) return "0"
    if (value == Math.floor(value) && Math.abs(value) <= MAX_SAFE_INTEGER_DOUBLE) {
        return value.toLong().toString()
    }
    return value.toString()
}

/** A JSON number primitive rendered the way `JSON.stringify` would render [value]. */
internal fun jsNumber(value: Double): JsonPrimitive =
    if (value == Math.floor(value) && !value.isInfinite() && Math.abs(value) <= MAX_SAFE_INTEGER_DOUBLE) {
        JsonPrimitive(value.toLong())
    } else {
        JsonPrimitive(value)
    }

internal fun jsNumber(value: Long): JsonPrimitive = JsonPrimitive(value)
