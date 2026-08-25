package app.hapi.protocol.chat

import kotlinx.serialization.json.JsonElement

/** Port of `web/src/lib/toolInputUtils.ts`. */

fun getInputString(input: JsonElement?, key: String): String? =
    asObject(input)?.let { asString(it[key]) }

/** First TRUTHY string among [keys] (empty strings are skipped, like the TS `if (value)`). */
fun getInputStringAny(input: JsonElement?, keys: List<String>): String? {
    for (key in keys) {
        val value = getInputString(input, key)
        if (!value.isNullOrEmpty()) return value
    }
    return null
}

fun truncate(text: String, maxLen: Int): String {
    if (text.length <= maxLen) return text
    return text.substring(0, maxLen - 3) + "..."
}
