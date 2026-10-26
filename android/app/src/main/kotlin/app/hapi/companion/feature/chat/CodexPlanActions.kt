package app.hapi.companion.feature.chat

/** A server/transport error; null detail uses the localized request-failed fallback. */
data class CodexPlanFailure(val detail: String?)

data class CodexPlanActionState(
    val available: Boolean,
    val pending: Boolean,
    val canAct: Boolean,
    val error: CodexPlanFailure?,
) {
    val isVisible: Boolean get() = available || pending || error != null
}

/** Screen-owned plan menus, independent of tool permissions and row recycling. */
data class CodexPlanActions(
    val proposalId: String? = null,
    val pendingPlanId: String? = null,
    val disabled: Boolean = false,
    val errors: Map<String, CodexPlanFailure> = emptyMap(),
) {
    fun forPlan(planId: String): CodexPlanActionState = CodexPlanActionState(
        available = proposalId == planId,
        pending = pendingPlanId == planId,
        canAct = proposalId == planId && pendingPlanId == null && !disabled,
        error = errors[planId],
    )
}
