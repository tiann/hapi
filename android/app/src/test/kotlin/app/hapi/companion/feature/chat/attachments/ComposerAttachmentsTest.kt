package app.hapi.companion.feature.chat.attachments

import app.hapi.data.api.AttachmentUploadApi
import app.hapi.protocol.wire.DeleteUploadResponse
import app.hapi.protocol.wire.UploadFileResponse
import java.util.Base64
import kotlin.coroutines.ContinuationInterceptor
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull
import kotlin.test.assertTrue
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.test.runTest

private const val SESSION = "sess-att"

/** Scriptable two-method fake for the upload seam. */
private class FakeUploadApi : AttachmentUploadApi {
    class UploadCall(val sessionId: String, val filename: String, val contentBase64: String, val mimeType: String)

    val uploads = MutableStateFlow<List<UploadCall>>(emptyList())
    val deletes = MutableStateFlow<List<String>>(emptyList())

    /** Results consumed per call; empty ⇒ success with a derived path. */
    val results = ArrayDeque<Result<UploadFileResponse>>()

    /** When set, uploads park here until completed (in-flight state tests). */
    var gate: CompletableDeferred<Unit>? = null

    override suspend fun uploadFile(
        sessionId: String,
        filename: String,
        contentBase64: String,
        mimeType: String,
    ): UploadFileResponse {
        uploads.value = uploads.value + UploadCall(sessionId, filename, contentBase64, mimeType)
        gate?.await()
        val scripted = results.removeFirstOrNull()
            ?: Result.success(UploadFileResponse(success = true, path = "/uploads/$filename"))
        return scripted.getOrThrow()
    }

    override suspend fun deleteUpload(sessionId: String, path: String): DeleteUploadResponse {
        deletes.value = deletes.value + path
        return DeleteUploadResponse(success = true)
    }
}

private fun prepared(
    id: String = "att-1",
    filename: String = "shot.jpg",
    mimeType: String = "image/jpeg",
    bytes: ByteArray = byteArrayOf(10, 20, 30),
    previewBytes: ByteArray? = byteArrayOf(1, 2),
) = PreparedAttachment(id = id, filename = filename, mimeType = mimeType, bytes = bytes, previewBytes = previewBytes)

class ComposerAttachmentsTest {

    /**
     * Test scaffold: production shape except the base64 encode hop, which is
     * pinned to the scope's own dispatcher instead of the constructor default
     * `Dispatchers.Default`. That default is a real thread pool: with two
     * uploads in flight the second-launched one can finish encoding first and
     * reach `uploadFile` first, consuming the fake's scripted `results` deque
     * out of launch order (the queued failure stolen by the upload meant to
     * succeed) — the robbed chip then never settles to its scripted state and
     * `items.first {}` hangs until runTest's dispatch timeout
     * (`UncompletedCoroutinesError`, observed intermittently under suite
     * load). Keeping the hop on the runTest scheduler makes upload arrival
     * order equal launch order deterministically, while `upload` still hops
     * dispatchers exactly as in production. The `Dispatchers.Default`
     * fallback only covers scopes whose interceptor is not a dispatcher.
     */
    private fun harness(scope: kotlinx.coroutines.CoroutineScope, api: FakeUploadApi) =
        ComposerAttachments(
            api = api,
            sessionId = SESSION,
            scope = scope,
            detachedCleanupScope = scope,
            encodeDispatcher = scope.coroutineContext[ContinuationInterceptor] as? CoroutineDispatcher
                ?: Dispatchers.Default,
        )

    @Test
    fun `add uploads immediately with the exact base64 payload and settles Ready`() = runTest {
        val api = FakeUploadApi()
        val tray = harness(backgroundScope, api)

        tray.add(prepared(bytes = byteArrayOf(10, 20, 30)))

        val chip = tray.items.first { it.size == 1 && it[0].status == ComposerAttachmentStatus.Ready }[0]
        assertEquals("shot.jpg", chip.filename)
        assertEquals(3L, chip.sizeBytes)

        val call = api.uploads.value.single()
        assertEquals(SESSION, call.sessionId)
        assertEquals("shot.jpg", call.filename)
        assertEquals("image/jpeg", call.mimeType)
        assertEquals(Base64.getEncoder().encodeToString(byteArrayOf(10, 20, 30)), call.contentBase64)
        assertTrue(tray.allReady())
    }

    @Test
    fun `consume maps Ready chips to metadata with a preview data URL and clears the tray`() = runTest {
        val api = FakeUploadApi()
        val tray = harness(backgroundScope, api)
        tray.add(prepared(previewBytes = byteArrayOf(9, 9)))
        tray.items.first { it.size == 1 && it[0].status == ComposerAttachmentStatus.Ready }

        val metadata = tray.consume()!!.single()

        assertEquals("att-1", metadata.id)
        assertEquals("shot.jpg", metadata.filename)
        assertEquals("image/jpeg", metadata.mimeType)
        assertEquals(3L, metadata.size)
        assertEquals("/uploads/shot.jpg", metadata.path)
        assertEquals(AttachmentPolicy.dataUrl("image/jpeg", byteArrayOf(9, 9)), metadata.previewUrl)
        assertTrue(tray.items.first { it.isEmpty() }.isEmpty())
        assertNull(tray.consume())
    }

