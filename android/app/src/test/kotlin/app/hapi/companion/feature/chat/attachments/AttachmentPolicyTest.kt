package app.hapi.companion.feature.chat.attachments

import app.hapi.companion.feature.chat.attachments.AttachmentPolicy.Plan
import kotlin.test.Test
import kotlin.test.assertContentEquals
import kotlin.test.assertEquals
import kotlin.test.assertNull

private const val MB = 1024L * 1024

/** Pure compression/sizing decisions (B-M3f) — the preparer defers to these. */
class AttachmentPolicyTest {

    // ------------------------------------------------------------- planFor --

    @Test
    fun `small files of any type keep their original bytes`() {
        assertEquals(Plan.KeepOriginal, AttachmentPolicy.planFor("image/jpeg", 3 * MB))
        assertEquals(Plan.KeepOriginal, AttachmentPolicy.planFor("application/pdf", 20 * MB))
        assertEquals(Plan.KeepOriginal, AttachmentPolicy.planFor("text/plain", 10))
    }

    @Test
    fun `images over the 4MB threshold are compressed`() {
        assertEquals(Plan.CompressImage, AttachmentPolicy.planFor("image/jpeg", 5 * MB))
        assertEquals(Plan.CompressImage, AttachmentPolicy.planFor("image/png", 12 * MB))
        assertEquals(Plan.CompressImage, AttachmentPolicy.planFor("image/webp", 4 * MB + 1))
        // Case-insensitive mime match.
        assertEquals(Plan.CompressImage, AttachmentPolicy.planFor("image/JPEG", 5 * MB))
    }

    @Test
    fun `images at exactly the threshold stay original`() {
        assertEquals(Plan.KeepOriginal, AttachmentPolicy.planFor("image/jpeg", 4 * MB))
    }

    @Test
    fun `oversized recompressible images are still compressed, not rejected`() {
        // Downscaling brings any camera photo far under the cap; the preparer
        // re-checks the compressed size against the 50 MB contract.
        assertEquals(Plan.CompressImage, AttachmentPolicy.planFor("image/jpeg", 60 * MB))
    }

    @Test
    fun `oversized non-recompressible files are rejected`() {
        assertEquals(Plan.Reject, AttachmentPolicy.planFor("application/zip", 51 * MB))
        assertEquals(Plan.Reject, AttachmentPolicy.planFor("video/mp4", 200 * MB))
        // GIF recompression would drop animation — over-cap GIFs reject.
        assertEquals(Plan.Reject, AttachmentPolicy.planFor("image/gif", 51 * MB))
    }

    @Test
    fun `files at exactly 50MB pass`() {
        assertEquals(Plan.KeepOriginal, AttachmentPolicy.planFor("application/zip", 50 * MB))
    }

    @Test
    fun `gifs under the cap keep original bytes regardless of size`() {
        assertEquals(Plan.KeepOriginal, AttachmentPolicy.planFor("image/gif", 30 * MB))
    }

    @Test
    fun `read cap allows oversized sources only for recompressible images`() {
        assertEquals(AttachmentPolicy.MAX_IMAGE_SOURCE_BYTES, AttachmentPolicy.readCapFor("image/jpeg"))
        assertEquals(AttachmentPolicy.MAX_UPLOAD_BYTES, AttachmentPolicy.readCapFor("image/gif"))
        assertEquals(AttachmentPolicy.MAX_UPLOAD_BYTES, AttachmentPolicy.readCapFor("video/mp4"))
        assertEquals(AttachmentPolicy.MAX_UPLOAD_BYTES, AttachmentPolicy.readCapFor("application/pdf"))
    }

    // ------------------------------------------------------- bitmap sizing --

    @Test
    fun `sampleSizeFor picks the largest power of two keeping the longest edge above target`() {
        assertEquals(1, AttachmentPolicy.sampleSizeFor(1024, 768, 2048))
        assertEquals(1, AttachmentPolicy.sampleSizeFor(4000, 3000, 2048))
        // 8192/4 = 2048 — decoded edge lands exactly on target, never below it.
        assertEquals(4, AttachmentPolicy.sampleSizeFor(8192, 6144, 2048))
        assertEquals(8, AttachmentPolicy.sampleSizeFor(16384, 100, 2048))
        assertEquals(1, AttachmentPolicy.sampleSizeFor(0, 0, 2048))
    }

    @Test
    fun `scaledDimensions clamps the longest edge and preserves aspect`() {
        assertEquals(2048 to 1536, AttachmentPolicy.scaledDimensions(4096, 3072, 2048))
        assertEquals(1024 to 2048, AttachmentPolicy.scaledDimensions(2048, 4096, 2048))
        // Under the cap: untouched.
        assertEquals(640 to 480, AttachmentPolicy.scaledDimensions(640, 480, 2048))
        // Degenerate aspect never collapses to zero.
        assertEquals(2048 to 1, AttachmentPolicy.scaledDimensions(100_000, 10, 2048))
    }

    // ---------------------------------------------------------- filenames --

    @Test
    fun `compressedFilename swaps the extension to jpg`() {
        assertEquals("shot.jpg", AttachmentPolicy.compressedFilename("shot.png"))
        assertEquals("IMG_0001.jpg", AttachmentPolicy.compressedFilename("IMG_0001.HEIC"))
        assertEquals("photo.jpg", AttachmentPolicy.compressedFilename("photo.jpg"))
        assertEquals("archive.tar.jpg", AttachmentPolicy.compressedFilename("archive.tar.png"))
        assertEquals("noext.jpg", AttachmentPolicy.compressedFilename("noext"))
        // A leading dot is a hidden-file name, not an extension.
        assertEquals(".hidden.jpg", AttachmentPolicy.compressedFilename(".hidden"))
    }

    // ----------------------------------------------------------- data URLs --

    @Test
    fun `dataUrl and bytesFromDataUrl round-trip`() {
        val bytes = byteArrayOf(1, 2, 3, 4, 5)
        val url = AttachmentPolicy.dataUrl("image/jpeg", bytes)
        assertEquals("data:image/jpeg;base64,AQIDBAU=", url)
        assertContentEquals(bytes, AttachmentPolicy.bytesFromDataUrl(url))
    }

    @Test
    fun `web-authored data URLs parse regardless of mime`() {
        assertEquals("iVBORw0K", AttachmentPolicy.base64FromDataUrl("data:image/png;base64,iVBORw0K"))
    }

    @Test
    fun `non data URLs and malformed payloads return null`() {
        assertNull(AttachmentPolicy.base64FromDataUrl("https://example.com/a.png"))
        assertNull(AttachmentPolicy.base64FromDataUrl("data:image/png,plain"))
        assertNull(AttachmentPolicy.base64FromDataUrl("data:image/png;base64,"))
        assertNull(AttachmentPolicy.bytesFromDataUrl("data:image/png;base64,!!!not-base64!!!"))
    }
}
