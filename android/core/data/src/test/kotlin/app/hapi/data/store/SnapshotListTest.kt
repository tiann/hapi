package app.hapi.data.store

import java.io.File
import java.nio.file.Files
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.builtins.serializer

class SnapshotListTest {
    @Test
    fun `late identity hydrates a list that has never received live data`() = runTest {
        val dir = Files.createTempDirectory("snapshot-list").toFile()
        File(dir, "list.json").writeText("""["cached"]""")
        val list = SnapshotList(null, "list.json", String.serializer(), backgroundScope)
        val observed = list.values
        list.enableSnapshots(dir)
        assertEquals(listOf("cached"), observed.value)
    }

    @Test
    fun `late identity persists an authoritative empty list without restoring stale rows`() = runTest {
        val dir = Files.createTempDirectory("snapshot-list").toFile()
        File(dir, "list.json").writeText("""["stale"]""")
        val list = SnapshotList(null, "list.json", String.serializer(), backgroundScope)
        list.update { emptyList() }
        list.enableSnapshots(dir)
        assertEquals(emptyList(), list.values.value)
        list.flush()
        val restarted = SnapshotList(dir, "list.json", String.serializer(), backgroundScope)
        assertEquals(emptyList(), restarted.values.value)
    }
}
