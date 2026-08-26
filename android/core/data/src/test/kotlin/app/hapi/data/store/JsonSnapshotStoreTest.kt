package app.hapi.data.store

import java.io.File
import java.nio.file.Files
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.builtins.ListSerializer
import kotlinx.serialization.builtins.serializer

class JsonSnapshotStoreTest {

    private fun tempDir(): File = Files.createTempDirectory("snapshot-test").toFile()

    private fun store(file: File, scope: kotlinx.coroutines.CoroutineScope) = JsonSnapshotStore(
        file = file,
        serializer = ListSerializer(String.serializer()),
        scope = scope,
    )

    @Test
    fun `load returns null for a missing file`() = runTest {
        val file = File(tempDir(), "missing.json")
        assertNull(store(file, backgroundScope).load())
    }

    @Test
    fun `load returns null for a corrupt file`() = runTest {
        val file = File(tempDir(), "corrupt.json")
        file.writeText("{ not json")
        assertNull(store(file, backgroundScope).load())
    }

    @Test
    fun `write round-trips through a fresh store`() = runTest {
        val file = File(tempDir(), "data.json")
        val writer = store(file, backgroundScope)
        writer.scheduleWrite(listOf("a", "b"))
        writer.flush()
        assertEquals(listOf("a", "b"), store(file, backgroundScope).load())
    }

    @Test
    fun `debounce delays the write and keeps only the latest value`() = runTest {
        val file = File(tempDir(), "debounced.json")
        val writer = store(file, backgroundScope)

        writer.scheduleWrite(listOf("v1"))
        advanceTimeBy(400)
        assertFalse(file.exists(), "write must wait for the debounce window")

        // A newer value restarts the window and supersedes v1.
        writer.scheduleWrite(listOf("v2"))
        advanceTimeBy(400)
        assertFalse(file.exists())

        writer.flush()
        assertEquals(listOf("v2"), store(file, backgroundScope).load())
    }

    @Test
    fun `flush after the debounced write already landed is a no-op`() = runTest {
        val file = File(tempDir(), "settled.json")
        val writer = store(file, backgroundScope)
        writer.scheduleWrite(listOf("v1"))
        writer.flush()
        assertEquals(listOf("v1"), store(file, backgroundScope).load())
        file.delete()
        writer.flush() // nothing pending → must not resurrect the file
        assertFalse(file.exists())
    }

    @Test
    fun `write replaces previous content atomically (no tmp residue)`() = runTest {
        val file = File(tempDir(), "atomic.json")
        val writer = store(file, backgroundScope)
        writer.scheduleWrite(listOf("first"))
        writer.flush()
        writer.scheduleWrite(listOf("second"))
        writer.flush()
        assertEquals(listOf("second"), store(file, backgroundScope).load())
        assertTrue(file.parentFile.listFiles()!!.none { it.name.endsWith(".tmp") })
    }
}
