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

    /** Fake MimeTypeMap table for the resolution-seam tests below. */
    private val extensionTypes = mapOf(
        "pdf" to "application/pdf",
        "mp4" to "video/mp4",
        "zip" to "application/zip",
    )

    @Test
    fun genericOrMissingWireTypesAreRefinedFromTheFileName() {
        // Pre-fix behavior handed application/octet-stream to ACTION_VIEW for
        // these, which no application/pdf viewer ever matches.
        assertEquals("application/pdf", resolveFileMimeType(null, "report.pdf", extensionTypes::get))
        assertEquals(
            "application/pdf",
            resolveFileMimeType("application/octet-stream", "年度报告.pdf", extensionTypes::get),
        )
        assertEquals("application/pdf", resolveFileMimeType("", "report.pdf", extensionTypes::get))
        // Extension lookup lowercases first, like the MimeTypeMap contract.
        assertEquals("application/pdf", resolveFileMimeType(null, "REPORT.PDF", extensionTypes::get))
    }

    @Test
    fun unresolvableNamesFallBackToGenericOctetStream() {
        assertEquals(
            "application/octet-stream",
            resolveFileMimeType(null, "data.xyz-not-a-type", extensionTypes::get),
        )
        assertEquals(
            "application/octet-stream",
            resolveFileMimeType("application/octet-stream", "no-extension", extensionTypes::get),
        )
        // A bogus resolved value (no slash / wildcard) is not trusted either.
        assertEquals(
            "application/octet-stream",
            resolveFileMimeType(null, "odd.weird", mapOf("weird" to "not-a-mime")::get),
        )
    }

    @Test
    fun specificWireTypesPassThroughUntouched() {
        assertEquals("text/plain", resolveFileMimeType("text/plain", "report.pdf", extensionTypes::get))
        assertEquals("application/zip", resolveFileMimeType("application/zip", "archive.pdf", extensionTypes::get))
        // The wire type wins even when the extension would map elsewhere.
        assertEquals("text/csv", resolveFileMimeType("text/csv", "report.pdf", extensionTypes::get))
        // Octet-stream is matched case-insensitively and still refined.
        assertEquals(
            "application/pdf",
            resolveFileMimeType("APPLICATION/OCTET-STREAM", "report.pdf", extensionTypes::get),
        )
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
    fun longMultibyteNamesStayUnderTheFilesystemByteLimit() {
        // r4370795787: 80 hanzi + ".pdf" = 244 bytes of name; with a UUID
        // imageId prefix the old UTF-16-capped component reached 281 bytes,
        // past the 255-byte NAME_MAX. Now the complete component (prefix +
        // stem + extension) is bounded, deterministically, id-first.
        val uuid = "550e8400-e29b-41d4-a716-446655440000"
        val name = sanitizedGeneratedMediaFileName(uuid, "截图".repeat(40) + ".pdf")
        val bytes = name.toByteArray(Charsets.UTF_8)
        assertTrue(bytes.size <= GENERATED_MEDIA_NAME_MAX_BYTES, "${bytes.size}: $name")
        assertTrue(name.startsWith(uuid), name)
        assertTrue(name.endsWith(".pdf"), name)
        assertEquals(name, sanitizedGeneratedMediaFileName(uuid, "截图".repeat(40) + ".pdf"))

        // Extensions survive byte truncation of the stem.
        val archive = sanitizedGeneratedMediaFileName("id", "图表".repeat(120) + ".tar.gz")
        assertTrue(archive.endsWith(".gz"), archive)
        assertTrue(archive.toByteArray(Charsets.UTF_8).size <= GENERATED_MEDIA_NAME_MAX_BYTES, archive)
    }

    @Test
    fun multibyteNamesRoundTripThroughUtf8WithoutMojibake() {
        // The whitelist keeps only BMP letters/digits/._- (a surrogate half
        // is never a letter, so supplementary-plane characters — emoji and
        // CJK Extension B alike — are stripped before any truncation), which
        // makes every surviving char one complete code point: byte cuts land
        // only between chars and components always re-decode byte-identically.
        for (name in listOf(
            "截图".repeat(40) + ".pdf",
            "😀".repeat(200) + ".bin",
            "a" + "😀".repeat(50) + ".bin",
            "naïve-файл-ファイル.tar.gz",
            "图表".repeat(120) + ".gz",
        )) {
            val component = sanitizedGeneratedMediaFileName(
                "550e8400-e29b-41d4-a716-446655440000",
                name,
            )
            val bytes = component.toByteArray(Charsets.UTF_8)
            assertTrue(bytes.size <= GENERATED_MEDIA_NAME_MAX_BYTES, "$name -> $component (${bytes.size})")
            assertEquals(component, String(bytes, Charsets.UTF_8), name)
        }
        // Symbols are stripped wholesale — an emoji-only name reduces to its
        // extension stem (the historical shape; the extension needs a stem).
        assertEquals("i-bin", sanitizedGeneratedMediaFileName("i", "😀".repeat(200) + ".bin"))
    }

    @Test
    fun asciiNamesKeepTheirHistoricalShape() {
        assertEquals("i-" + "a".repeat(96), sanitizedGeneratedMediaFileName("i", "a".repeat(500)))
        assertEquals("img-1-media", sanitizedGeneratedMediaFileName("img-1", ""))
        assertEquals("id-x.bin", sanitizedGeneratedMediaFileName("", "x.bin"))
        assertEquals("i-截图01.png", sanitizedGeneratedMediaFileName("i", "截图 01.png"))
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
