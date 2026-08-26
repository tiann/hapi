package app.hapi.companion.feature.settings

import app.hapi.data.api.ApiError
import app.hapi.protocol.wire.SqliteStorageUsageResponse
import kotlin.coroutines.cancellation.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch

/** Transport seam (`HapiApi.getSqliteStorageUsage`) for JVM tests. */
fun interface StorageGateway {
    suspend fun sqliteUsage(): SqliteStorageUsageResponse
}

sealed interface StorageUiState {
    data object Loading : StorageUiState

    data class Error(
        val message: String?,
        /** 403: non-owner namespace (mirror of the usage screen). */
        val isForbidden: Boolean,
    ) : StorageUiState

    data class Data(
        val usage: SqliteStorageUsageResponse,
        val isRefreshing: Boolean = false,
    ) : StorageUiState
}

/** Storage-dashboard state: initial load + explicit refresh (web parity). */
class StorageViewModel(
    private val gateway: StorageGateway,
    private val scope: CoroutineScope,
) {

    private val mutableState = MutableStateFlow<StorageUiState>(StorageUiState.Loading)

    val state: StateFlow<StorageUiState> = mutableState.asStateFlow()

    private var loadJob: Job? = null

    fun start() {
        if (loadJob == null) refresh()
    }

    fun refresh() {
        if ((mutableState.value as? StorageUiState.Data)?.isRefreshing == true) return
        loadJob?.cancel()
        mutableState.value = when (val current = mutableState.value) {
            is StorageUiState.Data -> current.copy(isRefreshing = true)
            else -> StorageUiState.Loading
        }
        loadJob = scope.launch {
            mutableState.value = try {
                StorageUiState.Data(gateway.sqliteUsage())
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                StorageUiState.Error(
                    message = e.message,
                    isForbidden = (e as? ApiError)?.status == 403,
                )
            }
        }
    }
}
