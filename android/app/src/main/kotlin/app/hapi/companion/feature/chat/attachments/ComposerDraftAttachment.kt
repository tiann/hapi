package app.hapi.companion.feature.chat.attachments

import kotlinx.serialization.Serializable

/**
 * A persisted attachment-draft **reference** (drafts v2): everything needed
 * to re-create a Ready composer chip after the screen goes away — the hub
 * upload [path] plus the small [previewUrl] data URL for the thumbnail.
 *
 * References only, never payload blobs (the web keeps `File` handles for
 * re-upload; Android drops bytes once uploaded, so the hub file IS the
 * storage — mirrored from the `AttachmentMetadata` wire shape).
 *
 * [path] is nullable defensively: decoding is lenient, and entries without a
 * hub path cannot become Ready chips again, so the loader drops them.
 */
@Serializable
data class ComposerDraftAttachment(
    val id: String,
    val filename: String,
    val mimeType: String,
    val sizeBytes: Long,
    val path: String? = null,
    val previewUrl: String? = null,
)
