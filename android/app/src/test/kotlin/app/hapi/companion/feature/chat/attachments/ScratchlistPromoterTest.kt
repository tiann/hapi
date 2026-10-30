package app.hapi.companion.feature.chat.attachments

import app.hapi.data.api.ScratchlistAttachmentFile
import app.hapi.protocol.wire.ScratchlistAttachment
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue
import kotlinx.coroutines.test.runTest

private const val SESSION = "sess-promote"

/** Recording fetcher: null result for the ids in [failing]. */
private class FakeFetcher(private val bytes: ByteArray = byteArrayOf(1, 2, 3, 4)) {
    val calls = mutableListOf<String>()
    var failing: Set<String> = emptySet()

    val seam = ScratchlistPromoter.AttachmentFetcher { _, attachmentId ->
        calls += attachmentId
        if (attachmentId in failing) null else ScratchlistAttachmentFile(bytes, "image/jpeg")
    }
}

private class FakeUploader {
    data class Call(val filename: String, val bytes: ByteArray, val mimeType: String)

    val calls = mutableListOf<Call>()
    var failing: Set<String> = emptySet()

    val seam = ScratchlistPromoter.ChatUploader { _, filename, bytes, mimeType ->
        calls += Call(filename, bytes, mimeType)
        if (filename in failing) null else "/uploads/$filename"
    }
}

private class FakeDeleter {
    val paths = mutableListOf<String>()

    val seam = ScratchlistPromoter.ChatUploadDeleter { _, path -> paths += path }
}

private fun attachment(id: String, filename: String = "$id.png", mimeType: String = "image/png", size: Long = 4) =
    ScratchlistAttachment(
        id = id,
        filename = filename,
        mimeType = mimeType,
        size = size,
        path = "hapi-hub:scratchlist/$id",
    )

class ScratchlistPromoterTest {

    // ------------------------------------------------------ queue staging --

    @Test
    fun `staging re-uploads every hub blob through the chat pipeline in order`() = runTest {
        val fetcher = FakeFetcher()
        val uploader = FakeUploader()
        val deleter = FakeDeleter()
        val attachments = listOf(
            attachment("a1", "shot.png", "image/png", size = 4),
            attachment("a2", "notes.txt", "text/plain", size = 4),
        )

        val staged = ScratchlistPromoter.stageForQueueSend(
            SESSION, attachments, fetcher.seam, uploader.seam, deleter.seam,
        )

        assertEquals(listOf("a1", "a2"), fetcher.calls)
        assertEquals(listOf("shot.png", "notes.txt"), uploader.calls.map { it.filename })
        assertTrue(deleter.paths.isEmpty(), "no rollback on success")
        val metadata = assertNotNull(staged)
        assertEquals(listOf("a1", "a2"), metadata.map { it.id })
        assertEquals(listOf("/uploads/shot.png", "/uploads/notes.txt"), metadata.map { it.path })
        assertEquals(listOf(4L, 4L), metadata.map { it.size })
    }

    @Test
    fun `staging embeds a data URL preview only for small images`() = runTest {
        val fetcher = FakeFetcher()
        val uploader = FakeUploader()
        val deleter = FakeDeleter()
        val attachments = listOf(
            attachment("small-image", size = 5L * 1024 * 1024),
            attachment("big-image", mimeType = "image/png", size = 5L * 1024 * 1024 + 1),
            attachment("small-pdf", "doc.pdf", "application/pdf", size = 4),
        )

        val staged = ScratchlistPromoter.stageForQueueSend(
            SESSION, attachments, fetcher.seam, uploader.seam, deleter.seam,
        )!!

        assertTrue(staged[0].previewUrl!!.startsWith("data:image/png;base64,"))
        assertNull(staged[1].previewUrl)
        assertNull(staged[2].previewUrl)
    }

    @Test
    fun `a failed upload rolls back the already-staged uploads and fails the stage`() = runTest {
        val fetcher = FakeFetcher()
        val uploader = FakeUploader().apply { failing = setOf("b.png") }
        val deleter = FakeDeleter()

        val staged = ScratchlistPromoter.stageForQueueSend(
            SESSION,
            listOf(attachment("a1", "a.png"), attachment("b", "b.png")),
            fetcher.seam, uploader.seam, deleter.seam,
        )

        assertNull(staged)
        assertEquals(listOf("/uploads/a.png"), deleter.paths)
    }

    @Test
    fun `a failed blob fetch aborts the stage with rollback`() = runTest {
        val fetcher = FakeFetcher().apply { failing = setOf("b") }
        val uploader = FakeUploader()
        val deleter = FakeDeleter()

        val staged = ScratchlistPromoter.stageForQueueSend(
            SESSION,
            listOf(attachment("a1", "a.png"), attachment("b", "b.png")),
            fetcher.seam, uploader.seam, deleter.seam,
        )

        assertNull(staged)
        assertEquals(listOf("/uploads/a.png"), deleter.paths)
    }

    @Test
    fun `an empty attachment list stages to an empty metadata list`() = runTest {
        val staged = ScratchlistPromoter.stageForQueueSend(
            SESSION, emptyList(), FakeFetcher().seam, FakeUploader().seam, FakeDeleter().seam,
        )
        assertEquals(emptyList(), staged)
    }

    // ---------------------------------------------------- rehydration --

    @Test
    fun `rehydration turns every fetched blob into a composer pick`() = runTest {
        val fetcher = FakeFetcher()
        val picks = listOf("a1", "a2").associateWith { PreparedAttachment(id = it, filename = "$it.png", mimeType = "image/png", bytes = byteArrayOf(7)) }
        val preparer = ScratchlistPromoter.PickPreparer { attachment, _, _ -> picks[attachment.id] }

        val result = ScratchlistPromoter.rehydrateToComposer(
            SESSION,
            listOf(attachment("a1"), attachment("a2")),
            fetcher.seam,
            preparer,
        )

        assertEquals(listOf("a1", "a2"), result.map { it.id })
    }

    @Test
    fun `rehydration skips failed fetches and policy rejections but keeps the rest`() = runTest {
        val fetcher = FakeFetcher().apply { failing = setOf("a2") }
        val preparer = ScratchlistPromoter.PickPreparer { attachment, _, _ ->
            if (attachment.id == "a3") null
            else PreparedAttachment(id = attachment.id, filename = attachment.filename, mimeType = attachment.mimeType, bytes = byteArrayOf(1))
        }

        val result = ScratchlistPromoter.rehydrateToComposer(
            SESSION,
            listOf(attachment("a1"), attachment("a2"), attachment("a3")),
            fetcher.seam,
            preparer,
        )

        assertEquals(listOf("a1"), result.map { it.id })
    }

    @Test
    fun `rehydration without attachments returns an empty pick list`() = runTest {
        val result = ScratchlistPromoter.rehydrateToComposer(
            SESSION, emptyList(), FakeFetcher().seam,
            ScratchlistPromoter.PickPreparer { _, _, _ -> error("unused") },
        )
        assertEquals(emptyList(), result)
    }
}
