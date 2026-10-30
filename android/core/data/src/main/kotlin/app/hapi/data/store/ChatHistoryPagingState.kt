package app.hapi.data.store

import app.hapi.protocol.window.OlderLoadOutcome

/** A page remains in flight until its version has been laid out. UI-thread owned. */
data class ChatHistoryPagingState(
    val phase: Phase = Phase.Idle,
    val generation: Long = 0,
    val failures: Int = 0,
    val pagesWithoutProgress: Int = 0,
) {
    sealed interface Phase {
        data object Idle : Phase
        data object Loading : Phase
        data class AwaitingLayout(val historyVersion: Long) : Phase
        data object Retrying : Phase
        data object Failed : Phase
        data object Paused : Phase
        data object Exhausted : Phase
    }

    fun begin(): ChatHistoryPagingState =
        if (phase == Phase.Idle) copy(phase = Phase.Loading, generation = generation + 1) else this

    fun received(result: OlderLoadOutcome, request: Long): ChatHistoryPagingState {
        if (generation != request || phase != Phase.Loading) return this
        return when (result) {
            is OlderLoadOutcome.Applied -> copy(phase = Phase.AwaitingLayout(result.historyVersion), failures = 0)
            is OlderLoadOutcome.Failed -> copy(
                phase = if (failures < 2) Phase.Retrying else Phase.Failed,
                failures = failures + 1,
            )
            is OlderLoadOutcome.Stopped -> copy(phase = when (result.reason) {
                OlderLoadOutcome.StopReason.Exhausted -> Phase.Exhausted
                OlderLoadOutcome.StopReason.CursorDidNotAdvance -> Phase.Paused
                else -> Phase.Idle
            })
        }
    }

    val retryDelayMillis: Long? get() = if (phase != Phase.Retrying) null else if (failures == 1) 500 else 1500

    fun retryElapsed(request: Long): ChatHistoryPagingState =
        if (generation == request && phase == Phase.Retrying) copy(phase = Phase.Idle) else this

    fun laidOut(historyVersion: Long, madeProgress: Boolean): ChatHistoryPagingState {
        val waiting = phase as? Phase.AwaitingLayout ?: return this
        if (historyVersion < waiting.historyVersion) return this
        val emptyPages = if (madeProgress) 0 else pagesWithoutProgress + 1
        return copy(phase = if (emptyPages >= 3) Phase.Paused else Phase.Idle, pagesWithoutProgress = emptyPages)
    }

    fun resume(): ChatHistoryPagingState =
        if (phase == Phase.Failed || phase == Phase.Paused) copy(phase = Phase.Idle, failures = 0, pagesWithoutProgress = 0) else this

    fun cancel(): ChatHistoryPagingState = ChatHistoryPagingState(generation = generation + 1)

    fun refreshAvailability(hasMore: Boolean): ChatHistoryPagingState =
        if (hasMore && phase == Phase.Exhausted) copy(phase = Phase.Idle) else this
}
