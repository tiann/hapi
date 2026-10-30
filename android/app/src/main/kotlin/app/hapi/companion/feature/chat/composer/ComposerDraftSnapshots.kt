package app.hapi.companion.feature.chat.composer

import app.hapi.companion.feature.chat.attachments.ComposerDraftAttachment

/** One session's freshest in-flight composer state (web `liveSnapshots`). */
data class ComposerDraftSnapshot(
    val text: String = "",
    val attachments: List<ComposerDraftAttachment> = emptyList(),
)

/**
 * Process-wide in-memory live composer snapshots (drafts v2, web
 * `liveSnapshots` twin): a max-50 recency ring holding the text +
 * attachment references a screen last saw, surviving screen exits within
 * the process (hub-scoped singleton in `HubGraph`).
 *
 * Restores prefer the durable DataStore and fall back to the snapshot (the
 * carry writes both; if the durable write failed the snapshot still
 * carries). The `handedOff` set mirrors the web `completedHandoffs`
 * tombstones: a session whose draft was carried into a superseding id must
 * not resurrect its snapshot on exit cleanup — [set] clears the tombstone
 * (fresh user input legitimately re-opens the source), like the web.
 */
class ComposerDraftSnapshots {

    private val ring = LinkedHashMap<String, ComposerDraftSnapshot>()

    /** Web `completedHandoffs`: source ids whose draft was carried away. */
    private val handedOff = HashSet<String>()

    /** Record the freshest snapshot for [sessionId] (clears its tombstone). */
    @Synchronized
    fun set(sessionId: String, snapshot: ComposerDraftSnapshot) {
        handedOff.remove(sessionId)
        DraftRing.putTouching(ring, sessionId, snapshot)
    }

    @Synchronized
    fun get(sessionId: String): ComposerDraftSnapshot? = ring[sessionId]

    /** Drop the snapshot; the tombstone (if any) survives. */
    @Synchronized
    fun remove(sessionId: String) {
        ring.remove(sessionId)
    }

    /** The draft moved to a superseding id: retire this one for good. */
    @Synchronized
    fun markHandedOff(sessionId: String) {
        ring.remove(sessionId)
        handedOff.add(sessionId)
    }

    @Synchronized
    fun wasHandedOff(sessionId: String): Boolean = sessionId in handedOff
}
