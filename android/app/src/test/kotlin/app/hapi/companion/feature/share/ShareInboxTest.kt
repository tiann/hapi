package app.hapi.companion.feature.share

import app.hapi.companion.feature.chat.attachments.AttachmentPolicy
import app.hapi.protocol.wire.HapiJson
import java.io.ByteArrayInputStream
import java.io.File
import java.io.InputStream
import java.util.UUID
import kotlin.test.Test
import kotlin.test.assertContentEquals
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.builtins.ListSerializer
import org.junit.Rule
import org.junit.rules.TemporaryFolder

private class TestShareReader : ShareFileReader {
    var metadata = ShareFileDetails("../../private.txt", "text/plain")
    var fail = false
    var openCount = 0
    var input: () -> InputStream = { ByteArrayInputStream(byteArrayOf(1, 2, 3)) }
    override fun details(uri: String, mimeTypeHint: String?): ShareFileDetails = metadata
    override fun open(uri: String): InputStream {
        openCount++
        if (fail) throw SecurityException("permission expired")
        return input()
    }
}

class ShareInboxTest {
    @get:Rule val tmp = TemporaryFolder()

    @Test fun `streams deduplicated payloads to generated paths and restores the selected target`() = runTest {
        val reader = TestShareReader()
        val dispatcher = StandardTestDispatcher(testScheduler)
        val root = tmp.newFolder()
        val inbox = ShareInbox(root, reader, backgroundScope, dispatcher)
        val id = inbox.receive(SharedInput("explain", listOf("content://one", "content://one", "content://two")))
        testScheduler.runCurrent()
        val batch = inbox.batches.value.single()
        assertEquals(2, batch.files.size)
        assertTrue(batch.canImport)
        assertEquals(2, reader.openCount)
        assertContentEquals(byteArrayOf(1, 2, 3), inbox.file(id, batch.files.first().id).readBytes())
        assertFalse(File(root.parentFile, "private.txt").exists())
        val target = ShareTarget("https://b.example", "new-session")
        inbox.setTarget(id, target)
        val restored = ShareInbox(root, reader, backgroundScope, dispatcher)
        restored.load()
        assertEquals(target, restored.batches.value.single().target)
        assertEquals("explain", restored.batches.value.single().text)
        restored.discard(id)
        assertTrue(restored.batches.value.isEmpty())
        assertFalse(inbox.file(id, batch.files.first().id).exists())
    }

    @Test fun `failed content remains visible and can be retried or removed`() = runTest {
        val reader = TestShareReader().apply { fail = true }
        val inbox = ShareInbox(tmp.newFolder(), reader, backgroundScope, StandardTestDispatcher(testScheduler))
        val id = inbox.receive(SharedInput("", listOf("content://one")))
        testScheduler.runCurrent()
        val fileId = inbox.batches.value.single().files.single().id
        assertEquals(SharedFileStatus.Unreadable, inbox.batches.value.single().files.single().status)
        assertFalse(inbox.batches.value.single().canImport)
        reader.fail = false
        inbox.retry(id, fileId)
        testScheduler.runCurrent()
        assertTrue(inbox.batches.value.single().canImport)
        inbox.removeFile(id, fileId)
        assertFalse(inbox.batches.value.single().canImport)
        assertFalse(inbox.file(id, fileId).exists())
    }

    @Test fun `declared oversize rejects before opening but large compressible images may be staged`() = runTest {
        val reader = TestShareReader().apply {
            metadata = ShareFileDetails("huge.bin", "application/octet-stream", AttachmentPolicy.MAX_UPLOAD_BYTES + 1)
        }
        val inbox = ShareInbox(tmp.newFolder(), reader, backgroundScope, StandardTestDispatcher(testScheduler))
        inbox.receive(SharedInput("", listOf("content://one")))
        testScheduler.runCurrent()
        assertEquals(SharedFileStatus.TooLarge, inbox.batches.value.single().files.single().status)
        assertEquals(0, reader.openCount)
        reader.metadata = ShareFileDetails("photo.jpg", "image/jpeg", AttachmentPolicy.MAX_UPLOAD_BYTES + 1)
        val batch = inbox.batches.value.single()
        inbox.retry(batch.id, batch.files.single().id)
        testScheduler.runCurrent()
        assertTrue(inbox.batches.value.single().canImport)
    }

