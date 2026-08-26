package app.hapi.data.store

import app.hapi.data.api.MessagesApi
import app.hapi.data.api.MessagesQuery
import app.hapi.protocol.window.MessageStatus
import app.hapi.protocol.window.MessageViewMode
import app.hapi.protocol.window.MessageWindowState
import app.hapi.protocol.window.OlderLoadOutcome
import app.hapi.protocol.window.WindowMessage
import app.hapi.protocol.wire.HapiJson
import app.hapi.protocol.wire.MessagesResponse
import app.hapi.protocol.wire.OptionalField
import app.hapi.protocol.wire.QueuedStateResponse
import app.hapi.protocol.wire.longOrNull
import app.hapi.protocol.wire.stringOrNull
import java.io.File
import kotlin.test.assertEquals
import kotlin.test.assertNull
import kotlin.test.assertTrue
import kotlin.test.fail
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.builtins.ListSerializer
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.put
import org.junit.Test
import org.junit.runner.RunWith
import org.junit.runners.Parameterized

/**
 * Pagination conformance suite: replays every op script in
 * `shared/fixtures/pagination/` against the REAL [MessageWindowStore]
 * (driven by a scripted [MessagesApi]) and requires
 *
 *  - the exact same `GET /messages` requests, in order (`expectedRequests`),
 *  - the same older-load outcomes (`expectedOutcome`) and queued-state
 *    reconcile candidates (`expectedCandidates`),
 *  - the exact final window projection (`expectedState`).
 *
 * The twin of `web/src/lib/message-window-store.fixtures.test.ts` /
 * `web/scripts/fixtures/pagination/runner.ts`. A failure here means this port
 * drifted from the web reference (or the fixtures were regenerated after a
 * web behavior change and the port must catch up).
 *
 * Determinism: ops run strictly sequentially; the store's scope uses
 * [Dispatchers.Unconfined], so internal tail-sync jobs run to completion
 * within each op (the scripted api never suspends) — mirroring the web
 * harness awaiting every op.
 */
@RunWith(Parameterized::class)
class PaginationFixtureTest(private val fixtureName: String) {

    companion object {
        private val fixturesDir: File by lazy {
            val path = checkNotNull(System.getProperty("hapi.fixtures.dir")) {
                "hapi.fixtures.dir system property not set (see core/data/build.gradle.kts)"
            }
            File(path).also {
                check(it.isDirectory) { "fixtures dir does not exist: $it" }
            }
        }

        @JvmStatic
        @Parameterized.Parameters(name = "{0}")
        fun fixtures(): List<String> {
            val files = File(fixturesDir, "pagination")
                .listFiles { file -> file.name.endsWith(".json") }
                ?.map { it.name }
                ?.sorted()
                .orEmpty()
            check(files.isNotEmpty()) {
                "no pagination fixtures found under $fixturesDir/pagination — refusing to pass on zero files"
            }
            return files
        }
    }

    @Test
    fun `replaying the ops against the real store matches the stored expectations`() {
        val document = HapiJson.parseToJsonElement(
            File(File(fixturesDir, "pagination"), fixtureName).readText()
        ).jsonObject

        val version = File(fixturesDir, "VERSION").readText().trim().toInt()
        assertEquals(version, document.getValue("fixtureVersion").longOrNull?.toInt(), "fixtureVersion")
        assertEquals(fixtureName, "${document.getValue("name").stringOrNull}.json", "name matches file")

        val scripted = ScriptedMessagesApi()
        val store = MessageWindowStore(
            sessionId = "fixture-pagination-${document.getValue("name").stringOrNull}",
            api = scripted,
            scope = CoroutineScope(SupervisorJob() + Dispatchers.Unconfined),
        )

        runBlocking {
            for ((opIndex, opElement) in document.getValue("ops").jsonArray.withIndex()) {
                executeOp(store, scripted, opElement.jsonObject, opIndex)
            }
        }

        assertEquals(
            document.getValue("expectedState"),
            projectWindowState(store.state.value),
            "final window projection ($fixtureName)",
        )
    }

    // ------------------------------------------------------------ op replay --

