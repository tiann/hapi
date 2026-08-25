package app.hapi.companion.di

import android.content.Context
import androidx.work.ListenableWorker
import androidx.work.WorkerFactory
import androidx.work.WorkerParameters
import app.hapi.companion.fcm.PermissionActionWorker
import app.hapi.companion.fcm.RegisterDeviceWorker
import app.hapi.companion.fcm.SendMessageWorker

/**
 * Hand-rolled worker construction (no Hilt, per the plan): the push workers
 * need per-hub authed clients, which they reach through [AppGraph]'s push
 * surface (`PushActionRunner` / `DeviceRegistrar` — both build `HubSession`s
 * on demand from stored credentials, since no `HubGraph` may exist while a
 * background worker runs).
 *
 * Wired via `HapiApp implements Configuration.Provider` together with the
 * manifest's on-demand WorkManager initialization, so [AppGraph] exists
 * before the first worker is created even when WorkManager cold-starts the
 * process.
 */
class HapiWorkerFactory(private val appGraph: () -> AppGraph) : WorkerFactory() {

    override fun createWorker(
        appContext: Context,
        workerClassName: String,
        workerParameters: WorkerParameters,
    ): ListenableWorker? = when (workerClassName) {
        PermissionActionWorker::class.java.name ->
            PermissionActionWorker(appContext, workerParameters, appGraph())
        SendMessageWorker::class.java.name ->
            SendMessageWorker(appContext, workerParameters, appGraph())
        RegisterDeviceWorker::class.java.name ->
            RegisterDeviceWorker(appContext, workerParameters, appGraph())
        else -> null // unknown class: let WorkManager's default factory try
    }
}
