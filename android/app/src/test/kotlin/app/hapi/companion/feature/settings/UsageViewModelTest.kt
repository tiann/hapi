@file:OptIn(kotlinx.coroutines.ExperimentalCoroutinesApi::class)

package app.hapi.companion.feature.settings

import app.hapi.data.api.ApiError
import app.hapi.protocol.wire.SqliteStorageUsageResponse
import app.hapi.protocol.wire.UsageSummaryBucket
import app.hapi.protocol.wire.UsageSummaryRange
import app.hapi.protocol.wire.UsageSummaryResponse
import app.hapi.protocol.wire.UsageSummaryTotals
import java.time.LocalDate
import java.time.ZoneId
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.runTest

/** Range/reload/error-state behavior of the two dashboard ViewModels. */
class UsageViewModelTest {

    private val zone = ZoneId.of("Asia/Shanghai")

    /**
     * VM scope on the test scheduler as FOREGROUND work — `advanceUntilIdle`
     * drives it; a `backgroundScope`-hosted VM would never run under pure
     * virtual time (same pattern as `NewSessionViewModelTest`).
     */
    private fun TestScope.newVmScope(): CoroutineScope =
        CoroutineScope(SupervisorJob() + StandardTestDispatcher(testScheduler))

    private fun bucket(key: String, total: Long): UsageSummaryBucket = UsageSummaryBucket(
        key = key,
        inputTokens = total,
        outputTokens = 0,
        cacheReadTokens = 0,
        cacheCreationTokens = 0,
        totalTokens = total,
        uncachedTokens = total,
        requests = 1,
    )

    private fun summary(daily: List<UsageSummaryBucket>): UsageSummaryResponse = UsageSummaryResponse(
        range = UsageSummaryRange(from = null, to = 2),
        totals = UsageSummaryTotals(0, 0, 0, 0, 0, 0, 0, 0),
        daily = daily,
        byAgent = emptyList(),
        byModel = emptyList(),
        updatedAt = 2,
    )

    @Test
    fun `loads on start with the device zone and fills the 7d calendar`() = runTest {
        val requested = mutableListOf<Pair<String, String>>()
        val viewModel = UsageViewModel(
            gateway = { range, timeZone ->
                requested += range to timeZone
                summary(listOf(bucket("2026-08-18", 7)))
            },
            scope = newVmScope(),
            zone = zone,
            today = { LocalDate.of(2026, 8, 18) },
        )
        viewModel.start()
        advanceUntilIdle()

        assertEquals(listOf("7d" to "Asia/Shanghai"), requested)
        val state = viewModel.state.value
        assertTrue(state is UsageUiState.Data)
        assertEquals(7, state.dailyBars.size)
        assertEquals("2026-08-12", state.dailyBars.first().key)
        assertEquals(7, state.dailyBars.last().totalTokens)
    }

    @Test
    fun `switching range refetches and range=all keeps sparse bars`() = runTest {
        val requested = mutableListOf<String>()
        val viewModel = UsageViewModel(
            gateway = { range, _ ->
                requested += range
                summary(listOf(bucket("2024-01-01", 3)))
            },
            scope = newVmScope(),
            zone = zone,
            today = { LocalDate.of(2026, 8, 18) },
        )
        viewModel.start()
        advanceUntilIdle()
        viewModel.setRange(UsageRange.ALL)
        // Re-selecting the current range must not refetch.
        viewModel.setRange(UsageRange.ALL)
        advanceUntilIdle()

        assertEquals(listOf("7d", "all"), requested)
        val state = viewModel.state.value
        assertTrue(state is UsageUiState.Data)
        assertEquals(listOf("2024-01-01"), state.dailyBars.map { it.key })
    }

    @Test
    fun `403 maps to the forbidden error state`() = runTest {
        val viewModel = UsageViewModel(
            gateway = { _, _ -> throw ApiError(status = 403, body = """{"error":"owner only"}""") },
            scope = newVmScope(),
            zone = zone,
        )
        viewModel.start()
        advanceUntilIdle()

        val state = viewModel.state.value
        assertTrue(state is UsageUiState.Error)
        assertTrue(state.isForbidden)
    }

    @Test
    fun `plain failures keep retry available and retry recovers`() = runTest {
        var fail = true
        val viewModel = UsageViewModel(
            gateway = { _, _ ->
                if (fail) throw RuntimeException("boom") else summary(emptyList())
            },
            scope = newVmScope(),
            zone = zone,
        )
        viewModel.start()
        advanceUntilIdle()
        val error = viewModel.state.value
        assertTrue(error is UsageUiState.Error)
        assertFalse(error.isForbidden)
        assertEquals("boom", error.message)

        fail = false
        viewModel.retry()
        advanceUntilIdle()
        assertTrue(viewModel.state.value is UsageUiState.Data)
    }

    // ------------------------------------------------------------ storage --

    @Test
    fun `storage refresh keeps data while refreshing and surfaces 403`() = runTest {
        var bytes = 100L
        val viewModel = StorageViewModel(
            gateway = {
                SqliteStorageUsageResponse(
                    path = "/x/hapi.db",
                    databaseBytes = bytes,
                    walBytes = 0,
                    shmBytes = 0,
                    totalBytes = bytes,
                )
            },
            scope = newVmScope(),
        )
        viewModel.start()
        advanceUntilIdle()
        assertEquals(100, (viewModel.state.value as StorageUiState.Data).usage.totalBytes)

        bytes = 250
        viewModel.refresh()
        // Mid-refresh the old snapshot stays on screen, flagged refreshing.
        val midway = viewModel.state.value
        assertTrue(midway is StorageUiState.Data)
        assertTrue(midway.isRefreshing)
        assertEquals(100, midway.usage.totalBytes)
        advanceUntilIdle()
        val refreshed = viewModel.state.value
        assertTrue(refreshed is StorageUiState.Data)
        assertFalse(refreshed.isRefreshing)
        assertEquals(250, refreshed.usage.totalBytes)
    }

    @Test
    fun `storage 403 maps to forbidden`() = runTest {
        val viewModel = StorageViewModel(
            gateway = { throw ApiError(status = 403) },
            scope = newVmScope(),
        )
        viewModel.start()
        advanceUntilIdle()
        val state = viewModel.state.value
        assertTrue(state is StorageUiState.Error)
        assertTrue(state.isForbidden)
    }
}
