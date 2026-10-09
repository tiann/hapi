package app.hapi.data.wear

/**
 * Phone <-> Wear Data Layer contract. Shared between `:app` (phone, the only
 * side with hub credentials) and `:wear` (watch, a thin display + action
 * relay) so path/key strings cannot drift between the two Gradle modules.
 *
 * All traffic — **both directions** — rides `DataClient.putDataItem`
 * (`onDataChanged` listeners), never `MessageClient`. Dogfood on real Wear OS
 * hardware found `MESSAGE_RECEIVED` silently undelivered on some device
 * pairs while `DataChanged` was reliable; this contract standardizes on the
 * transport that was actually proven to work.
 *
 * Every DataMap includes [KEY_TS] (`System.currentTimeMillis()`). GMS dedupes
 * a `putDataItem` call whose payload is byte-identical to the item already at
 * that path — a bare trigger (e.g. "refresh sessions") would never fire
 * `onDataChanged` on the second identical request without a strictly
 * increasing field to force a diff.
 */
object WearContract {

    // --- Phone -> Watch -------------------------------------------------

    /** One relayed push event (`PushPayload`'s wire fields), urgent. */
    const val PATH_NOTIFY = "/hapi/wear/notify"

    /** Response to [PATH_REQUEST_SESSIONS]: a slim, size-budgeted session list. */
    const val PATH_SESSIONS = "/hapi/wear/sessions"

    /** Response to [PATH_REQUEST_MESSAGES]: a slim, size-budgeted transcript. */
    const val PATH_MESSAGES = "/hapi/wear/messages"

    /** Outcome of a watch-initiated action (approve/deny/reply), best-effort. */
    const val PATH_ACTION_RESULT = "/hapi/wear/action-result"

    // --- Watch -> Phone -------------------------------------------------

    /** Request the current session list. No body beyond [KEY_TS]. */
    const val PATH_REQUEST_SESSIONS = "/hapi/wear/req/sessions"

    /** Request a transcript slice for [KEY_SESSION_ID]. */
    const val PATH_REQUEST_MESSAGES = "/hapi/wear/req/messages"

    /** Approve, deny, or reply — see [ACTION_APPROVE] / [ACTION_DENY] / [ACTION_REPLY]. */
    const val PATH_REQUEST_ACTION = "/hapi/wear/req/action"

    // --- DataMap keys ----------------------------------------------------

    const val KEY_TS = "ts"
    const val KEY_SESSION_ID = "sessionId"
    const val KEY_SESSION_NAME = "sessionName"
    /** `PushPayload.rawType` — echoed back on [PATH_REQUEST_ACTION] so the
     *  phone can reconstruct [app.hapi.data.push.PushPayload.notificationTag]
     *  (`"$rawType-$sessionId"`) and keep its own notification in sync with a
     *  watch-driven action, instead of leaving a stale Allow/Deny behind. */
    const val KEY_TYPE = "type"
    const val KEY_LIMIT = "limit"
    const val KEY_SESSIONS = "sessions"
    const val KEY_MESSAGES = "messages"
    const val KEY_ERROR = "error"
    const val KEY_TRUNCATED = "truncated"

    // Session row fields (one entry of KEY_SESSIONS, a DataMap array).
    const val KEY_ACTIVE = "active"
    const val KEY_THINKING = "thinking"
    const val KEY_UPDATED_AT = "updatedAt"
    const val KEY_PENDING_REQUEST_KINDS = "pendingRequestKinds"
    const val KEY_BACKGROUND_TASK_COUNT = "backgroundTaskCount"

    // Message row fields (one entry of KEY_MESSAGES, a DataMap array).
    const val KEY_ROLE = "role"
    const val KEY_TEXT = "text"
    const val KEY_CREATED_AT = "createdAt"

    // Action request/result fields.
    const val KEY_ACTION = "action"
    const val KEY_REQUEST_ID = "requestId"
    const val KEY_LOCAL_ID = "localId"
    const val KEY_OK = "ok"

    const val ACTION_APPROVE = "approve"
    const val ACTION_DENY = "deny"
    const val ACTION_REPLY = "reply"

    /**
     * Per-message-text cap when relaying a transcript. Wearable Data Layer
     * silently drops items over ~100 KB (no failure callback) — the hub's
     * own `limit` query param already bounds *how many* messages ride a
     * response (see `PhoneWearListenerService`'s SESSIONS_LIMIT/MESSAGES_LIMIT),
     * this bounds *how long* any single one is, since a tool-call/diff dump
     * can be enormous even inside a small page.
     */
    const val MAX_MESSAGE_TEXT_CHARS = 1_200
}
