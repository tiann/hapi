package app.hapi.companion.feature.chat

import androidx.compose.runtime.Composable
import androidx.compose.runtime.Stable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.runtime.saveable.listSaver
import androidx.compose.runtime.saveable.rememberSaveable

@Stable
internal class TranscriptReadingState(followsTail: Boolean = true) {
    var followsTail by mutableStateOf(followsTail)
}

@Composable
internal fun rememberTranscriptReadingState(sessionId: String): TranscriptReadingState = rememberSaveable(
    sessionId,
    saver = listSaver(save = { listOf(it.followsTail) }, restore = { TranscriptReadingState(it[0]) }),
) { TranscriptReadingState() }
