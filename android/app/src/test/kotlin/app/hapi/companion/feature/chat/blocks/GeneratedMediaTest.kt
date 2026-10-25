package app.hapi.companion.feature.chat.blocks

import app.hapi.companion.R
import java.io.File
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertFalse
import kotlin.test.assertTrue
import kotlinx.coroutines.runBlocking
import okhttp3.OkHttpClient
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer

/**
 * Generated media routing / gating / cache naming / fetch semantics — the
 * JVM mirror of the web's generatedInlineMedia + ToolMessage.generatedMedia
 * behavior tests (web report §3 G3-G8).
 */
class GeneratedMediaTest {
    @Test
    fun videoAudioAndImagePrefixesRoute() {
        assertEquals(GeneratedMediaKind.VIDEO, generatedMediaKind("video/mp4"))
        assertEquals(GeneratedMediaKind.VIDEO, generatedMediaKind("video/webm; codecs=vp9"))
        assertEquals(GeneratedMediaKind.AUDIO, generatedMediaKind("audio/mpeg"))
        assertEquals(GeneratedMediaKind.AUDIO, generatedMediaKind("audio/ogg"))
        assertEquals(GeneratedMediaKind.IMAGE, generatedMediaKind("image/png"))
        assertEquals(GeneratedMediaKind.IMAGE, generatedMediaKind("image/svg+xml"))
    }

    @Test
    fun nullMimeKeepsImageTreatmentLikeTheWeb() {
        assertEquals(GeneratedMediaKind.IMAGE, generatedMediaKind(null))
    }

    @Test
    fun everythingElseIsAFileIncludingOddValues() {
        assertEquals(GeneratedMediaKind.FILE, generatedMediaKind("application/pdf"))
        assertEquals(GeneratedMediaKind.FILE, generatedMediaKind("application/octet-stream"))
        assertEquals(GeneratedMediaKind.FILE, generatedMediaKind("text/plain"))
        assertEquals(GeneratedMediaKind.FILE, generatedMediaKind(""))
        // Literal, case-sensitive prefix check, exactly like the web helper.
        assertEquals(GeneratedMediaKind.FILE, generatedMediaKind("VIDEO/MP4"))
        assertEquals(GeneratedMediaKind.FILE, generatedMediaKind("video"))
        assertEquals(GeneratedMediaKind.FILE, generatedMediaKind("videoweb/mp4"))
    }

    @Test
    fun onlyImagesLoadOnMount() {
        assertTrue(GeneratedMediaKind.IMAGE.loadsOnMount)
        assertFalse(GeneratedMediaKind.VIDEO.loadsOnMount)
        assertFalse(GeneratedMediaKind.AUDIO.loadsOnMount)
        assertFalse(GeneratedMediaKind.FILE.loadsOnMount)
    }

    @Test
    fun labelsAndLoadActionsMapPerKind() {
        assertEquals(R.string.media_displayed_image, GeneratedMediaKind.IMAGE.labelRes)
        assertEquals(R.string.media_displayed_video, GeneratedMediaKind.VIDEO.labelRes)
        assertEquals(R.string.media_displayed_audio, GeneratedMediaKind.AUDIO.labelRes)
        assertEquals(R.string.media_displayed_file, GeneratedMediaKind.FILE.labelRes)
        assertEquals(null, GeneratedMediaKind.IMAGE.loadActionRes)
        assertEquals(R.string.media_load_video, GeneratedMediaKind.VIDEO.loadActionRes)
        assertEquals(R.string.media_load_audio, GeneratedMediaKind.AUDIO.loadActionRes)
        assertEquals(R.string.media_prepare_download, GeneratedMediaKind.FILE.loadActionRes)
    }

    @Test
    fun sanitizedFileNamesDropTraversalAndUnsafeCharacters() {
        val name = sanitizedGeneratedMediaFileName("img-1", "../../etc/passwd")
        assertTrue('/' !in name && '\\' !in name && ".." !in name, name)
        assertTrue(name.startsWith("img-1-"), name)
        assertEquals("img-1-media", sanitizedGeneratedMediaFileName("img-1", ""))
        assertEquals("img-1-media", sanitizedGeneratedMediaFileName("img-1", "///"))
        assertEquals("id-x.bin", sanitizedGeneratedMediaFileName("", "x.bin"))
        val unicode = sanitizedGeneratedMediaFileName("i", "截图 01.png")
        assertEquals("i-截图01.png", unicode)
        val long = sanitizedGeneratedMediaFileName("i", "a".repeat(500))
        assertTrue(long.length <= 96 + "i-".length, long.length.toString())
    }

    @Test
    fun cacheFileIsDeterministicAndIsolatedPerBlob() {
        val dir = File("build/tmp/generated-media-test").absoluteFile
        val a = generatedMediaCacheFile(dir, "img-1", "clip.mp4")
        val b = generatedMediaCacheFile(dir, "img-1", "clip.mp4")
        val c = generatedMediaCacheFile(dir, "img-2", "clip.mp4")
        assertEquals(a, b)
        assertTrue(a != c)
        assertEquals("generated-media", a.parentFile.name)
    }

    @Test
    fun fetchDownloadsBodyAndShortCircuitsOnCachedFile() {
        val server = MockWebServer()
        server.enqueue(MockResponse().setBody("payload"))
        server.start()
        try {
            val client = OkHttpClient()
            val dir = File("build/tmp/generated-media-fetch").apply { deleteRecursively() }
            val file = runBlocking {
                fetchGeneratedMediaFile(client, server.url("/api/media").toString(), dir, "img-1", "clip.mp4")
            }
            assertEquals("payload", file.readText())
            val request = server.takeRequest()
            assertEquals("/api/media", request.path)

            // Present complete file = no second network call (immutable, ETagged).
            val again = runBlocking {
                fetchGeneratedMediaFile(client, server.url("/api/media").toString(), dir, "img-1", "clip.mp4")
            }
            assertEquals(file, again)
            assertEquals(1, server.requestCount)
        } finally {
            server.shutdown()
        }
    }

    @Test
    fun fetchMapsHttpStatusToTheWebErrorMessage() {
        val server = MockWebServer()
        server.enqueue(MockResponse().setResponseCode(500))
        server.start()
        try {
            val error = assertFailsWith<java.io.IOException> {
                runBlocking {
                    fetchGeneratedMediaFile(
                        OkHttpClient(),
                        server.url("/").toString(),
                        File("build/tmp/generated-media-fetch-err"),
                        "img-1",
                        "clip.mp4",
                    )
                }
            }
            assertEquals("HTTP 500", error.message)
        } finally {
            server.shutdown()
        }
    }

    @Test
    fun playbackTimeFormatsMinutesAndSeconds() {
        assertEquals("0:00", formatPlaybackTime(0))
        assertEquals("0:59", formatPlaybackTime(59_999))
        assertEquals("1:01", formatPlaybackTime(61_000))
        assertEquals("60:00", formatPlaybackTime(3_600_000))
        assertEquals("0:00", formatPlaybackTime(-50))
    }
}
