package app.hapi.companion.fcm

import android.content.Context
import androidx.work.BackoffPolicy
import androidx.work.Constraints
import androidx.work.CoroutineWorker
import androidx.work.ExistingWorkPolicy
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.WorkerParameters
import androidx.work.workDataOf
import app.hapi.companion.di.AppGraph
import java.util.concurrent.TimeUnit
import kotlin.coroutines.cancellation.CancellationException

/**
 * Retries a transiently failed `POST /api/devices/register` for one hub
 * (enqueued by `DeviceRegistrar`'s retry seam). Network-constrained with
 * exponential backoff; gives up after [MAX_ATTEMPTS] — the next app start /
 * token rotation re-registers everything anyway.
 */
class RegisterDeviceWorker(
    context: Context,
    params: WorkerParameters,
    private val appGraph: AppGraph,
) : CoroutineWorker(context, params) {

    override suspend fun doWork(): Result {
        val hubUrl = inputData.getString(KEY_HUB_URL) ?: return Result.failure()
        appGraph.awaitReady()
        // The hub may have been signed out while this retry waited.
        if (hubUrl !in appGraph.hubRegistry.state.value.hubs) return Result.success()
        return try {
            appGraph.deviceRegistrar.registerHubOnce(hubUrl)
            Result.success()
        } catch (cancellation: CancellationException) {
            throw cancellation
        } catch (_: Exception) {
            if (runAttemptCount + 1 >= MAX_ATTEMPTS) Result.failure() else Result.retry()
        }
    }

    companion object {
        const val KEY_HUB_URL = "hubUrl"
        private const val MAX_ATTEMPTS = 6
        private const val BACKOFF_SECONDS = 30L

        /** One pending retry per hub; a fresh failure replaces the schedule. */
        fun enqueueRetry(context: Context, hubUrl: String) {
            val work = OneTimeWorkRequestBuilder<RegisterDeviceWorker>()
                .setInputData(workDataOf(KEY_HUB_URL to hubUrl))
                .setConstraints(
                    Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build()
                )
                .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, BACKOFF_SECONDS, TimeUnit.SECONDS)
                .build()
            WorkManager.getInstance(context)
                .enqueueUniqueWork("push-register-$hubUrl", ExistingWorkPolicy.REPLACE, work)
        }
    }
}
