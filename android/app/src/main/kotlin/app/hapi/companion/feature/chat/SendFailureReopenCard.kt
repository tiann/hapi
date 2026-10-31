package app.hapi.companion.feature.chat

/**
 * Send-failure reopen card state (slice 6d). The web twin is the inline error
 * card's session-inactive action (`web/src/router.tsx:472-488` — the Reopen
 * affordance is offered only while the failed send's session stays inactive).
 * Pure logic, JVM-testable: [ChatViewModel] derives it, [ChatScreen] renders it.
 */
data class SendFailureReopenCard(
    val visible: Boolean,
    /** A reopen fired from the card is in flight — button disabled, spinner. */
    val reopenPending: Boolean,
)

/** Derivation rules; pending is only reported while the card itself is visible. */
object SendFailureReopenCardLogic {
    fun derive(
        lastSendFailedInactive: Boolean,
        sessionActive: Boolean,
        reopenPending: Boolean,
    ): SendFailureReopenCard {
        val visible = lastSendFailedInactive && !sessionActive
        return SendFailureReopenCard(
            visible = visible,
            reopenPending = visible && reopenPending,
        )
    }
}
