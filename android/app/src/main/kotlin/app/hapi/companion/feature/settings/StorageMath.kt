package app.hapi.companion.feature.settings

import app.hapi.protocol.wire.SqliteStorageUsageResponse

/**
 * Donut geometry for the sqlite storage chart — the Kotlin twin of
 * `web/src/components/settings/storageUsageSlices.ts` (same fixed slice
 * order, zero-byte filtering, 12-o'clock start, one-decimal percents).
 */
object StorageMath {

    enum class SliceKey { DATABASE, WAL, SHM }

    data class Slice(
        val key: SliceKey,
        val bytes: Long,
        /** Share of the drawn total, one decimal (e.g. `97.3`). */
        val percent: Double,
        /** Degrees, `-90` = 12 o'clock, clockwise (Android sweep convention). */
        val startAngle: Float,
        val endAngle: Float,
    )

    /** Fixed entity order — colors follow the entity, never its rank. */
    private val SLICE_ORDER = listOf(SliceKey.DATABASE, SliceKey.WAL, SliceKey.SHM)

    private const val FULL_CIRCLE = 360f

    /** Start at 12 o'clock so the first slice reads top-heavy on mobile. */
    const val START_ANGLE = -90f

    /**
     * Slices for the donut: zero-byte files are dropped, angles partition the
     * full circle exactly (the last slice absorbs rounding), empty when
     * nothing is drawn.
     */
    fun slices(usage: SqliteStorageUsageResponse): List<Slice> {
        val entries = SLICE_ORDER
            .map { key -> key to bytesFor(usage, key).coerceAtLeast(0) }
            .filter { (_, bytes) -> bytes > 0 }
        val total = entries.sumOf { (_, bytes) -> bytes }
        if (total <= 0) return emptyList()

        var cursor = START_ANGLE
        return entries.mapIndexed { index, (key, bytes) ->
            val isLast = index == entries.lastIndex
            val endAngle = if (isLast) {
                START_ANGLE + FULL_CIRCLE
            } else {
                cursor + (bytes.toFloat() / total) * FULL_CIRCLE
            }
            Slice(
                key = key,
                bytes = bytes,
                // Math.round: half-up like JS (kotlin.math.round is half-even).
                percent = Math.round(bytes * 1000.0 / total) / 10.0,
                startAngle = cursor,
                endAngle = endAngle,
            ).also { cursor = endAngle }
        }
    }

    /** `97.25` → `"97.3%"` (web `formatStoragePercent`, half-up). */
    fun formatPercent(percent: Double): String {
        val rounded = Math.round(percent * 10) / 10.0
        val text = if (rounded == Math.floor(rounded)) rounded.toInt().toString() else rounded.toString()
        return "$text%"
    }

    private fun bytesFor(usage: SqliteStorageUsageResponse, key: SliceKey): Long = when (key) {
        SliceKey.DATABASE -> usage.databaseBytes
        SliceKey.WAL -> usage.walBytes
        SliceKey.SHM -> usage.shmBytes
    }
}
