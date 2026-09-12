package app.hapi.data.store

import app.hapi.data.api.HapiApi
import app.hapi.protocol.wire.HapiJson
import app.hapi.protocol.wire.Machine
import app.hapi.protocol.wire.MachineMetadata
import app.hapi.protocol.wire.Session
import app.hapi.protocol.wire.SessionSummary
import app.hapi.protocol.wire.SessionsResponse
import app.hapi.protocol.wire.SyncEvent
import app.hapi.protocol.wire.SyncEvents
import kotlinx.serialization.encodeToString
import okhttp3.OkHttpClient
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer

fun summary(
    id: String,
    active: Boolean = false,
    updatedAt: Long = 0,
    activeAt: Long = 0,
    pinned: Boolean? = null,
    globalPinned: Boolean? = null,
    pendingRequestsCount: Int = 0,
    metadataVersion: Long = 0,
    agentStateVersion: Long = 0,
    todosUpdatedAt: Long = 0,
    futureScheduledMessageCount: Int = 0,
    nextScheduledAt: Long? = null,
    metadata: app.hapi.protocol.wire.SessionSummaryMetadata? = null,
): SessionSummary = SessionSummary(
    id = id,
    active = active,
    thinking = false,
    activeAt = activeAt,
    updatedAt = updatedAt,
    pinned = pinned,
    globalPinned = globalPinned,
    metadata = metadata,
    metadataVersion = metadataVersion,
    agentStateVersion = agentStateVersion,
    todosUpdatedAt = todosUpdatedAt,
    todoProgress = null,
    pendingRequestsCount = pendingRequestsCount,
    pendingRequestKinds = emptyList(),
    pendingRequests = emptyList(),
    backgroundTaskCount = 0,
    futureScheduledMessageCount = futureScheduledMessageCount,
    nextScheduledAt = nextScheduledAt,
    model = null,
    modelReasoningEffort = null,
    effort = null,
)

fun session(
    id: String,
    updatedAt: Long = 0,
    active: Boolean = true,
    metadataVersion: Long = 1,
    agentStateVersion: Long = 1,
    todosUpdatedAt: Long? = 0,
): Session = Session(
    id = id,
    namespace = "default",
    seq = 1,
    createdAt = 1,
    updatedAt = updatedAt,
    active = active,
    activeAt = 0,
    metadata = null,
    metadataVersion = metadataVersion,
    agentState = null,
    agentStateVersion = agentStateVersion,
    thinking = false,
    thinkingAt = 0,
    todosUpdatedAt = todosUpdatedAt,
)

fun machine(id: String, active: Boolean = true, host: String = "$id-host"): Machine = Machine(
    id = id,
    namespace = "default",
    seq = 1,
    createdAt = 1,
    updatedAt = 1,
    active = active,
    activeAt = 1,
    metadata = MachineMetadata(host = host, platform = "linux", happyCliVersion = "1.0.0"),
    metadataVersion = 1,
    runnerState = null,
    runnerStateVersion = 1,
)

/** Builds a decoded `session-updated` event whose `data` is raw JSON text. */
fun sessionUpdatedEvent(sessionId: String, dataJson: String?): SyncEvent {
    val data = dataJson?.let { ""","data":$it""" } ?: ""
    return SyncEvents.parse("""{"type":"session-updated","sessionId":"$sessionId"$data}""")
}

fun sessionAddedEvent(sessionId: String, dataJson: String?): SyncEvent {
    val data = dataJson?.let { ""","data":$it""" } ?: ""
    return SyncEvents.parse("""{"type":"session-added","sessionId":"$sessionId"$data}""")
}

fun sessionRemovedEvent(sessionId: String): SyncEvent =
    SyncEvents.parse("""{"type":"session-removed","sessionId":"$sessionId"}""")

fun machineUpdatedEvent(machineId: String, dataJson: String?): SyncEvent.MachineUpdated {
    val data = dataJson?.let { ""","data":$it""" } ?: ""
    return SyncEvents.parse("""{"type":"machine-updated","machineId":"$machineId"$data}""")
        as SyncEvent.MachineUpdated
}

fun fullSessionJson(session: Session): String = HapiJson.encodeToString(session)

fun sessionsResponseJson(vararg sessions: SessionSummary): String =
    HapiJson.encodeToString(SessionsResponse(sessions.toList()))

fun MockWebServer.enqueueJson(body: String, code: Int = 200) {
    enqueue(
        MockResponse()
            .setResponseCode(code)
            .setHeader("Content-Type", "application/json")
            .setBody(body)
    )
}

fun apiFor(server: MockWebServer): HapiApi =
    HapiApi(server.url("/"), OkHttpClient())
