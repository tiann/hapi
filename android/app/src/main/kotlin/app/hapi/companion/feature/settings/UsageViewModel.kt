package app.hapi.companion.feature.settings

import app.hapi.data.api.ApiError
import app.hapi.protocol.wire.UsageSummaryResponse
import java.time.LocalDate
import java.time.ZoneId
import kotlin.coroutines.cancellation.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch

/** Wire values of the `range` query param (web `UsageRange`). */
enum class UsageRange(val wireValue: String, val days: Int?) {
    SEVEN_DAYS("7d", 7),
    THIRTY_DAYS("30d", 30),
    ALL("all", null),
}

/** Transport seam (`HapiApi.getUsageSummary`) so JVM tests fake the hub. */
fun interface UsageGateway {
    suspend fun summary(range: String, timeZone: String): UsageSummaryResponse
}

sealed interface UsageUiState {
    data object Loading : UsageUiState

    data class Error(
        val message: String?,
        /** 403: the hub rejected a non-owner namespace — explain, don't retry. */
        val isForbidden: Boolean,
    ) : UsageUiState

    data class Data(
        val summary: UsageSummaryResponse,
        /** Chart series: calendar-filled for 7d/30d, sparse for all. */
        val dailyBars: List<UsageMath.DailyBar>,
    ) : UsageUiState
}

/**
 * Usage-dashboard state: one in-flight load per range selection (a range
 * switch cancels the previous fetch), device zone for both the `timeZone`
 * param and the calendar fill so the two agree on day keys.
 */
class UsageViewModel(
    private val gateway: UsageGateway,
    private val scope: CoroutineScope,
    private val zone: ZoneId = ZoneId.systemDefault(),
    /** Injectable for deterministic calendar-fill tests. */
    private val today: () -> LocalDate = { LocalDate.now(zone) },
) {

    private val mutableRange = MutableStateFlow(UsageRange.SEVEN_DAYS)

    val range: StateFlow<UsageRange> = mutableRange.asStateFlow()

    private val mutableState = MutableStateFlow<UsageUiState>(UsageUiState.Loading)

    val state: StateFlow<UsageUiState> = mutableState.asStateFlow()

    private var loadJob: Job? = null

    fun start() {
        if (loadJob == null) load(mutableRange.value)
    }

    fun setRange(range: UsageRange) {
        if (mutableRange.value == range) return
        mutableRange.value = range
        load(range)
    }

    fun retry() {
        load(mutableRange.value)
    }

    private fun load(range: UsageRange) {
        loadJob?.cancel()
        mutableState.value = UsageUiState.Loading
        loadJob = scope.launch {
            mutableState.value = try {
                val summary = gateway.summary(range.wireValue, zone.id)
                UsageUiState.Data(
                    summary = summary,
                    dailyBars = UsageMath.dailyBars(summary.daily, range.days, today()),
                )
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                UsageUiState.Error(
                    message = e.message,
                    isForbidden = (e as? ApiError)?.status == 403,
                )
            }
        }
    }
}