    @Test
    fun `upload failure settles Failed and retry re-uploads to Ready`() = runTest {
        val api = FakeUploadApi()
        api.results += Result.failure(RuntimeException("boom"))
        val tray = harness(backgroundScope, api)

        tray.add(prepared())
        tray.items.first { it.size == 1 && it[0].status == ComposerAttachmentStatus.Failed }
        assertTrue(tray.hasUnsettled())

        tray.retry("att-1")
        tray.items.first { it.size == 1 && it[0].status == ComposerAttachmentStatus.Ready }
        assertEquals(2, api.uploads.value.size)
        assertEquals(api.uploads.value[0].contentBase64, api.uploads.value[1].contentBase64)
    }

    @Test
    fun `concurrent uploads take scripted results in launch order`() = runTest {
        // Regression lock for the scheduler pin in `harness`: the fake's
        // scripted `results` deque is consumed by uploadFile arrival order,
        // which must equal launch order. With the production
        // Dispatchers.Default encode hop the second upload can reach the
        // fake first, steal the queued success, and flip which chip settles
        // Ready (surfaced as an UncompletedCoroutinesError flake when the
        // first chip then never matches the awaited state).
        val api = FakeUploadApi().apply {
            results += Result.success(UploadFileResponse(success = true, path = "/uploads/ok.jpg"))
            results += Result.failure(RuntimeException("boom"))
        }
        val tray = harness(backgroundScope, api)
        tray.add(prepared(id = "first", filename = "ok.jpg"))
        tray.add(prepared(id = "second", filename = "bad.jpg"))

        val settled = tray.items.first { list ->
            list.size == 2 && list.all { it.status != ComposerAttachmentStatus.Uploading }
        }

        assertEquals(
            listOf(
                ComposerAttachmentStatus.Ready to "first",
                ComposerAttachmentStatus.Failed to "second",
            ),
            settled.map { it.status to it.id },
        )
    }

    @Test
    fun `success=false responses settle Failed too`() = runTest {
        val api = FakeUploadApi()
        api.results += Result.success(UploadFileResponse(success = false, error = "disk full"))
        val tray = harness(backgroundScope, api)

        tray.add(prepared())
        tray.items.first { it.size == 1 && it[0].status == ComposerAttachmentStatus.Failed }
    }

    @Test
    fun `removing a Ready chip deletes the hub upload best-effort`() = runTest {
        val api = FakeUploadApi()
        val tray = harness(backgroundScope, api)
        tray.add(prepared())
        tray.items.first { it.size == 1 && it[0].status == ComposerAttachmentStatus.Ready }

        tray.remove("att-1")

        tray.items.first { it.isEmpty() }
        assertEquals(listOf("/uploads/shot.jpg"), api.deletes.first { it.isNotEmpty() })
    }

    @Test
    fun `removing a chip mid-upload deletes the orphan once the upload lands`() = runTest {
        val api = FakeUploadApi()
        val gate = CompletableDeferred<Unit>()
        api.gate = gate
        val tray = harness(backgroundScope, api)

        tray.add(prepared())
        api.uploads.first { it.isNotEmpty() } // upload started, parked on the gate
        tray.remove("att-1")
        tray.items.first { it.isEmpty() }
        gate.complete(Unit)

        // The late-arriving path is deleted, and the chip never reappears.
        assertEquals(listOf("/uploads/shot.jpg"), api.deletes.first { it.isNotEmpty() })
        assertTrue(tray.items.value.isEmpty())
    }

    @Test
    fun `consume takes only Ready chips and leaves unsettled ones in the tray`() = runTest {
        val api = FakeUploadApi()
        api.results += Result.failure(RuntimeException("boom"))
        val tray = harness(backgroundScope, api)
        tray.add(prepared(id = "bad", filename = "bad.bin", mimeType = "application/octet-stream", previewBytes = null))
        tray.items.first { list -> list.any { it.status == ComposerAttachmentStatus.Failed } }
        tray.add(prepared(id = "good", filename = "good.jpg"))
        tray.items.first { list -> list.any { it.id == "good" && it.status == ComposerAttachmentStatus.Ready } }

        val metadata = tray.consume()!!

        assertEquals(listOf("good"), metadata.map { it.id })
        assertEquals(listOf("bad"), tray.items.first { it.size == 1 }.map { it.id })
    }

