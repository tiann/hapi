package app.hapi.companion.feature.chat.composer

/**
 * Max-50 recency ring shared by every composer-draft store (web
 * `MAX_DRAFTS = 50`): the persisted text-draft index, the persisted
 * attachment-draft index, and the in-memory live-snapshot ring.
 *
 * Pure Kotlin — no Android types, so every boundary is JVM-testable.
 */
object DraftRing {

    /** Web `MAX_DRAFTS`; also the live-snapshot cap. */
    const val MAX_ENTRIES: Int = 50

    /**
     * Insert-or-refresh [sessionId] at [touchedAtMillis] and evict
     * least-recently-touched entries beyond [maxEntries]. A same-key update
     * never evicts (the key count does not grow). The touched key itself is
     * never a victim (it holds the freshest timestamp). Ties on the minimum
     * timestamp evict the first in iteration order — deterministic under the
     * `LinkedHashMap`s the stores decode into.
     *
     * @return the evicted session ids (empty when nothing exceeded the cap).
     */
    fun touch(
        index: MutableMap<String, Long>,
        sessionId: String,
        touchedAtMillis: Long,
        maxEntries: Int = MAX_ENTRIES,
    ): List<String> {
        index[sessionId] = touchedAtMillis
        val evicted = mutableListOf<String>()
        while (index.size > maxEntries) {
            val victim = index.entries
                .filter { it.key != sessionId }
                .minByOrNull { it.value }
                ?: break
            index.remove(victim.key)
            evicted += victim.key
        }
        return evicted
    }

    /**
     * Delete-then-reinsert [sessionId] into [ring] (refreshing its recency
     * like the web's delete+set) and drop the eldest entries beyond
     * [maxEntries]. Eviction can only happen when a NEW key grows the ring —
     * a same-key update never evicts.
     */
    fun <V> putTouching(
        ring: LinkedHashMap<String, V>,
        sessionId: String,
        value: V,
        maxEntries: Int = MAX_ENTRIES,
    ) {
        ring.remove(sessionId)
        ring[sessionId] = value
        while (ring.size > maxEntries) {
            val eldest = ring.keys.firstOrNull { it != sessionId } ?: break
            ring.remove(eldest)
        }
    }
}
