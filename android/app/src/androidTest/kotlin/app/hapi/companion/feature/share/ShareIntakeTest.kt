package app.hapi.companion.feature.share

import android.content.ClipData
import android.content.Intent
import android.net.Uri
import androidx.core.content.FileProvider
import androidx.test.platform.app.InstrumentationRegistry
import app.hapi.companion.feature.chat.attachments.AttachmentPreparer
import app.hapi.companion.feature.chat.attachments.PrepareResult
import java.io.File
import java.util.UUID
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import org.junit.Assert.*
import org.junit.Test

class ShareIntakeTest {
    private val context = InstrumentationRegistry.getInstrumentation().targetContext

    @Test fun streamAndClipUrisAreDeduplicatedWithoutDuplicatingTheCaption() {
        val first = Uri.parse("content://source/first")
        val second = Uri.parse("content://source/second")
        val intent = Intent(Intent.ACTION_SEND_MULTIPLE).apply {
            type = "*/*"
            putParcelableArrayListExtra(Intent.EXTRA_STREAM, arrayListOf(first, second))
            putExtra(Intent.EXTRA_TEXT, "explain these files")
            clipData = ClipData.newUri(context.contentResolver, "files", first).apply {
                addItem(ClipData.Item(second))
                addItem(ClipData.Item("explain these files"))
            }
        }
        assertEquals(SharedInput("explain these files", listOf(first.toString(), second.toString())), parseSharedIntent(intent))
    }

    @Test fun singleStreamClipOnlyAndTextOnlySharesUseTheSameParser() {
        val uri = Uri.parse("content://source/first")
        assertEquals(listOf(uri.toString()), parseSharedIntent(Intent(Intent.ACTION_SEND).putExtra(Intent.EXTRA_STREAM, uri))!!.uris)
        assertEquals(listOf(uri.toString()), parseSharedIntent(Intent(Intent.ACTION_SEND).apply {
            clipData = ClipData.newUri(context.contentResolver, "files", uri)
        })!!.uris)
        assertEquals("https://example.com/page", parseSharedIntent(Intent(Intent.ACTION_SEND).apply {
            clipData = ClipData.newPlainText("link", "https://example.com/page")
        })!!.text)
        assertNull(parseSharedIntent(Intent(Intent.ACTION_VIEW, uri)))
        assertTrue(parseSharedIntent(Intent(Intent.ACTION_SEND))!!.isEmpty)
    }

    @Test fun concreteIntentMimeTypeIsAvailableWhenAProviderHasNoMetadata() {
        val uri = Uri.parse("content://missing.provider/file")
        val parsed = parseSharedIntent(Intent(Intent.ACTION_SEND).apply {
            type = "image/png"
            putExtra(Intent.EXTRA_STREAM, uri)
        })!!
        assertEquals("image/png", parsed.mimeType)
        assertEquals("image/png", ContentResolverShareReader(context.contentResolver).details(uri.toString(), parsed.mimeType).mimeType)
        assertNull(parseSharedIntent(Intent(Intent.ACTION_SEND).setType("image/*"))!!.mimeType)
    }

    @Test fun localStagingSurvivesSourceDeletionAndPreservesMetadataForThePreparer() = runBlocking {
        val directory = File(context.cacheDir, "attachments").apply { mkdirs() }
        val original = File(directory, "share-intake-${UUID.randomUUID()}.txt").apply { writeText("shared bytes") }
        val root = File(context.noBackupFilesDir, "share-intake-test-${UUID.randomUUID()}")
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
        try {
            val reader = ContentResolverShareReader(context.contentResolver)
            val uri = FileProvider.getUriForFile(context, "${context.packageName}.attachments", original)
            val inbox = ShareInbox(root, reader, scope)
            val id = inbox.receive(SharedInput("caption", listOf(uri.toString())))
            val batch = withTimeout(45_000) { inbox.batches.first { it.singleOrNull()?.canImport == true }.single() }
            val file = batch.files.single()
            assertEquals(original.name, file.filename)
            assertEquals("text/plain", file.mimeType)
            assertTrue(original.delete())
            val restored = ShareInbox(root, reader, scope)
            restored.load()
            val prepared = AttachmentPreparer(context).prepare(restored.file(id, file.id), file.filename, file.mimeType, file.id)
            assertTrue(prepared is PrepareResult.Ready)
            val attachment = (prepared as PrepareResult.Ready).attachment
            assertEquals(file.id, attachment.id)
            assertEquals(original.name, attachment.filename)
            assertArrayEquals("shared bytes".toByteArray(), attachment.bytes)
        } finally {
            scope.cancel()
            original.delete()
            root.deleteRecursively()
        }
    }

    @Test fun unsupportedFileUrisStayVisibleAsErrorsAndAreNeverOpened() = runBlocking {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
        val root = File(context.noBackupFilesDir, "share-intake-test-${UUID.randomUUID()}")
        try {
            val uri = Uri.parse("file:///data/data/${context.packageName}/files/private.txt")
            val parsed = parseSharedIntent(Intent(Intent.ACTION_SEND).putExtra(Intent.EXTRA_STREAM, uri))!!
            val inbox = ShareInbox(root, ContentResolverShareReader(context.contentResolver), scope)
            inbox.receive(parsed)
            val batch = withTimeout(45_000) { inbox.batches.first { it.firstOrNull()?.files?.singleOrNull()?.status == SharedFileStatus.Unreadable }.single() }
            assertFalse(batch.canImport)
            assertFalse(inbox.file(batch.id, batch.files.single().id).exists())
        } finally {
            scope.cancel()
            root.deleteRecursively()
        }
    }
}
