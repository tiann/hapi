package app.hapi.protocol.chat

import kotlinx.serialization.json.JsonElement
import java.time.Instant
import java.time.LocalDate
import java.time.LocalDateTime
import java.time.OffsetDateTime
import java.time.ZoneId
import java.time.ZoneOffset

/**
 * Port of `web/src/chat/agentTimestamp.ts` — parses the ISO-8601 `timestamp`
 * the Claude CLI stamps on SDK log entries (execution-machine wall clock)
 * into epoch ms. Returns null for missing/non-string/unparseable values so
 * callers fall back to the hub-received `createdAt`.
 *
 * Mirrors ECMAScript `Date.parse` for the ISO forms that occur on the wire:
 * offset forms parse absolutely, date-only forms are UTC, and a date-time
 * without an offset is interpreted in local time (per spec).
 */
fun parseAgentTimestampMs(value: JsonElement?): Long? {
    val text = asString(value) ?: return null
    if (text.isBlank()) return null
    runCatching { return Instant.parse(text).toEpochMilli() }
    runCatching { return OffsetDateTime.parse(text).toInstant().toEpochMilli() }
    runCatching { return LocalDateTime.parse(text).atZone(ZoneId.systemDefault()).toInstant().toEpochMilli() }
    runCatching { return LocalDate.parse(text).atStartOfDay(ZoneOffset.UTC).toInstant().toEpochMilli() }
    return null
}
