package app.hapi.companion.feature.chat

import androidx.compose.runtime.Immutable
import androidx.compose.runtime.compositionLocalOf

/**
 * Interaction callbacks + optimistic overlay for chat blocks (B-M3ab),
 * provided by [ChatScreen] via [LocalChatInteractions]. Null (previews,
 * tests, read-only embeddings) keeps blocks in their M2 read-only rendering.
 *
 * [permissionOverrides] rides here (not per-block props) so deeply nested
 * tool cards — groups, sidechains — see optimistic state without threading
 * parameters through every layer.
 */
@Immutable
data class ChatInteractions(
    /** Raw agent flavor id — selects the permission button set. */
    val flavor: String?,
    val permissionOverrides: Map<String, PermissionRowOverride>,
    val resolvePermission: (requestId: String, action: PermissionAction) -> Unit,
    val retryFailedMessage: (localId: String) -> Unit,
)

/** Dynamic local: override churn invalidates readers only, not the whole tree. */
val LocalChatInteractions = compositionLocalOf<ChatInteractions?> { null }
