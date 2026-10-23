package app.hapi.companion.feature.sessions

import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow

/**
 * Session-list display preferences. Web persists these as localStorage
 * display settings (`hapi-pin-in-progress-sessions`, …) and always renders
 * directory grouping; Android starts from the same defaults and keeps the
 * flat list available as a toggle.
 */
interface SessionDisplayPrefs {

    /** Directory-grouped home list (default) vs the flat list. */
    val grouped: Flow<Boolean>

    suspend fun setGrouped(value: Boolean)

    companion object {
        const val DEFAULT_GROUPED = true
    }
}

/** In-memory implementation for tests and previews. */
class InMemorySessionDisplayPrefs(
    initial: Boolean = SessionDisplayPrefs.DEFAULT_GROUPED,
) : SessionDisplayPrefs {
    private val state = MutableStateFlow(initial)
    override val grouped: Flow<Boolean> = state
    override suspend fun setGrouped(value: Boolean) {
        state.value = value
    }
}
