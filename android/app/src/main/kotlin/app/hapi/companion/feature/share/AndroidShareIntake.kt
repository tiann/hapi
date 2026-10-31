package app.hapi.companion.feature.share

import android.content.ContentResolver
import android.content.Intent
import android.net.Uri
import android.provider.OpenableColumns
import android.webkit.MimeTypeMap
import androidx.core.content.IntentCompat
import java.io.InputStream
import java.util.Locale

/** Never coerce a URI clip to text: that can read the entire provider file. */
fun parseSharedIntent(intent: Intent): SharedInput? {
    if (intent.action != Intent.ACTION_SEND && intent.action != Intent.ACTION_SEND_MULTIPLE) return null
    return try {
        val uris = mutableListOf<Uri>()
        if (intent.action == Intent.ACTION_SEND_MULTIPLE) {
            IntentCompat.getParcelableArrayListExtra(intent, Intent.EXTRA_STREAM, Uri::class.java)?.let(uris::addAll)
        } else {
            IntentCompat.getParcelableExtra(intent, Intent.EXTRA_STREAM, Uri::class.java)?.let(uris::add)
        }
        val clip = intent.clipData
        val texts = mutableListOf<String>()
        if (clip != null) repeat(clip.itemCount) { index ->
            val item = clip.getItemAt(index)
            item.uri?.let(uris::add)
            item.text?.toString()?.takeIf { it.isNotBlank() }?.let(texts::add)
        }
        val text = intent.getCharSequenceExtra(Intent.EXTRA_TEXT)?.toString() ?: texts.distinct().joinToString("\n")
        // Retain unsupported schemes as failed file rows rather than silently
        // omitting them from a mixed share. The reader rejects them before I/O.
        SharedInput(text, uris.map(Uri::toString).distinct(), intent.type?.takeIf { '/' in it && '*' !in it })
    } catch (_: RuntimeException) {
        // Malformed/incorrectly typed parcelables from another application.
        SharedInput("", emptyList())
    }
}

class ContentResolverShareReader(private val resolver: ContentResolver) : ShareFileReader {
    private fun contentUri(value: String): Uri = Uri.parse(value).also {
        require(it.scheme == ContentResolver.SCHEME_CONTENT)
    }

    override fun details(uri: String, mimeTypeHint: String?): ShareFileDetails {
        val parsed = contentUri(uri)
        var name: String? = null
        var size: Long? = null
        runCatching {
            resolver.query(parsed, arrayOf(OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE), null, null, null)?.use { cursor ->
                if (cursor.moveToFirst()) {
                    val nameIndex = cursor.getColumnIndex(OpenableColumns.DISPLAY_NAME)
                    if (nameIndex >= 0 && !cursor.isNull(nameIndex)) name = cursor.getString(nameIndex)
                    val sizeIndex = cursor.getColumnIndex(OpenableColumns.SIZE)
                    if (sizeIndex >= 0 && !cursor.isNull(sizeIndex)) size = cursor.getLong(sizeIndex).takeIf { it >= 0 }
                }
            }
        }
        val filename = name?.takeIf { it.isNotBlank() } ?: "attachment"
        val mime = runCatching { resolver.getType(parsed) }.getOrNull()?.takeIf { '/' in it && '*' !in it }
            ?: MimeTypeMap.getSingleton().getMimeTypeFromExtension(filename.substringAfterLast('.', "").lowercase(Locale.ROOT))
            ?: mimeTypeHint?.takeIf { '/' in it && '*' !in it }
            ?: "application/octet-stream"
        return ShareFileDetails(filename, mime, size)
    }

    override fun open(uri: String): InputStream? = resolver.openInputStream(contentUri(uri))
}