    @Test
    fun `discardAllDetached deletes every uploaded path and empties the tray`() = runTest {
        val api = FakeUploadApi()
        val tray = harness(backgroundScope, api)
        tray.add(prepared(id = "a", filename = "a.jpg"))
        tray.add(prepared(id = "b", filename = "b.jpg"))
        tray.items.first { list -> list.size == 2 && list.all { it.status == ComposerAttachmentStatus.Ready } }

        tray.discardAllDetached()

        assertEquals(
            setOf("/uploads/a.jpg", "/uploads/b.jpg"),
            api.deletes.first { it.size == 2 }.toSet(),
        )
        // `items` is derived from the entries flow — await the propagation.
        assertTrue(tray.items.first { it.isEmpty() }.isEmpty())
    }

    // ---------------------------------------------------------- drafts v2 --

    @Test
    fun `draftRefs lists only Ready chips and encodes preview data URLs`() = runTest {
        val api = FakeUploadApi()
        api.results += Result.failure(RuntimeException("boom"))
        val tray = harness(backgroundScope, api)
        tray.add(prepared(id = "bad", filename = "bad.bin", previewBytes = null))
        tray.items.first { list -> list.any { it.status == ComposerAttachmentStatus.Failed } }
        tray.add(prepared(id = "good", filename = "good.jpg", previewBytes = byteArrayOf(9, 9)))
        tray.items.first { list -> list.any { it.id == "good" && it.status == ComposerAttachmentStatus.Ready } }

        val refs = tray.draftRefs()

        assertEquals(listOf("good"), refs.map { it.id })
        assertEquals("/uploads/good.jpg", refs.single().path)
        assertEquals(AttachmentPolicy.dataUrl("image/jpeg", byteArrayOf(9, 9)), refs.single().previewUrl)
        assertTrue(tray.items.value.isNotEmpty(), "draftRefs must not consume the tray")
    }

    @Test
    fun `draftRefs on an empty or all-unsettled tray is empty`() = runTest {
        val api = FakeUploadApi()
        val tray = harness(backgroundScope, api)

        assertTrue(tray.draftRefs().isEmpty())
    }

    @Test
    fun `restoreDraftAttachments appends Ready chips that consume back to the stored path`() = runTest {
        val api = FakeUploadApi()
        val tray = harness(backgroundScope, api)

        tray.restoreDraftAttachments(
            listOf(
                ComposerDraftAttachment(
                    id = "restored", filename = "old.jpg", mimeType = "image/jpeg", sizeBytes = 3,
                    path = "/uploads/old.jpg",
                    previewUrl = AttachmentPolicy.dataUrl("image/jpeg", byteArrayOf(4, 5)),
                )
            )
        )

        val chip = tray.items.first { list -> list.size == 1 }[0]
        assertEquals(ComposerAttachmentStatus.Ready, chip.status)
        assertTrue(chip.previewBytes!!.contentEquals(byteArrayOf(4, 5)))
        assertTrue(tray.allReady())

        // A restored chip is sendable as-is: no re-upload, the stored path rides.
        val metadata = tray.consume()!!.single()
        assertEquals("/uploads/old.jpg", metadata.path)
        assertEquals("old.jpg", metadata.filename)
        assertEquals(3L, metadata.size)
        assertTrue(api.uploads.value.isEmpty(), "restore must not re-upload")
    }

    @Test
    fun `restoreDraftAttachments skips duplicate ids and path-less references`() = runTest {
        val api = FakeUploadApi()
        val tray = harness(backgroundScope, api)
        tray.add(prepared(id = "dup", filename = "dup.jpg"))
        tray.items.first { list -> list.size == 1 && list[0].status == ComposerAttachmentStatus.Ready }

        tray.restoreDraftAttachments(
            listOf(
                ComposerDraftAttachment("dup", "dup.jpg", "image/jpeg", 3, path = "/uploads/dup.jpg"),
                ComposerDraftAttachment("nopath", "n.jpg", "image/jpeg", 1, path = null),
                ComposerDraftAttachment("fresh", "f.jpg", "image/jpeg", 2, path = "/uploads/f.jpg"),
            )
        )

        val ids = tray.items.first { list -> list.size == 2 }.map { it.id }
        assertEquals(listOf("dup", "fresh"), ids)
        assertEquals(1, api.uploads.value.size, "only the original add uploaded")
    }

    @Test
    fun `discardAllKeepingUploads empties the tray without hub deletes`() = runTest {
        val api = FakeUploadApi()
        val tray = harness(backgroundScope, api)
        tray.add(prepared(id = "a", filename = "a.jpg"))
        tray.items.first { list -> list.size == 1 && list[0].status == ComposerAttachmentStatus.Ready }

        tray.discardAllKeepingUploads()

        assertTrue(tray.items.first { it.isEmpty() }.isEmpty())
        assertTrue(api.deletes.value.isEmpty(), "the persisted references own the upload now")
    }
}
