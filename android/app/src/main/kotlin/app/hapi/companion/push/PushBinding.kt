package app.hapi.companion.push

import android.content.Context
import com.google.android.gms.tasks.Task
import com.google.firebase.FirebaseApp
import com.google.firebase.messaging.FirebaseMessaging
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException
import kotlinx.coroutines.suspendCancellableCoroutine

/**
 * The one seam between the app and Firebase (B-M4a). firebase-messaging is
 * always on the classpath, but the SDK only *activates* when a Firebase
 * project is bound — today via `app/google-services.json` (the
 * google-services plugin is applied conditionally; without the file,
 * `FirebaseInitProvider` finds no default options and initializes nothing).
 *
 * Every push code path (registrar, FCM service, workers, permission prompt)
 * checks [isAvailable] / gets a null [currentToken] and no-ops cleanly when
 * Firebase isn't configured — a config-less self-build behaves exactly like
 * pre-M4a, just without push.
 *
 * v1.x path (planned, per the native-clients plan): bind Firebase at runtime
 * from hub-provided config instead — `FirebaseApp.initializeApp(context,
 * FirebaseOptions.Builder()…)` with values the hub serves alongside pairing.
 * That lands entirely behind this object: [isAvailable] flips true once the
 * runtime init succeeds, and nothing else in the app changes.
 */
object PushBinding {

    /** True when a [FirebaseApp] is bound (google-services.json present). */
    fun isAvailable(context: Context): Boolean = try {
        FirebaseApp.getApps(context.applicationContext).isNotEmpty()
    } catch (_: Throwable) {
        false // defensive: a broken Firebase runtime must never take the app down
    }

    /**
     * Current FCM registration token, or null when push is unavailable or
     * the fetch failed (offline first start — `onNewToken` covers us later).
     */
    suspend fun currentToken(context: Context): String? {
        if (!isAvailable(context)) return null
        return try {
            FirebaseMessaging.getInstance().token.awaitTask()
        } catch (_: Exception) {
            null
        }
    }
}

/** Minimal Task-to-coroutine bridge (avoids the play-services coroutines dep). */
private suspend fun <T> Task<T>.awaitTask(): T = suspendCancellableCoroutine { continuation ->
    addOnCompleteListener { task ->
        val error = task.exception
        when {
            error != null -> continuation.resumeWithException(error)
            task.isCanceled -> continuation.cancel()
            else -> continuation.resume(task.result)
        }
    }
}
