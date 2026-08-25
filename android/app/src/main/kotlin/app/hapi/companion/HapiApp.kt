package app.hapi.companion

import android.app.Application
import androidx.lifecycle.DefaultLifecycleObserver
import androidx.lifecycle.LifecycleOwner
import androidx.lifecycle.ProcessLifecycleOwner
import androidx.work.Configuration
import app.hapi.companion.di.AppGraph
import app.hapi.companion.di.HapiWorkerFactory
import app.hapi.companion.fcm.NotificationChannels

/**
 * Owns the process-singleton [AppGraph]. Compose reads it through
 * [app.hapi.companion.di.LocalAppGraph]; non-Compose entry points (FCM
 * service, WorkManager workers) reach it via `(context.applicationContext as
 * HapiApp).appGraph`.
 *
 * Also bridges [ProcessLifecycleOwner] into the graph (B-M3ab): foreground /
 * background drives `SseEngine.setLifecycleForeground` (retry deferral,
 * stale-socket rebuild on resume) and `POST /api/visibility` reporting so the
 * hub can suppress redundant push while the app is visibly connected.
 *
 * Push (B-M4a): notification channels are created here so they exist before
 * the first FCM message, and WorkManager is switched to on-demand
 * initialization (manifest removes the default initializer) with
 * [HapiWorkerFactory] — the push workers need [AppGraph], which this class
 * guarantees exists first even when WorkManager cold-starts the process.
 */
class HapiApp : Application(), Configuration.Provider {

    lateinit var appGraph: AppGraph
        private set

    override fun onCreate() {
        super.onCreate()
        appGraph = AppGraph(this)
        appGraph.start()
        NotificationChannels.ensureCreated(this)
        ProcessLifecycleOwner.get().lifecycle.addObserver(object : DefaultLifecycleObserver {
            override fun onStart(owner: LifecycleOwner) {
                appGraph.setForeground(true)
            }

            override fun onStop(owner: LifecycleOwner) {
                appGraph.setForeground(false)
            }
        })
    }

    override val workManagerConfiguration: Configuration
        get() = Configuration.Builder()
            .setWorkerFactory(HapiWorkerFactory { appGraph })
            .build()
}
