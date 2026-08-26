package app.hapi.protocol.window

import app.hapi.protocol.wire.OptionalField
import app.hapi.protocol.wire.isUserMessage
import kotlin.math.abs

/**
 * Merge/order semantics for window rows — a faithful port of
 * `web/src/lib/messages.ts` (`compareMessages`, `mergeMessages`).
 */
object MessageMerge {

    /**
     * Position comparator: ascending `at = invokedAt ?? createdAt`, ties by
     * `seq`, full ties by ASCII id comparison. The web uses `localeCompare`
     * for the final tie-break, but the fixtures keep every position pair
     * distinct and the fixtures README pins ASCII comparison for native
     * ports (`shared/fixtures/README.md`, pagination determinism notes).
     */
    val comparator: Comparator<WindowMessage> = Comparator { a, b ->
        val aTime = a.invokedAtOrNull ?: a.createdAt
        val bTime = b.invokedAtOrNull ?: b.createdAt
        if (aTime != bTime) return@Comparator aTime.compareTo(bTime)
        val aSeq = a.seq
        val bSeq = b.seq
        if (aSeq != null && bSeq != null && aSeq != bSeq) return@Comparator aSeq.compareTo(bSeq)
        a.id.compareTo(b.id)
    }

    /**
     * Merge [incoming] into [existing]:
     * - by-id upsert (incoming wins; a numeric `invokedAt` already known
     *   locally is preserved when the incoming copy lacks one);
     * - stored rows carrying a `localId` evict the optimistic bubble with the
     *   same `localId`, inheriting its client `status` (when the server row
     *   has none) and any locally-known numeric `invokedAt`;
     * - fallback: an optimistic row already `sent` is dropped when a server
     *   user message sits within 10 s of the same position;
     * - stable sort by [comparator].
     */
    fun mergeMessages(existing: List<WindowMessage>, incoming: List<WindowMessage>): List<WindowMessage> {
        if (existing.isEmpty()) {
            return incoming.sortedWith(comparator)
        }
        if (incoming.isEmpty()) {
            return existing.sortedWith(comparator)
        }

        val byId = LinkedHashMap<String, WindowMessage>()
        for (message in existing) {
            byId[message.id] = message
        }
        for (message in incoming) {
            val current = byId[message.id]
            // JS `existing.invokedAt != null && msg.invokedAt == null` — keep a
            // locally-known invocation stamp when the incoming copy has none
            // (explicit null or absent).
            byId[message.id] = if (current != null && current.invokedAtOrNull != null && message.invokedAtOrNull == null) {
                message.withInvokedAt(current.invokedAtOrNull!!)
            } else {
                message
            }
        }

        var merged: List<WindowMessage> = byId.values.toList()

        val incomingStoredLocalIds = buildSet {
            for (message in incoming) {
                val localId = message.localId
                if (localId != null && !message.isOptimistic) add(localId)
            }
        }

        if (incomingStoredLocalIds.isNotEmpty()) {
            val optimisticStatusByLocalId = HashMap<String, MessageStatus>()
            val optimisticInvokedAtByLocalId = HashMap<String, Long?>()
            for (message in merged) {
                val localId = message.localId ?: continue
                if (!message.isOptimistic || localId !in incomingStoredLocalIds) continue
                message.status?.let { optimisticStatusByLocalId[localId] = it }
                if (message.wire.invokedAt is OptionalField.Present) {
                    optimisticInvokedAtByLocalId[localId] = message.invokedAtOrNull
                }
            }
            merged = merged.filter { message ->
                val localId = message.localId
                localId == null || localId !in incomingStoredLocalIds || !message.isOptimistic
            }
            if (optimisticStatusByLocalId.isNotEmpty() || optimisticInvokedAtByLocalId.isNotEmpty()) {
                merged = merged.map { message ->
                    val localId = message.localId ?: return@map message
                    var updated = message
                    val preservedStatus = optimisticStatusByLocalId[localId]
                    if (preservedStatus != null && message.status == null) {
                        updated = updated.copy(status = preservedStatus)
                    }
                    if (optimisticInvokedAtByLocalId.containsKey(localId) && message.invokedAtOrNull == null) {
                        val optimisticInvokedAt = optimisticInvokedAtByLocalId[localId]
                        if (optimisticInvokedAt != null) {
                            updated = updated.withInvokedAt(optimisticInvokedAt)
                        }
                    }
                    updated
                }
            }
        }

        val optimisticMessages = merged.filter { it.isOptimistic }
        val nonOptimisticMessages = merged.filter { !it.isOptimistic }
        val result = nonOptimisticMessages.toMutableList()

        for (optimistic in optimisticMessages) {
            if (optimistic.status == MessageStatus.Sent) {
                // Compare by the position key (invokedAt ?? createdAt): a late
                // ack can attach invokedAt long after createdAt, and matching
                // on createdAt alone would render duplicates.
                val optimisticTime = optimistic.invokedAtOrNull ?: optimistic.createdAt
                val hasServerUserMessage = nonOptimisticMessages.any { message ->
                    message.wire.isUserMessage
                        && abs((message.invokedAtOrNull ?: message.createdAt) - optimisticTime) < 10_000
                }
                if (hasServerUserMessage) continue
            }
            result.add(optimistic)
        }

        return result.sortedWith(comparator)
    }
}
