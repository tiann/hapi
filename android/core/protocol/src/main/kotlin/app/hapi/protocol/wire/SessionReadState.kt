package app.hapi.protocol.wire

import kotlinx.serialization.Serializable

@Serializable
data class SessionReadState(
    val readRevision: Long = 0,
    val manualUnread: Boolean = false,
    val version: Long = 0,
) {
    companion object {
        fun merge(current: SessionReadState?, incoming: SessionReadState?): SessionReadState? {
            if (incoming == null) return current
            if (current == null) return incoming
            val newest = if (incoming.version > current.version) incoming else current
            return newest.copy(readRevision = maxOf(current.readRevision, incoming.readRevision))
        }
    }
}

@Serializable
data class SessionReadStateRequest(
    val type: String,
    val readRevision: Long? = null,
    val expectedVersion: Long,
)

@Serializable
data class SessionReadStateResponse(val readState: SessionReadState, val contentRevision: Long)
