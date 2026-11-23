package app.hapi.companion.feature.chat.blocks

import app.hapi.companion.R
import app.cash.turbine.test
import java.io.File
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertFalse
import kotlin.test.assertTrue
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.test.runTest
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

    /** Scriptable [GeneratedAudioPlayer] for the session tests below. */
    private class FakeAudioPlayer : GeneratedAudioPlayer {
        var dataSourcePath: String? = null
        var preparedAsyncCalls = 0
        var starts = 0
        var pauses = 0
        var releases = 0
        val seeks = mutableListOf<Int>()
        var positionMs = 0
        var failDataSource = false

        private var onPrepared: ((Int) -> Unit)? = null
        private var onCompletion: (() -> Unit)? = null
        private var onError: (() -> Boolean)? = null

        override fun setDataSource(path: String) {
            check(!failDataSource) { "bad file" }
            dataSourcePath = path
        }

        override fun prepareAsync() {
            preparedAsyncCalls++
        }

        override fun setOnPreparedListener(onPrepared: (Int) -> Unit) {
            this.onPrepared = onPrepared
        }

        override fun setOnCompletionListener(onCompletion: () -> Unit) {
            this.onCompletion = onCompletion
        }

        override fun setOnErrorListener(onError: () -> Boolean) {
            this.onError = onError
        }

        override fun start() {
            starts++
        }

        override fun pause() {
            pauses++
        }

        override fun seekTo(positionMs: Int) {
            seeks += positionMs
        }

        override fun currentPositionMs(): Int = positionMs

        override fun release() {
            releases++
        }

        fun simulatePrepared(durationMs: Int) {
            onPrepared!!.invoke(durationMs)
        }

        fun simulateCompletion() {
            onCompletion!!.invoke()
        }

        fun simulateError() {
            onError!!.invoke()
        }
    }

    @Test
    fun audioSessionPreparesOnceAndGatesControlsUntilPrepared() {
        val player = FakeAudioPlayer()
        val session = GeneratedAudioSession(player)
        session.prepare("/cache/generated-media/img-1-voice-memo.m4a")
        assertEquals("/cache/generated-media/img-1-voice-memo.m4a", player.dataSourcePath)
        assertEquals(1, player.preparedAsyncCalls)

        // Pre-preparation: toggle and seek stay inert (the row's buttons are
        // disabled, and the logic underneath refuses too).
        session.togglePlayPause()
        session.seekToFraction(0.5f)
        assertEquals(0, player.starts)
        assertEquals(0, player.seeks.size)

        player.simulatePrepared(120_000)
        assertTrue(session.prepared.value)
        assertEquals(120_000, session.durationMs.value)
    }

    @Test
    fun audioSessionTogglesPlayPauseAndStopsOnCompletion() = runTest {
        val player = FakeAudioPlayer()
        val session = GeneratedAudioSession(player)
        session.prepare("memo.m4a")
        player.simulatePrepared(10_000)
        session.playing.test {
            assertFalse(awaitItem()) // initial idle state
            session.togglePlayPause()
            assertTrue(awaitItem())
            assertEquals(1, player.starts)
            session.togglePlayPause()
            assertFalse(awaitItem())
            assertEquals(1, player.pauses)
            session.togglePlayPause()
            assertTrue(awaitItem())
            player.simulateCompletion()
            assertFalse(awaitItem()) // natural end parks the row
            assertEquals(2, player.starts) // two plays, one pause between
            cancelAndIgnoreRemainingEvents()
        }
    }

    @Test
    fun audioSessionSeeksByDurationFractionAndClamps() {
        val player = FakeAudioPlayer()
        val session = GeneratedAudioSession(player)
        session.prepare("memo.m4a")
        player.simulatePrepared(10_000)
        player.positionMs = 4_950
        session.seekToFraction(0.5f)
        assertEquals(listOf(5_000), player.seeks)
        assertEquals(4_950, session.positionMs.value) // read back after the seek
        session.seekToFraction(1.7f)
        assertEquals(10_000, player.seeks.last())
        session.seekToFraction(-0.3f)
        assertEquals(0, player.seeks.last())
    }

    @Test
    fun audioSessionPollsPositionOnlyWhilePlaying() {
        val player = FakeAudioPlayer()
        val session = GeneratedAudioSession(player)
        session.prepare("memo.m4a")
        player.simulatePrepared(10_000)
        player.positionMs = 1_234
        session.pollPosition()
        assertEquals(0, session.positionMs.value) // paused rows do not read
        session.togglePlayPause()
        player.positionMs = 2_345
        session.pollPosition()
        assertEquals(2_345, session.positionMs.value)
    }

    @Test
    fun audioSessionReleaseIsTheDisposeHookAndIdempotent() {
        val player = FakeAudioPlayer()
        val session = GeneratedAudioSession(player)
        session.prepare("memo.m4a")
        player.simulatePrepared(10_000)
        session.togglePlayPause()
        assertTrue(session.playing.value)

        // What the card's onDispose runs: the framework player is released
        // exactly once, and a double dispose (recomposition races) cannot
        // double-release it.
        session.release()
        assertEquals(1, player.releases)
        assertFalse(session.playing.value)
        session.release()
        assertEquals(1, player.releases)

        // Post-release controls are inert — the real released MediaPlayer
        // would throw on start/seek/currentPosition.
        session.togglePlayPause()
        session.seekToFraction(0.5f)
        session.pollPosition()
        assertEquals(1, player.starts)
        assertEquals(0, player.seeks.size)
    }

    @Test
    fun audioSessionMapsPlayerAndDataSourceErrorsToFailed() {
        val player = FakeAudioPlayer()
        val session = GeneratedAudioSession(player)
        session.prepare("memo.m4a")
        player.simulatePrepared(10_000)
        session.togglePlayPause()
        player.simulateError()
        assertTrue(session.failed.value)
        assertFalse(session.playing.value)
        session.togglePlayPause() // failed rows stay inert
        assertEquals(1, player.starts)

        val brokenPlayer = FakeAudioPlayer().apply { failDataSource = true }
        val broken = GeneratedAudioSession(brokenPlayer)
        broken.prepare("memo.m4a")
        assertTrue(broken.failed.value)
        broken.togglePlayPause()
        assertEquals(0, brokenPlayer.starts)
    }

    @Test
    fun fileOutletsCarryTheResolvedTypeIntoBothOpenAndSave() {
        // Open (ACTION_VIEW) and Save (ACTION_CREATE_DOCUMENT) both carry the
        // type resolved from the filename, never the raw octet-stream wire
        // value that no viewer matches.
        val inferred = generatedFileOutlets(null, "report.pdf", extensionTypes::get)
        assertEquals("application/pdf", inferred.openMimeType)
        assertEquals("application/pdf", inferred.saveMimeType)
        assertEquals("report.pdf", inferred.suggestedName)

        val generic = generatedFileOutlets("application/octet-stream", "data.unknown-ext", extensionTypes::get)
        assertEquals(GENERIC_FILE_MIME_TYPE, generic.openMimeType)
        assertEquals(GENERIC_FILE_MIME_TYPE, generic.saveMimeType)
        assertEquals("data.unknown-ext", generic.suggestedName)

        val specific = generatedFileOutlets("text/csv", "report.pdf", extensionTypes::get)
        assertEquals("text/csv", specific.openMimeType)
        assertEquals("text/csv", specific.saveMimeType)
    }

    @Test
    fun fetchStoresLongUnicodeNamesUnderTheFilesystemByteLimit() {
        val server = MockWebServer()
        server.enqueue(MockResponse().setBody("pdf-bytes"))
        server.start()
        try {
            val client = OkHttpClient()
            val dir = File("build/tmp/generated-media-unicode").apply { deleteRecursively() }
            val uuid = "550e8400-e29b-41d4-a716-446655440000"
            val file = runBlocking {
                fetchGeneratedMediaFile(
                    client,
                    server.url("/api/media").toString(),
                    dir,
                    uuid,
                    "截图".repeat(40) + ".pdf",
                )
            }
            val componentBytes = file.name.toByteArray(Charsets.UTF_8).size
            assertTrue(componentBytes <= GENERATED_MEDIA_NAME_MAX_BYTES, "$componentBytes: ${file.name}")
            assertTrue(file.name.endsWith(".pdf"), file.name)
            assertEquals("pdf-bytes", file.readText())
            // Atomic rename left no staging litter: exactly the final file.
            val entries = file.parentFile.listFiles()
            assertEquals(listOf(file), entries?.toList())
        } finally {
            server.shutdown()
        }
    }
}
