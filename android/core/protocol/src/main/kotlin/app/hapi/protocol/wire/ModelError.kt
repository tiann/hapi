package app.hapi.protocol.wire

import kotlinx.serialization.Serializable

/** Fields shared by detail metadata and the list projection. The recovery prompt stays on the hub. */
@Serializable
data class ModelError(
    val eventId: String,
    val kind: String,
    val transient: Boolean,
    val rawSnippet: String,
    val atTs: Long,
    val priorAssistantClaimsDone: Boolean,
    val bridgedForEventId: String? = null,
    val retriedAndFailed: Boolean? = null,
    val supersededByUserTurn: Boolean? = null,
    val bridgeable: Boolean? = null,
    val acknowledgedAt: Long? = null,
)

/** Admission of the recovery request. Completion is reported by session metadata. */
data class ModelErrorActionResponse(val ok: Boolean, val reason: String? = null)
