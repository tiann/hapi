package app.hapi.protocol.wire

import kotlinx.serialization.json.Json

/**
 * The shared [Json] configuration for every hub wire payload.
 *
 * - `ignoreUnknownKeys` — the hub evolves faster than shipped clients; unknown
 *   fields must never break decoding (mirrors zod's default key-stripping).
 * - `explicitNulls = false` — hub payloads use `nullish` fields liberally;
 *   absent and `null` both decode to Kotlin `null`, and locally-encoded JSON
 *   omits `null`s instead of writing them.
 * - `coerceInputValues` — JSON `null` on a non-nullable property with a
 *   default coerces to the default (e.g. legacy `activeAt: null` → `0`,
 *   matching the zod `.transform((v) => v ?? 0)`).
 *
 * Where absent-vs-explicit-`null` is semantically different on the wire
 * (queued messages' `invokedAt`, `SessionPatch` clear-fields), the models use
 * [OptionalField] with custom decoding instead of relying on this instance's
 * defaults.
 */
val HapiJson: Json = Json {
    ignoreUnknownKeys = true
    explicitNulls = false
    coerceInputValues = true
}
