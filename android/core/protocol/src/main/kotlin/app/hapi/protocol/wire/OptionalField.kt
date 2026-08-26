package app.hapi.protocol.wire

/**
 * Tri-state wire field: distinguishes an absent key from an explicit JSON
 * `null` (use `OptionalField<T?>` with `Present(null)`).
 *
 * JSON cannot be round-tripped through plain nullable Kotlin properties when
 * the contract gives `null` its own meaning:
 * - `DecryptedMessage.invokedAt` — explicit `null` = still queued; absent =
 *   already invoked (pre-V8 hub rows omit the field). See
 *   `docs/api/client-contract/pagination.md`.
 * - `SessionPatch.model/effort/...` — present `null` clears the field, absent
 *   leaves it untouched (TS `patch.model !== undefined`).
 */
sealed interface OptionalField<out T> {
    data object Absent : OptionalField<Nothing>
    data class Present<out T>(val value: T) : OptionalField<T>
}

val OptionalField<*>.isPresent: Boolean
    get() = this is OptionalField.Present

/** The present value, or null when absent (collapses the tri-state). */
fun <T> OptionalField<T?>.valueOrNull(): T? = (this as? OptionalField.Present)?.value
