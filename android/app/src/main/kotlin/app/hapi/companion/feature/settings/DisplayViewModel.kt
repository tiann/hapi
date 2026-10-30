package app.hapi.companion.feature.settings

import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.launch

/**
 * Display-subpage state: the persisted [DisplaySettings] as UI state plus
 * field-level setters (the web page writes one hook per control; here every
 * setter is one [DisplayPrefs.update]). Plain constructor for JVM tests;
 * Navigation hosts it behind a per-hub lifecycle holder.
 */
class DisplayViewModel(
    private val prefs: DisplayPrefs,
    private val scope: CoroutineScope,
) {

    val settings: StateFlow<DisplaySettings> = prefs.settings
        .stateIn(scope, SharingStarted.Eagerly, DisplaySettings())

    fun setSessionPreviewLimit(limit: Int) {
        write { it.copy(sessionPreviewLimit = SessionPreviewLimit.coerce(limit)) }
    }

    fun setShowActiveSessionsOnly(enabled: Boolean) {
        write { it.copy(showActiveSessionsOnly = enabled) }
    }

    fun setPinInProgressSessions(enabled: Boolean) {
        write { it.copy(pinInProgressSessions = enabled) }
    }

    fun setSessionListStatusMode(mode: SessionListStatusMode) {
        write { it.copy(sessionListStatusMode = mode) }
    }

    fun setFontScale(scale: AppFontScale) {
        write { it.copy(fontScale = scale) }
    }

    fun setHeaderMetadata(metadata: SessionHeaderMetadata) {
        write { it.copy(headerMetadata = metadata) }
    }

    private fun write(transform: (DisplaySettings) -> DisplaySettings) {
        scope.launch { prefs.update(transform) }
    }
}
