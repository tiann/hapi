@file:OptIn(kotlinx.coroutines.ExperimentalCoroutinesApi::class)

package app.hapi.companion.feature.files

import app.hapi.protocol.wire.FileReadResponse
import app.hapi.protocol.wire.GitCommandResponse
import java.util.Base64
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertIs
import kotlin.test.assertTrue
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.runTest

class FileViewerViewModelTest {

    private fun TestScope.buildViewModel(
        gateway: FakeFilesGateway,
        path: String = "src/app.ts",
        staged: Boolean? = null,
        mode: ViewerMode? = null,
        line: Int? = null,
    ): FileViewerViewModel = FileViewerViewModel(
        sessionId = "s1",
        path = path,
        initialStaged = staged,
        initialMode = mode,
        focusLine = line,
        gateway = gateway,
        scope = CoroutineScope(SupervisorJob() + StandardTestDispatcher(testScheduler)),
    )

    private fun b64(text: String): String = Base64.getEncoder().encodeToString(text.toByteArray())

    private val sampleDiff = """
        diff --git a/src/app.ts b/src/app.ts
        --- a/src/app.ts
        +++ b/src/app.ts
        @@ -1,2 +1,2 @@
         keep
        -old
        +new
    """.trimIndent()

    @Test
    fun `parses the diff and stays in diff mode`() = runTest {
        val gateway = FakeFilesGateway().apply {
            diffFileResult = GitCommandResponse(success = true, stdout = sampleDiff)
            readFileResult = FileReadResponse(success = true, content = b64("keep\nnew\n"))
        }
        val viewModel = buildViewModel(gateway)
        viewModel.start()
        advanceUntilIdle()

        val state = viewModel.state.value
        assertEquals(ViewerMode.DIFF, state.mode)
        val diff = assertIs<DiffUiState.Ready>(state.diff)
        assertEquals("src/app.ts", diff.files.single().displayPath)
        assertEquals(1, diff.files.single().additions)
        assertEquals(listOf<Pair<String, Boolean?>>("src/app.ts" to false), gateway.diffFileCalls)
    }

    @Test
    fun `empty diff auto-falls back to file mode`() = runTest {
        val gateway = FakeFilesGateway().apply {
            diffFileResult = GitCommandResponse(success = true, stdout = "")
            readFileResult = FileReadResponse(success = true, content = b64("hello"))
        }
        val viewModel = buildViewModel(gateway)
        viewModel.start()
        advanceUntilIdle()

        val state = viewModel.state.value
        assertEquals(ViewerMode.FILE, state.mode)
        assertEquals(DiffUiState.Empty, state.diff)
        val text = assertIs<FileContentUiState.Text>(state.content)
        assertEquals("hello", text.text)
        assertEquals("ts", text.language)
        assertEquals(false, text.isMarkdown)
    }

    @Test
    fun `failed diff auto-falls back to file mode with message kept`() = runTest {
        val gateway = FakeFilesGateway().apply {
            diffFileResult = GitCommandResponse(success = false, error = "not a repo")
            readFileResult = FileReadResponse(success = true, content = b64("x"))
        }
        val viewModel = buildViewModel(gateway)
        viewModel.start()
        advanceUntilIdle()

        assertEquals(ViewerMode.FILE, viewModel.state.value.mode)
        assertEquals("not a repo", assertIs<DiffUiState.Failed>(viewModel.state.value.diff).message)
    }

    @Test
    fun `explicit file mode from the route disables auto behavior`() = runTest {
        val gateway = FakeFilesGateway().apply {
            diffFileResult = GitCommandResponse(success = true, stdout = sampleDiff)
            readFileResult = FileReadResponse(success = true, content = b64("body"))
        }
        val viewModel = buildViewModel(gateway, mode = ViewerMode.FILE, line = 12)
        viewModel.start()
        advanceUntilIdle()

        assertEquals(ViewerMode.FILE, viewModel.state.value.mode)
        assertEquals(12, viewModel.state.value.focusLine)
        // The diff still loaded, so the user can flip to it.
        assertIs<DiffUiState.Ready>(viewModel.state.value.diff)
    }

