package app.hapi.companion.push

import android.content.Context
import com.google.android.gms.tasks.Task
import com.google.firebase.FirebaseApp
import com.google.firebase.messaging.FirebaseMessaging
import java.io.IOException
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
 * Official builds bundle the maintainer's client config. The paired hub
 * selects encrypted relay or private direct FCM; the app never receives
 * service-account credentials and does not provision Firebase at runtime.
 */
object PushBinding {

    /** True when a [FirebaseApp] is bound (google-services.json present). */
    fun isAvailable(context: Context): Boolean = try {
        FirebaseApp.getApps(context.applicationContext).isNotEmpty()
    } catch (_: Throwable) {
        false // defensive: a broken Firebase runtime must never take the app down
    }

    /** Null only when unconfigured. Propagate lookup failures to the registrar for retry. */
    suspend fun currentToken(context: Context): String? {
        if (!isAvailable(context)) return null
        return FirebaseMessaging.getInstance().token.awaitTask()
    }
}

/** Minimal Task-to-coroutine bridge (avoids the play-services coroutines dep). */
private suspend fun <T> Task<T>.awaitTask(): T = suspendCancellableCoroutine { continuation ->
    addOnCompleteListener { task ->
        val error = task.exception
        when {
            error != null -> continuation.resumeWithException(error)
            task.isCanceled -> continuation.resumeWithException(IOException("Firebase token lookup cancelled"))
            else -> continuation.resume(task.result)
        }
    }
}
