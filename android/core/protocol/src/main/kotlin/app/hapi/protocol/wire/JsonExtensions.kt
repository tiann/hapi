package app.hapi.protocol.wire

import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

/**
 * Null-safe, non-throwing accessors over kotlinx.serialization [JsonElement] trees.
 *
 * Hub payloads contain loosely-typed regions (e.g. `agentState`, message `content`
 * envelopes) that are traversed defensively during normalization. These helpers
 * accept a nullable receiver so lookups chain without intermediate null checks:
 *
 * ```
 * val id = root.objOrNull?.get("session").objOrNull?.get("id").stringOrNull
 * ```
 *
 * Semantics are strict on purpose: a JSON string `"42"` is NOT an int, and a JSON
 * number is NOT a string (unlike kotlinx's lenient `JsonPrimitive.intOrNull`).
 * `JsonNull` and absent values both map to `null`.
 */

/** This element as a [JsonObject], or null. */
val JsonElement?.objOrNull: JsonObject?
    get() = this as? JsonObject

/** This element as a [JsonArray], or null. */
val JsonElement?.arrayOrNull: JsonArray?
    get() = this as? JsonArray

/** The value of a JSON string, or null (numbers/booleans/null are not strings). */
val JsonElement?.stringOrNull: String?
    get() = (this as? JsonPrimitive)?.takeIf { it.isString }?.content

/** The value of a JSON boolean, or null. */
val JsonElement?.boolOrNull: Boolean?
    get() = nonStringContent?.toBooleanStrictOrNull()

/** The value of a JSON number representable as [Int], or null. */
val JsonElement?.intOrNull: Int?
    get() = nonStringContent?.toIntOrNull()

/** The value of a JSON number representable as [Long], or null. */
val JsonElement?.longOrNull: Long?
    get() = nonStringContent?.toLongOrNull()

/** The value of a JSON number, or null. */
val JsonElement?.doubleOrNull: Double?
    get() = nonStringContent?.toDoubleOrNull()

private val JsonElement?.nonStringContent: String?
    get() = (this as? JsonPrimitive)?.takeUnless { it.isString }?.content