    @Test
    fun `staged toggle reloads the diff for the other side`() = runTest {
        val gateway = FakeFilesGateway().apply {
            diffFileResult = GitCommandResponse(success = true, stdout = sampleDiff)
            readFileResult = FileReadResponse(success = true, content = b64("x"))
        }
        val viewModel = buildViewModel(gateway, staged = false)
        viewModel.start()
        advanceUntilIdle()

        viewModel.setStaged(true)
        advanceUntilIdle()

        assertEquals(
            listOf<Pair<String, Boolean?>>("src/app.ts" to false, "src/app.ts" to true),
            gateway.diffFileCalls,
        )
        assertTrue(viewModel.state.value.staged)
        // Same side again is a no-op.
        viewModel.setStaged(true)
        advanceUntilIdle()
        assertEquals(2, gateway.diffFileCalls.size)
    }

    @Test
    fun `markdown files flag markdown and default to preview`() = runTest {
        val gateway = FakeFilesGateway().apply {
            diffFileResult = GitCommandResponse(success = true, stdout = "")
            readFileResult = FileReadResponse(success = true, content = b64("# Title"), size = 7, modified = 123L)
        }
        val viewModel = buildViewModel(gateway, path = "README.md")
        viewModel.start()
        advanceUntilIdle()

        val state = viewModel.state.value
        assertTrue(assertIs<FileContentUiState.Text>(state.content).isMarkdown)
        assertTrue(state.markdownPreview)
        assertEquals(7L, state.sizeBytes)
        assertEquals(123L, state.modifiedAt)

        viewModel.setMarkdownPreview(false)
        assertEquals(false, viewModel.state.value.markdownPreview)
    }

    @Test
    fun `image extensions decode to image content`() = runTest {
        val bytes = byteArrayOf(1, 2, 3, 4)
        val gateway = FakeFilesGateway().apply {
            diffFileResult = GitCommandResponse(success = true, stdout = "")
            readFileResult = FileReadResponse(
                success = true,
                content = Base64.getEncoder().encodeToString(bytes),
            )
        }
        val viewModel = buildViewModel(gateway, path = "assets/logo.PNG")
        viewModel.start()
        advanceUntilIdle()

        val image = assertIs<FileContentUiState.Image>(viewModel.state.value.content)
        assertEquals("image/png", image.mimeType)
        assertTrue(bytes.contentEquals(image.bytes))
        assertEquals(ViewerMode.FILE, viewModel.state.value.mode)
    }

    @Test
    fun `NUL bytes classify as binary`() = runTest {
        val gateway = FakeFilesGateway().apply {
            diffFileResult = GitCommandResponse(success = true, stdout = "")
            readFileResult = FileReadResponse(
                success = true,
                content = Base64.getEncoder().encodeToString(byteArrayOf(104, 105, 0, 106)),
            )
        }
        val viewModel = buildViewModel(gateway, path = "blob.bin")
        viewModel.start()
        advanceUntilIdle()

        assertEquals(FileContentUiState.Binary, viewModel.state.value.content)
    }

    @Test
    fun `read failure surfaces its message`() = runTest {
        val gateway = FakeFilesGateway().apply {
            diffFileResult = GitCommandResponse(success = true, stdout = "")
            readFileResult = FileReadResponse(success = false, error = "File not found")
        }
        val viewModel = buildViewModel(gateway)
        viewModel.start()
        advanceUntilIdle()

        assertEquals("File not found", assertIs<FileContentUiState.Failed>(viewModel.state.value.content).message)
    }

    @Test
    fun `invalid base64 classifies as binary`() = runTest {
        val gateway = FakeFilesGateway().apply {
            diffFileResult = GitCommandResponse(success = true, stdout = "")
            readFileResult = FileReadResponse(success = true, content = "%%%not-base64%%%")
        }
        val viewModel = buildViewModel(gateway)
        viewModel.start()
        advanceUntilIdle()

        assertEquals(FileContentUiState.Binary, viewModel.state.value.content)
    }
}
