package app.hapi.companion.fcm

import android.content.Context
import androidx.work.CoroutineWorker
import androidx.work.WorkerParameters
import app.hapi.companion.R
import app.hapi.companion.di.AppGraph
import app.hapi.companion.di.localizedForAppLanguage
import app.hapi.data.push.PushActionOutcome

/**
 * Delivers a notification Allow/Deny through the authed client
 * (`POST /sessions/:id/permissions/:rid/approve|deny`, empty `{}` body).
 * Constructed by `HapiWorkerFactory` with the process [AppGraph]; the actual
 * hub resolution (active hub first, others on session-miss) lives in
 * `PushActionRunner` (`:core:data`).
 */
class PermissionActionWorker(
    context: Context,
    params: WorkerParameters,
    private val appGraph: AppGraph,
) : CoroutineWorker(context, params) {

    override suspend fun doWork(): Result {
        val sessionId = inputData.getString(KEY_SESSION_ID) ?: return Result.failure()
        val requestId = inputData.getString(KEY_REQUEST_ID) ?: return Result.failure()
        val approve = inputData.getBoolean(KEY_APPROVE, true)
        val tag = inputData.getString(KEY_TAG) ?: return Result.failure()
        val channelId = inputData.getString(KEY_CHANNEL_ID) ?: return Result.failure()
        val title = inputData.getString(KEY_TITLE).orEmpty()

        appGraph.awaitReady() // the persisted hub roster must be loaded first

        val runner = appGraph.pushActionRunner
        val outcome = if (approve) runner.approve(sessionId, requestId) else runner.deny(sessionId, requestId)

        // In-app language (B-M5a): result strings resolve from the worker context.
        val context = applicationContext.localizedForAppLanguage(appGraph.appLanguage.value)
        return when (outcome) {
            is PushActionOutcome.Success -> {
                result(tag, sessionId, channelId, title, context.getString(
                    if (approve) R.string.notif_allowed else R.string.notif_denied
                ), autoExpire = true)
                Result.success()
            }
            is PushActionOutcome.AlreadyHandled -> {
                result(tag, sessionId, channelId, title, context.getString(R.string.notif_already_handled), autoExpire = true)
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
            is PushActionOutcome.Failed -> {
                result(tag, sessionId, channelId, title, context.getString(R.string.notif_action_failed), autoExpire = false)
                Result.failure()
            }
            PushActionOutcome.Transient -> {
                if (runAttemptCount + 1 >= MAX_ATTEMPTS) {
                    result(tag, sessionId, channelId, title, context.getString(R.string.notif_action_failed), autoExpire = false)
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
        const val KEY_REQUEST_ID = "requestId"
        const val KEY_APPROVE = "approve"
        const val KEY_TAG = "tag"
        const val KEY_CHANNEL_ID = "channelId"
        const val KEY_TITLE = "title"

        private const val MAX_ATTEMPTS = 5
    }
}
