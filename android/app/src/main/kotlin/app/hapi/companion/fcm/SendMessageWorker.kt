package app.hapi.companion.fcm

import android.content.Context
import androidx.work.CoroutineWorker
import androidx.work.WorkerParameters
import app.hapi.companion.R
import app.hapi.companion.di.AppGraph
import app.hapi.companion.di.localizedForAppLanguage
import app.hapi.data.push.PushActionOutcome

/**
 * Delivers a notification inline reply (`POST /sessions/:id/messages`
 * `{text, localId}`). The `localId` is minted once at tap time and reused
 * across retries, so a retry after a half-delivered attempt cannot enqueue
 * the message twice (the hub reconciles by localId) — same optimistic-send
 * id the in-app composer uses.
 */
class SendMessageWorker(
    context: Context,
    params: WorkerParameters,
    private val appGraph: AppGraph,
) : CoroutineWorker(context, params) {

    override suspend fun doWork(): Result {
        val sessionId = inputData.getString(KEY_SESSION_ID) ?: return Result.failure()
        val text = inputData.getString(KEY_TEXT) ?: return Result.failure()
        val localId = inputData.getString(KEY_LOCAL_ID) ?: return Result.failure()
        val tag = inputData.getString(KEY_TAG) ?: return Result.failure()
        val channelId = inputData.getString(KEY_CHANNEL_ID) ?: return Result.failure()
        val title = inputData.getString(KEY_TITLE).orEmpty()

        appGraph.awaitReady()

        // In-app language (B-M5a): result strings resolve from the worker context.
        val context = applicationContext.localizedForAppLanguage(appGraph.appLanguage.value)
        return when (val outcome = appGraph.pushActionRunner.sendMessage(sessionId, text, localId)) {
            is PushActionOutcome.Success -> {
                result(tag, sessionId, channelId, title, context.getString(R.string.notif_reply_sent), autoExpire = true)
                Result.success()
            }
            is PushActionOutcome.SessionInactive -> {
                result(tag, sessionId, channelId, title, context.getString(R.string.notif_session_inactive), autoExpire = false)
                Result.failure()
            }
            PushActionOutcome.SessionNotFound -> {
                result(tag, sessionId, channelId, title, context.getString(R.string.notif_session_not_found), autoExpire = false)
                Result.failure()
            }
            is PushActionOutcome.AlreadyHandled, is PushActionOutcome.Failed -> {
                // AlreadyHandled cannot happen for message sends; treat both
                // as a hard rejection.
                result(tag, sessionId, channelId, title, context.getString(R.string.notif_reply_failed), autoExpire = false)
                Result.failure()
            }
            PushActionOutcome.Transient -> {
                if (runAttemptCount + 1 >= MAX_ATTEMPTS) {
                    result(tag, sessionId, channelId, title, context.getString(R.string.notif_reply_failed), autoExpire = false)
                    Result.failure()
                } else {
                    Result.retry()
                }
            }
        }
    }

    private fun result(
        tag: String,
        sessionId: String,
        channelId: String,
        title: String,
        text: String,
        autoExpire: Boolean,
    ) {
        PushNotifications.showActionResult(
            applicationContext.localizedForAppLanguage(appGraph.appLanguage.value),
            tag, sessionId, channelId, title, text, autoExpire,
        )
    }

    companion object {
        const val KEY_SESSION_ID = "sessionId"
        const val KEY_TEXT = "text"
        const val KEY_LOCAL_ID = "localId"
        const val KEY_TAG = "tag"
        const val KEY_CHANNEL_ID = "channelId"
        const val KEY_TITLE = "title"

        private const val MAX_ATTEMPTS = 5
    }
}
