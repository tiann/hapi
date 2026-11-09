package app.hapi.companion.feature.files

import android.content.Context
import android.content.Intent
import android.net.Uri
import androidx.activity.result.contract.ActivityResultContract
import java.io.IOException
import kotlin.coroutines.cancellation.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

/**
 * One completed in-memory file fetch waiting to be saved — the Android analog
 * of the web's `downloadBase64File` blob hand-off (web `lib/file-download.ts`:
 * decode → Blob → object URL → `<a download>`; the browser owns the save). On
 * Android the Storage Access Framework owns it: the UI launches
 * [CreateDocumentNamed] with this payload's mime + name, then writes [bytes]
 * to the returned Uri. No storage permission is needed (`CreateDocument`
 * route, available from the app's minSdk 26).
 */
data class FileDownload(
    val fileName: String,
    val mimeType: String,
    val bytes: ByteArray,
)

/**
 * `ACTION_CREATE_DOCUMENT` with both inputs the files feature needs: the
 * contract input is (mime type, suggested file name) — the stock
 * `ActivityResultContracts.CreateDocument` bakes the mime in at registration,
 * which cannot vary per file.
 */
class CreateDocumentNamed : ActivityResultContract<Pair<String, String>, Uri?>() {
    override fun createIntent(context: Context, input: Pair<String, String>): Intent =
        Intent(Intent.ACTION_CREATE_DOCUMENT)
            .addCategory(Intent.CATEGORY_OPENABLE)
            .setTypeAndNormalize(input.first)
            .putExtra(Intent.EXTRA_TITLE, input.second)

    override fun parseResult(resultCode: Int, intent: Intent?): Uri? =
        intent?.data
}

object FileDownloads {

    /** Web `downloadBase64File` default when no mime is passed (directory rows). */
    const val FALLBACK_MIME = "application/octet-stream"

    /**
     * Web viewer parity (`file.tsx`): image extensions get their real mime,
     * everything else downloads as `application/octet-stream`.
     */
    fun downloadMimeType(path: String): String =
        FileViewerViewModel.imageMimeType(path) ?: FALLBACK_MIME

    /**
     * Writes [bytes] to the SAF-chosen [uri] (openOutputStream on IO
     * dispatchers). False on any write failure — callers surface the shared
     * download-failed message.
     */
    suspend fun writeTo(context: Context, uri: Uri, bytes: ByteArray): Boolean = try {
        withContext(Dispatchers.IO) {
            context.contentResolver.openOutputStream(uri)?.use { it.write(bytes) } != null
        }
    } catch (e: CancellationException) {
        throw e
    } catch (_: IOException) {
        false
    } catch (_: SecurityException) {
        false
    }
}
