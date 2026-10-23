package app.hapi.companion.feature.chat.attachments

/**
 * JVM-testable flattening of a clipboard `ClipData`: [uri] is the item's
 * content URI as a string, or null for a text-only item (no Android types
 * below this line — same pattern as [AttachmentPolicy]).
 */
data class ClipboardClipItem(val uri: String? = null)

/**
 * Paste-to-attach picks: decide which clipboard items are attachable
 * content URIs — pure logic, no Android imports.
 *
 * Web twin (`HappyComposer.tsx` `handlePaste`): the web attaches
 * `clipboardData.files` — any file kind, not just images (upstream #2026;
 * the adapter accepts `'*'`, attachmentAdapter.ts) — and an empty files
 * list falls through to the default text paste. On Android the equivalent
 * signal is a ClipData Item's `uri`: text-only clips carry none and take
 * the normal text-paste path exactly like the web's empty-files branch.
 */
object ClipboardAttachments {

    /**
     * Attachable `content://` URIs in clipboard order, deduped by first
     * occurrence (a repeated clip yields one chip). Null (text-only),
     * non-content (`file://`, `http://`…) and blank entries are skipped
     * silently; an empty result means "not a paste with files" and the
     * caller lets the default text paste proceed.
     */
    fun attachableUris(items: List<ClipboardClipItem>): List<String> {
        val seen = mutableSetOf<String>()
        val uris = mutableListOf<String>()
        for (item in items) {
            val uri = item.uri ?: continue
            if (!uri.startsWith("content://")) continue
            if (seen.add(uri)) uris += uri
        }
        return uris
    }
}
