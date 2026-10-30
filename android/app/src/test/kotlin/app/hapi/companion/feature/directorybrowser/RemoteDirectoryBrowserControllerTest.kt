@file:OptIn(kotlinx.coroutines.ExperimentalCoroutinesApi::class)

package app.hapi.companion.feature.directorybrowser

import app.hapi.protocol.wire.MachineDirectoryEntry
import app.hapi.protocol.wire.MachineListDirectoryResponse
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.runTest

class RemoteDirectoryBrowserControllerTest {
    @Test
    fun `path boundaries support POSIX drive and UNC paths`() {
        assertTrue(RemoteDirectoryPath.isWithinRoot("/workspace/repo", "/workspace"))
        assertFalse(RemoteDirectoryPath.isWithinRoot("/workspace-other/repo", "/workspace"))
        assertTrue(RemoteDirectoryPath.isWithinRoot("/workspace", "/"))
        assertTrue(RemoteDirectoryPath.isWithinRoot("c:\\Work\\Repo", "C:\\work"))
        assertFalse(RemoteDirectoryPath.isWithinRoot("C:\\workspace-other", "C:\\workspace"))
        assertTrue(RemoteDirectoryPath.isWithinRoot("\\\\SERVER\\Share\\Repo", "\\\\server\\share"))
        assertEquals("C:\\", RemoteDirectoryPath.parent("C:\\Users"))
        assertEquals("\\\\server\\share", RemoteDirectoryPath.parent("\\\\server\\share\\repo"))
    }

    @Test
    fun `browser owns navigation loading and hidden-directory state`() = runTest {
        val calls = mutableListOf<Triple<String, String, Boolean>>()
        val controller = RemoteDirectoryBrowserController(
            scope = this,
            listDirectory = { machineId, path, includeHidden ->
                calls += Triple(machineId, path, includeHidden)
                MachineListDirectoryResponse(
                    success = true,
                    entries = listOf(
                        MachineDirectoryEntry("repo", "directory"),
                        MachineDirectoryEntry("README.md", "file"),
                    ),
                )
            },
            fallbackError = "Failed to browse directories",
        )

        controller.open("machine-1", listOf("/workspace"), "/workspace")
        advanceUntilIdle()
        assertEquals(listOf("repo"), controller.state.value.entries.map { it.name })

        controller.navigate("/workspace-other")
        advanceUntilIdle()
        assertEquals(1, calls.size)

        controller.navigateEntry("repo")
        advanceUntilIdle()
        assertEquals("/workspace/repo", controller.state.value.path)
        assertTrue(controller.state.value.canGoUp)

        controller.setIncludeHidden(true)
        advanceUntilIdle()
        assertTrue(calls.last().third)

        controller.navigateUp()
        advanceUntilIdle()
        assertEquals("/workspace", controller.state.value.path)

        controller.close()
        assertFalse(controller.state.value.open)
    }

    @Test
    fun `show-hidden seeds from the provider and toggles notify the listener`() = runTest {
        var persisted = true
        val toggles = mutableListOf<Boolean>()
        val requestFlags = mutableListOf<Boolean>()
        val controller = RemoteDirectoryBrowserController(
            scope = this,
            listDirectory = { _, _, includeHidden ->
                requestFlags += includeHidden
                MachineListDirectoryResponse(success = true, entries = emptyList())
            },
            fallbackError = "Failed to browse directories",
            includeHiddenProvider = { persisted },
            onIncludeHiddenChange = { value ->
                persisted = value
                toggles += value
            },
        )

        // Seeded from the persisted value: the very first listing includes hidden.
        controller.open("machine-1", listOf("/workspace"), "/workspace")
        advanceUntilIdle()
        assertTrue(controller.state.value.includeHidden)
        assertEquals(listOf(true), requestFlags)

        // Toggling both notifies the listener (the persistence write hook)
        // and reloads with the new flag.
        controller.setIncludeHidden(false)
        advanceUntilIdle()
        assertEquals(listOf(false), toggles)
        assertFalse(controller.state.value.includeHidden)
        assertEquals(listOf(true, false), requestFlags)

        // The provider value survives a close/reopen cycle.
        controller.close()
        controller.open("machine-1", listOf("/workspace"), "/workspace")
        advanceUntilIdle()
        assertFalse(controller.state.value.includeHidden)
        assertEquals(listOf(true, false, false), requestFlags)
    }
}