    private suspend fun executeOp(
        store: MessageWindowStore,
        scripted: ScriptedMessagesApi,
        op: JsonObject,
        opIndex: Int,
    ) {
        val kind = op.getValue("op").stringOrNull
        when (kind) {
            "sync-tail" -> {
                scripted.begin(decodeResponses(op))
                store.syncTail()
                assertSettled(store, scripted, opIndex)
                assertRequests(op, scripted, opIndex)
            }
            "fetch-older" -> {
                scripted.begin(decodeResponses(op))
                val outcome = store.fetchOlder()
                assertSettled(store, scripted, opIndex)
                assertRequests(op, scripted, opIndex)
                op["expectedOutcome"]?.let { expected ->
                    assertEquals(expected, projectOutcome(outcome), "ops[$opIndex] outcome")
                }
            }
            "sse-messages" -> store.ingestSseMessages(
                op.getValue("messages").jsonArray.map(::decodeWindowMessage)
            )
            "append-optimistic" -> store.appendOptimistic(decodeWindowMessage(op.getValue("message")))
            "update-status" -> store.updateStatus(
                localId = op.getValue("localId").stringOrNull!!,
                status = MessageStatus.fromWire(op.getValue("status").stringOrNull)!!,
            )
            "messages-consumed" -> store.markConsumed(
                localIds = op.getValue("localIds").jsonArray.map { it.stringOrNull!! },
                invokedAt = op.getValue("invokedAt").longOrNull!!,
            )
            "message-cancelled" -> store.removeMessage(op.getValue("localId").stringOrNull!!)
            "cancel-invoked" -> store.applyCancelInvoked(
                localId = op.getValue("localId").stringOrNull!!,
                message = decodeWindowMessage(op.getValue("message")),
            )
            "set-view-mode" -> store.setViewMode(
                when (op.getValue("mode").stringOrNull) {
                    "history" -> MessageViewMode.History
                    else -> MessageViewMode.Tail
                }
            )
            "queued-state" -> {
                // Mirrors the web runner (reconcileQueuedStateAfterConnect's
                // post tail-sync half): collect candidates, apply invoked
                // verdicts grouped by timestamp, drop deleted candidates.
                val candidates = store.queuedReconcileCandidateLocalIds()
                op["expectedCandidates"]?.let { expected ->
                    assertEquals(
                        expected,
                        JsonArray(candidates.map(::JsonPrimitive)),
                        "ops[$opIndex] candidates",
                    )
                }
                val invokedByTimestamp = LinkedHashMap<Long, MutableList<String>>()
                for (entry in op.getValue("invoked").jsonArray) {
                    val invoked = entry.jsonObject
                    invokedByTimestamp
                        .getOrPut(invoked.getValue("invokedAt").longOrNull!!) { mutableListOf() }
                        .add(invoked.getValue("localId").stringOrNull!!)
                }
                for ((invokedAt, localIds) in invokedByTimestamp) {
                    store.markConsumed(localIds, invokedAt)
                }
                store.reconcileQueuedLocalIds(
                    candidateLocalIds = candidates,
                    queuedLocalIds = op.getValue("queuedLocalIds").jsonArray.map { it.stringOrNull!! },
                )
            }
            else -> fail("ops[$opIndex]: unknown op '$kind'")
        }
    }

    private fun decodeResponses(op: JsonObject): List<MessagesResponse> =
        HapiJson.decodeFromJsonElement(
            ListSerializer(MessagesResponse.serializer()),
            op.getValue("responses"),
        )

    private fun decodeWindowMessage(element: JsonElement): WindowMessage =
        HapiJson.decodeFromJsonElement(WindowMessage.serializer(), element)

    private fun assertSettled(store: MessageWindowStore, scripted: ScriptedMessagesApi, opIndex: Int) {
        assertEquals(0, scripted.remaining, "ops[$opIndex]: scripted response(s) left unconsumed")
        val state = store.state.value
        assertNull(state.warning, "ops[$opIndex]: store reported a warning")
        assertTrue(!state.isSyncingTail && !state.isLoadingMore, "ops[$opIndex]: store still busy after the op settled")
    }

    private fun assertRequests(op: JsonObject, scripted: ScriptedMessagesApi, opIndex: Int) {
        val expected = op["expectedRequests"] ?: return
        assertEquals(expected, JsonArray(scripted.requests.toList()), "ops[$opIndex] requests")
    }

