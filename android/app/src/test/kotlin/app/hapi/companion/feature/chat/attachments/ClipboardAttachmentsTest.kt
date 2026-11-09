package app.hapi.companion.feature.chat.attachments

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

class ClipboardAttachmentsTest {

    @Test
    fun `text-only clipboard items yield no picks`() {
        // Web twin: empty clipboardData.files ⇒ the default text paste runs.
        val picks = ClipboardAttachments.attachableUris(
            listOf(ClipboardClipItem(), ClipboardClipItem()),
        )
        assertTrue(picks.isEmpty())
    }

    @Test
    fun `content uris attach in clipboard order`() {
        // Web attaches pasted files sequentially in clipboard order.
        val picks = ClipboardAttachments.attachableUris(
            listOf(
                ClipboardClipItem(uri = "content://media/external/images/3"),
                ClipboardClipItem(uri = "content://downloads/9"),
                ClipboardClipItem(uri = "content://media/external/file/1"),
            ),
        )
        assertEquals(
            listOf(
                "content://media/external/images/3",
                "content://downloads/9",
                "content://media/external/file/1",
            ),
            picks,
        )
    }

    @Test
    fun `duplicate uris attach once`() {
        val picks = ClipboardAttachments.attachableUris(
            listOf(
                ClipboardClipItem(uri = "content://media/1"),
                ClipboardClipItem(uri = "content://media/2"),
                ClipboardClipItem(uri = "content://media/1"),
            ),
        )
        assertEquals(listOf("content://media/1", "content://media/2"), picks)
    }

    @Test
    fun `non-content uris are skipped`() {
        val picks = ClipboardAttachments.attachableUris(
            listOf(
                ClipboardClipItem(uri = "file:///tmp/a.jpg"),
                ClipboardClipItem(uri = "https://example.com/b.png"),
                ClipboardClipItem(uri = ""),
                ClipboardClipItem(uri = "content://media/2"),
            ),
        )
        assertEquals(listOf("content://media/2"), picks)
    }

    @Test
    fun `empty clipboard yields no picks`() {
        assertTrue(ClipboardAttachments.attachableUris(emptyList()).isEmpty())
    }
}