    @Test fun `actual bytes enforce the cap even when the provider lies about size`() = runTest {
        val reader = TestShareReader().apply {
            metadata = ShareFileDetails("huge.bin", "application/octet-stream", 1)
            input = { object : InputStream() {
                var remaining = AttachmentPolicy.MAX_UPLOAD_BYTES + 1
                override fun read(): Int = if (remaining-- > 0) 0 else -1
                override fun read(buffer: ByteArray, offset: Int, length: Int): Int {
                    if (remaining <= 0) return -1
                    val count = minOf(remaining, length.toLong()).toInt()
                    remaining -= count
                    return count
                }
            } }
        }
        val root = tmp.newFolder()
        val inbox = ShareInbox(root, reader, backgroundScope, StandardTestDispatcher(testScheduler))
        inbox.receive(SharedInput("", listOf("content://one")))
        testScheduler.runCurrent()
        val batch = inbox.batches.value.single()
        assertEquals(SharedFileStatus.TooLarge, batch.files.single().status)
        assertFalse(inbox.file(batch.id, batch.files.single().id).exists())
        assertTrue(File(root, batch.id).listFiles().orEmpty().isEmpty())
    }

    @Test fun `interrupted copies restore as errors and missing ready payloads are not silently imported`() = runTest {
        val root = tmp.newFolder()
        val batchId = UUID.randomUUID().toString()
        val pending = PendingShare(batchId, 1_000, "", listOf(
            SharedFile(UUID.randomUUID().toString(), "content://one", "one"),
            SharedFile(UUID.randomUUID().toString(), "content://two", "two", status = SharedFileStatus.Ready),
        ))
        File(root, "inbox.json").writeText(HapiJson.encodeToString(ListSerializer(PendingShare.serializer()), listOf(pending)))
        val inbox = ShareInbox(root, TestShareReader(), backgroundScope, StandardTestDispatcher(testScheduler), now = { 2_000 })
        inbox.load()
        assertEquals(listOf(SharedFileStatus.Interrupted, SharedFileStatus.Unreadable), inbox.batches.value.single().files.map { it.status })
        assertFalse(inbox.batches.value.single().canImport)
    }

    @Test fun `new shares do not overwrite pending content and replacement cleans unselected payloads`() = runTest {
        val inbox = ShareInbox(tmp.newFolder(), TestShareReader(), backgroundScope, StandardTestDispatcher(testScheduler))
        val first = inbox.receive(SharedInput("first", listOf("content://one")))
        val second = inbox.receive(SharedInput("second", emptyList()))
        testScheduler.runCurrent()
        val fileId = inbox.batches.value.first().files.single().id
        assertEquals(listOf(first, second), inbox.batches.value.map { it.id })
        inbox.keepOnly(second)
        assertEquals(listOf(second), inbox.batches.value.map { it.id })
        assertFalse(inbox.file(first, fileId).exists())
    }

    @Test fun `old unprocessed batches expire on receive and on process restore`() = runTest {
        val root = tmp.newFolder()
        var now = 1_000L
        val dispatcher = StandardTestDispatcher(testScheduler)
        val inbox = ShareInbox(root, TestShareReader(), backgroundScope, dispatcher, now = { now })
        inbox.receive(SharedInput("old", emptyList()))
        now += ShareInbox.RETENTION_MS + 1
        val current = inbox.receive(SharedInput("new", emptyList()))
        assertEquals(listOf(current), inbox.batches.value.map { it.id })
        now += ShareInbox.RETENTION_MS + 1
        val restored = ShareInbox(root, TestShareReader(), backgroundScope, dispatcher, now = { now })
        restored.load()
        assertTrue(restored.batches.value.isEmpty())
    }

    @Test fun `corrupt journals are reported without preventing a new share`() = runTest {
        val root = tmp.newFolder()
        File(root, "inbox.json").writeText("{broken")
        var failures = 0
        val inbox = ShareInbox(root, TestShareReader(), backgroundScope, StandardTestDispatcher(testScheduler),
            onFailure = { failures++ })
        inbox.load()
        assertEquals(1, failures)
        inbox.receive(SharedInput("new share", emptyList()))
        assertEquals("new share", inbox.batches.value.single().text)
    }

    @Test fun `journal failure during a copy leaves an actionable in-memory error and a recoverable record`() = runTest {
        val root = tmp.newFolder()
        var failures = 0
        val reader = TestShareReader().apply {
            input = {
                // Simulate storage becoming unwritable after initial intake.
                File(root, "inbox.json.tmp").mkdir()
                ByteArrayInputStream(byteArrayOf(1))
            }
        }
        val dispatcher = StandardTestDispatcher(testScheduler)
        val inbox = ShareInbox(root, reader, backgroundScope, dispatcher, onFailure = { failures++ })
        inbox.receive(SharedInput("", listOf("content://one")))
        testScheduler.runCurrent()
        assertEquals(1, failures)
        assertEquals(SharedFileStatus.Unreadable, inbox.batches.value.single().files.single().status)
        assertFalse(inbox.batches.value.single().canImport)
        File(root, "inbox.json.tmp").delete()
        val restored = ShareInbox(root, reader, backgroundScope, dispatcher)
        restored.load()
        assertEquals(SharedFileStatus.Interrupted, restored.batches.value.single().files.single().status)
    }
}
