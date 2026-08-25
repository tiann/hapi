package app.hapi.companion.feature.chat.composer

/**
 * Per-session composer draft persistence (B-M3a). Production backing is a
 * Preferences DataStore ([app.hapi.companion.di.DataStoreChatDrafts], keys
 * scoped by hub); tests use an in-memory map.
 */
interface ChatDrafts {
    /** The saved draft, or null when none. */
    suspend fun load(sessionId: String): String?

    /** Persist [text]; blank clears the key. */
    suspend fun save(sessionId: String, text: String)

    suspend fun clear(sessionId: String)

    /** Resume/reopen returned a different id: carry the draft across. */
    suspend fun move(fromSessionId: String, toSessionId: String)
}
