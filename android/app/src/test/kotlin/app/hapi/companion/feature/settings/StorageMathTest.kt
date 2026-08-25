package app.hapi.companion.feature.settings

import app.hapi.protocol.wire.SqliteStorageUsageResponse
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

/** Donut slice math — twin of `storageUsageSlices.test.ts` semantics. */
class StorageMathTest {

    private fun usage(db: Long, wal: Long, shm: Long): SqliteStorageUsageResponse =
        SqliteStorageUsageResponse(
            path = "/x/hapi.db",
            databaseBytes = db,
            walBytes = wal,
            shmBytes = shm,
            totalBytes = db + wal + shm,
        )

    @Test
    fun `slices keep entity order and partition the full circle`() {
        val slices = StorageMath.slices(usage(db = 750, wal = 200, shm = 50))

        assertEquals(
            listOf(StorageMath.SliceKey.DATABASE, StorageMath.SliceKey.WAL, StorageMath.SliceKey.SHM),
            slices.map { it.key },
        )
        assertEquals(StorageMath.START_ANGLE, slices.first().startAngle)
        assertEquals(StorageMath.START_ANGLE + 360f, slices.last().endAngle)
        // Contiguous: each slice starts where the previous ended.
        slices.zipWithNext().forEach { (a, b) -> assertEquals(a.endAngle, b.startAngle) }
        assertEquals(75.0, slices[0].percent)
        assertEquals(20.0, slices[1].percent)
        assertEquals(5.0, slices[2].percent)
        // db = 75% of the circle.
        assertEquals(270f, slices[0].endAngle - slices[0].startAngle, absoluteTolerance = 0.001f)
    }

    @Test
    fun `zero-byte files are dropped without repainting the survivors`() {
        val slices = StorageMath.slices(usage(db = 100, wal = 0, shm = 25))
        assertEquals(listOf(StorageMath.SliceKey.DATABASE, StorageMath.SliceKey.SHM), slices.map { it.key })
        assertEquals(StorageMath.START_ANGLE + 360f, slices.last().endAngle)
        assertEquals(80.0, slices[0].percent)
    }

    @Test
    fun `all-zero usage yields no slices`() {
        assertTrue(StorageMath.slices(usage(db = 0, wal = 0, shm = 0)).isEmpty())
        // Negative (corrupt) sizes are treated as zero, not drawn.
        assertTrue(StorageMath.slices(usage(db = -10, wal = 0, shm = 0)).isEmpty())
    }

    @Test
    fun `percent rounds to one decimal`() {
        val slices = StorageMath.slices(usage(db = 1, wal = 2, shm = 0))
        assertEquals(33.3, slices[0].percent)
        assertEquals(66.7, slices[1].percent)
    }

    @Test
    fun `formatPercent drops the decimal on whole numbers`() {
        assertEquals("75%", StorageMath.formatPercent(75.0))
        assertEquals("33.3%", StorageMath.formatPercent(33.3))
        assertEquals("97.3%", StorageMath.formatPercent(97.25))
        assertEquals("0%", StorageMath.formatPercent(0.0))
        assertEquals("100%", StorageMath.formatPercent(100.0))
    }
}
