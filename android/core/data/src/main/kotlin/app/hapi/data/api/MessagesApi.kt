package app.hapi.data.api

import app.hapi.protocol.wire.MessagesResponse
import app.hapi.protocol.wire.QueuedStateResponse

/**
 * One `GET /api/sessions/:id/messages` request. The three variants are the
 * only shapes the reference client ever issues
 * (`docs/api/client-contract/pagination.md`): the store cannot produce an
 * invalid parameter combination by construction, and the pagination fixture
 * harness asserts these against the recorded `expectedRequests` — `After`
 * always carries the `until` keys (explicitly null on the first catch-up
 * request), the other variants never do.
 */
sealed interface MessagesQuery {
    val limit: Int

    /** Newest page, no cursor. */
    data class Latest(override val limit: Int) : MessagesQuery

    /** Rows strictly older than the compound cursor. */
    data class Before(
        val beforeAt: Long,
        val beforeSeq: Long,
        override val limit: Int,
    ) : MessagesQuery

    /** Tail catch-up: rows strictly newer than the cursor, snapshot-bounded. */
    data class After(
        val afterAt: Long,
        val afterSeq: Long,
        val untilAt: Long?,
        val untilSeq: Long?,
        val epoch: Long,
        override val limit: Int,
    ) : MessagesQuery
}

/**
 * Minimal seam over the two message endpoints the window store drives —
 * implemented by [HapiApi] in production and by a scripted fake in the
 * pagination fixture harness. Extracted (instead of depending on the concrete
 * [HapiApi]) so the REAL orchestration is what the fixtures replay.
 */
interface MessagesApi {
    /** `GET /api/sessions/:id/messages`. */
    suspend fun getMessages(sessionId: String, query: MessagesQuery): MessagesResponse

    /** `POST /api/sessions/:id/messages/queued-state`. */
    suspend fun getQueuedState(sessionId: String, localIds: List<String>): QueuedStateResponse
}
