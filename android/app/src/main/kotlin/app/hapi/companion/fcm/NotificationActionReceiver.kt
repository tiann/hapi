package app.hapi.companion.fcm

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.os.Build
import androidx.core.app.RemoteInput
import androidx.work.BackoffPolicy
import androidx.work.Constraints
import androidx.work.ExistingWorkPolicy
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequest
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.OutOfQuotaPolicy
import androidx.work.WorkManager
import androidx.work.workDataOf
import app.hapi.companion.HapiApp
import app.hapi.companion.R
import app.hapi.companion.di.localizedForAppLanguage
import java.util.UUID
import java.util.concurrent.TimeUnit

/**
 * Handles notification action taps (Allow / Deny / Reply / Dismiss). The
 * receiver itself does no I/O — it flips the notification to an in-progress
 * state and hands the REST call to an **expedited** WorkManager worker, so
 * the action survives process death, offline gaps, and JWT expiry (the
 * worker re-auths through the stored credentials).
 */
class NotificationActionReceiver : BroadcastReceiver() {

    override fun onReceive(context: Context, intent: Intent) {
        val sessionId = intent.getStringExtra(EXTRA_SESSION_ID) ?: return
        val tag = intent.getStringExtra(EXTRA_TAG) ?: return
        val channelId = intent.getStringExtra(EXTRA_CHANNEL_ID) ?: return
        val title = intent.getStringExtra(EXTRA_TITLE) ?: ""

        // In-app language (B-M5a): progress strings resolve from the receiver
        // context, which per-app locales miss on API < 33.
        val localized = (context.applicationContext as? HapiApp)
            ?.appGraph?.appLanguage?.value
            ?.let(context::localizedForAppLanguage) ?: context

        when (intent.action) {
            ACTION_APPROVE, ACTION_DENY -> {
                val requestId = intent.getStringExtra(EXTRA_REQUEST_ID) ?: return
                val approve = intent.action == ACTION_APPROVE
                PushNotifications.showActionProgress(
                    localized, tag, sessionId, channelId, title,
                    localized.getString(if (approve) R.string.notif_allowing else R.string.notif_denying),
                )
                enqueueExpedited(
                    context,
                    // One work item per decision — a second tap (or the other
                    // button racing) keeps the first decision.
                    uniqueName = "push-permission-$sessionId-$requestId",
                    request = OneTimeWorkRequestBuilder<PermissionActionWorker>()
                        .setInputData(
                            workDataOf(
                                PermissionActionWorker.KEY_SESSION_ID to sessionId,
                                PermissionActionWorker.KEY_REQUEST_ID to requestId,
                                PermissionActionWorker.KEY_APPROVE to approve,
                                PermissionActionWorker.KEY_TAG to tag,
                                PermissionActionWorker.KEY_CHANNEL_ID to channelId,
                                PermissionActionWorker.KEY_TITLE to title,
                            )
                        ),
                )
            }

            ACTION_REPLY -> {
                val text = RemoteInput.getResultsFromIntent(intent)
                    ?.getCharSequence(PushNotifications.KEY_REMOTE_INPUT)
                    ?.toString()?.trim()
                if (text.isNullOrEmpty()) {
                    // Empty reply: nothing to send; clear the inline spinner.
                    PushNotifications.cancel(context, tag)
                    return
                }
                PushNotifications.showActionProgress(
                    localized, tag, sessionId, channelId, title,
                    localized.getString(R.string.notif_sending),
                )
                val localId = UUID.randomUUID().toString()
                enqueueExpedited(
                    context,
                    uniqueName = "push-reply-$localId",
                    request = OneTimeWorkRequestBuilder<SendMessageWorker>()
                        .setInputData(
                            workDataOf(
                                SendMessageWorker.KEY_SESSION_ID to sessionId,
                                SendMessageWorker.KEY_TEXT to text,
                                SendMessageWorker.KEY_LOCAL_ID to localId,
                                SendMessageWorker.KEY_TAG to tag,
                                SendMessageWorker.KEY_CHANNEL_ID to channelId,
                                SendMessageWorker.KEY_TITLE to title,
                            )
                        ),
                )
            }

            ACTION_DISMISS -> PushNotifications.cancel(context, tag)
        }
    }

    private fun enqueueExpedited(
        context: Context,
        uniqueName: String,
        request: OneTimeWorkRequest.Builder,
    ) {
        val work = request
            // Expedited only where it rides JobScheduler (API 31+). Below 31
            // expedited work must run as a foreground service — the FGS
            // permissions plus the Play Console declaration they drag in are
            // not worth a few seconds of enqueue latency on 26–30.
            .apply {
                if (Build.VERSION.SDK_INT >= 31) {
                    setExpedited(OutOfQuotaPolicy.RUN_AS_NON_EXPEDITED_WORK_REQUEST)
                }
            }
            .setConstraints(Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build())
            .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, BACKOFF_SECONDS, TimeUnit.SECONDS)
            .build()
        WorkManager.getInstance(context).enqueueUniqueWork(uniqueName, ExistingWorkPolicy.KEEP, work)
    }

    companion object {
        const val ACTION_APPROVE = "app.hapi.companion.action.PERMISSION_APPROVE"
        const val ACTION_DENY = "app.hapi.companion.action.PERMISSION_DENY"
        const val ACTION_REPLY = "app.hapi.companion.action.NOTIFICATION_REPLY"
        const val ACTION_DISMISS = "app.hapi.companion.action.NOTIFICATION_DISMISS"

        const val EXTRA_SESSION_ID = "app.hapi.companion.extra.SESSION_ID"
        const val EXTRA_REQUEST_ID = "app.hapi.companion.extra.REQUEST_ID"
        const val EXTRA_TAG = "app.hapi.companion.extra.TAG"
        const val EXTRA_CHANNEL_ID = "app.hapi.companion.extra.CHANNEL_ID"
        const val EXTRA_TITLE = "app.hapi.companion.extra.TITLE"

        private const val BACKOFF_SECONDS = 10L
    }
}
