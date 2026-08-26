package app.hapi.protocol.wire

/**
 * Wire-level message predicates shared by the window state machine and (later)
 * the chat pipeline. Ported from `web/src/lib/messages.ts`.
 */

/**
 * `true` when [DecryptedMessage.content] is a role-wrapped envelope with
 * `role: "user"` (web `isUserMessage`). Arrays and primitives have no `role`
 * key and are not user messages.
 */
val DecryptedMessage.isUserMessage: Boolean
    get() = content.objOrNull?.get("role").stringOrNull == "user"

/**
 * `true` when `invokedAt` is an **explicit** wire `null` — the strict-null
 * half of the queued predicate (`docs/api/client-contract/pagination.md`
 * "Queued semantics"). An absent field (pre-V8 hubs) means already-invoked
 * and returns `false`.
 */
val DecryptedMessage.hasExplicitNullInvokedAt: Boolean
    get() = invokedAt is OptionalField.Present && invokedAt.value == null
