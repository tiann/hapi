package app.hapi.protocol.chat

/**
 * Conversation-history boundary helpers backing the Android fork/rewind
 * actions — a pure-Kotlin port of the web's
 * `findLatestCompletedBoundaryId` (`web/src/lib/assistant-runtime.ts`).
 *
 * A *boundary* is a message the agent has fully processed: either an
 * invoked user message (`invokedAt != null`) or the first block of an
 * assistant run (previous visible role was not `assistant`). The latest
 * such boundary is where "Fork (current)" applies; per-message
 * `conversationHistoryPoints` entries gate "Fork from here" / "Rewind".
 */

/**
 * Stable per-block thread key mirroring the web `assignThreadMessageIds`
 * format `` `${kind}:${id}` ``. Web suffixes duplicates `~1`, `~2`, …; the
 * Android window already dedupes rows by id before blocks are built, so the
 * first-occurrence key is unique in practice.
 */
val VisibleChatBlock.threadKey: String
    get() = when (this) {
        is ToolGroupBlock -> "$kind:$id"
        is ChatBlock -> "$kind:$id"
    }

/** `block.invokedAt ?? block.createdAt`. */
private fun invokedOrCreatedAt(block: VisibleChatBlock): Long = when (block) {
    is ChatBlock -> block.invokedAt ?: block.createdAt
    is ToolGroupBlock -> block.invokedAt ?: block.createdAt
}

/**
 * Finds the latest conversation-history boundary key that is safe to fork,
 * or `null` when there is none.
 *
 * While the agent is running, every block from the active turn's first user
 * message onward is excluded so streaming reshuffles can't surface a
 * transient "completed" boundary:
 * - With a known [activeTurnStartedAt], the limit is the first user block
 *   at/after it; if none exists, the first *any-role* block at/after it;
 *   if that too is missing the window predates the turn entirely and the
 *   full list stays eligible (web parity).
 * - Without it, the limit is the last invoked user block — and if the
 *   running turn has none yet the caller gets `null` (nothing completed).
 */
fun findLatestCompletedBoundaryKey(
    blocks: List<VisibleChatBlock>,
    isRunning: Boolean,
    activeTurnStartedAt: Long?,
): String? {
    var limit = blocks.size
    if (isRunning) {
        if (activeTurnStartedAt == null) {
            val lastInvokedUser = blocks.indexOfLast { block ->
                visibleBlockRole(block) == "user" && (block as? ChatBlock)?.invokedAt != null
            }
            if (lastInvokedUser < 0) return null
            limit = lastInvokedUser
        } else {
            val activeUserStart = blocks.indexOfFirst { block ->
                visibleBlockRole(block) == "user" &&
                    invokedOrCreatedAt(block) >= activeTurnStartedAt
            }
            limit = if (activeUserStart >= 0) {
                activeUserStart
            } else {
                val firstActiveBlock = blocks.indexOfFirst { block ->
                    invokedOrCreatedAt(block) >= activeTurnStartedAt
                }
                if (firstActiveBlock >= 0) firstActiveBlock else blocks.size
            }
        }
    }

    var candidate: String? = null
    var previousRole: String? = null
    for (index in 0 until limit) {
        val block = blocks[index]
        val role = visibleBlockRole(block)
        val userInvoked = role == "user" && (block as? ChatBlock)?.invokedAt != null
        val assistantRunStart = role == "assistant" && previousRole != "assistant"
        if (userInvoked || assistantRunStart) candidate = block.threadKey
        previousRole = role
    }
    return candidate
}