    // ----------------------------------------------------------- projection --

    private fun projectOutcome(outcome: OlderLoadOutcome): JsonObject = when (outcome) {
        is OlderLoadOutcome.Applied -> buildJsonObject {
            put("kind", "applied")
            put("hasMore", outcome.hasMore)
            put("addedRenderableCount", outcome.addedRenderableCount)
        }
        is OlderLoadOutcome.Stopped -> buildJsonObject {
            put("kind", "stopped")
            put("reason", outcome.reason.wire)
        }
        is OlderLoadOutcome.Failed -> fail("older-page load failed: ${outcome.error.message}")
    }

    private fun projectWindowState(state: MessageWindowState): JsonObject = buildJsonObject {
        put("messages", JsonArray(state.messages.map(::projectMessage)))
        put("hasMore", state.hasMore)
        put("epoch", state.epoch?.let(::JsonPrimitive) ?: JsonNull)
        put("viewMode", state.viewMode.wire)
        put("olderCursor", projectCursor(state.oldestPosition?.at, state.oldestPosition?.seq))
        put("newestCursor", projectCursor(state.newestPosition?.at, state.newestPosition?.seq))
    }

    private fun projectMessage(message: WindowMessage): JsonObject = buildJsonObject {
        put("id", message.id)
        put("localId", message.localId?.let(::JsonPrimitive) ?: JsonNull)
        put("seq", message.seq?.let(::JsonPrimitive) ?: JsonNull)
        put("createdAt", message.createdAt)
        // Wire tri-state: the key appears only when the wire carried it.
        when (val invokedAt = message.wire.invokedAt) {
            is OptionalField.Present -> put("invokedAt", invokedAt.value?.let(::JsonPrimitive) ?: JsonNull)
            OptionalField.Absent -> Unit
        }
        message.wire.scheduledAt?.let { put("scheduledAt", it) }
        message.status?.let { put("status", it.wire) }
        put("queued", message.isQueuedForInvocation)
        put("optimistic", message.isOptimistic)
    }

    private fun projectCursor(at: Long?, seq: Long?): JsonElement =
        if (at != null && seq != null) {
            buildJsonObject {
                put("at", at)
                put("seq", seq)
            }
        } else {
            JsonNull
        }
}

/**
 * The scripted transport: serves queued [MessagesResponse]s FIFO and records
 * each request in the canonical shape the web harness pinned — `limit` only
 * for a latest page; `beforeAt`+`beforeSeq`+`limit` for older pages;
 * `afterAt`+`afterSeq`+`untilAt`+`untilSeq`+`epoch`+`limit` (untils
 * explicitly null on the first loop request) for tail catch-up.
 */
internal class ScriptedMessagesApi : MessagesApi {
    private val queue = ArrayDeque<MessagesResponse>()
    val requests = mutableListOf<JsonObject>()

    val remaining: Int get() = queue.size

    fun begin(responses: List<MessagesResponse>) {
        queue.clear()
        queue.addAll(responses)
        requests.clear()
    }

    override suspend fun getMessages(sessionId: String, query: MessagesQuery): MessagesResponse {
        requests += query.toRequestJson()
        return queue.removeFirstOrNull()
            ?: throw IllegalStateException("scripted MessagesApi exhausted: unexpected getMessages request")
    }

    override suspend fun getQueuedState(sessionId: String, localIds: List<String>): QueuedStateResponse =
        throw UnsupportedOperationException("queued-state ops are replayed via store primitives, like the web runner")

    private fun MessagesQuery.toRequestJson(): JsonObject = when (this) {
        is MessagesQuery.Latest -> buildJsonObject {
            put("limit", limit)
        }
        is MessagesQuery.Before -> buildJsonObject {
            put("beforeAt", beforeAt)
            put("beforeSeq", beforeSeq)
            put("limit", limit)
        }
        is MessagesQuery.After -> buildJsonObject {
            put("afterAt", afterAt)
            put("afterSeq", afterSeq)
            put("epoch", epoch)
            put("limit", limit)
            put("untilAt", untilAt?.let(::JsonPrimitive) ?: JsonNull)
            put("untilSeq", untilSeq?.let(::JsonPrimitive) ?: JsonNull)
        }
    }
}
