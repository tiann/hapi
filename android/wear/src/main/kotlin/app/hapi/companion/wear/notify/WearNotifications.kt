package app.hapi.companion.wear.notify

import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.app.RemoteInput
import app.hapi.companion.wear.MainActivity
import app.hapi.companion.wear.R
import app.hapi.companion.wear.data.WearNotifyEvent

/**
 * Watch-side rendering of a relayed push. Deliberately simpler than the
 * phone's `PushNotifications` — no channel routing by type (one default
 * importance channel is enough on a one-app-at-a-time watch), no result
 * notifications (see [WearNotificationActionReceiver]; the phone's own
 * notification, if any, is the durable success/failure surface).
 */
object WearNotifications {
    private const val CHANNEL_ID = "hapi_wear_default"
    private const val NOTIFICATION_ID = 0x4150
    const val KEY_REMOTE_INPUT = "hapi_wear_reply"

    private fun ensureChannel(context: Context) {
        val manager = NotificationManagerCompat.from(context)
        if (manager.getNotificationChannel(CHANNEL_ID) != null) return
        manager.createNotificationChannel(
            android.app.NotificationChannel(
                CHANNEL_ID,
                context.getString(R.string.app_name),
                android.app.NotificationManager.IMPORTANCE_HIGH,
            )
        )
    }

    fun show(context: Context, event: WearNotifyEvent) {
        ensureChannel(context)
        val builder = NotificationCompat.Builder(context, CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_stat_hapi)
            .setContentTitle(event.title ?: event.sessionName ?: "HAPI")
            .setContentText(event.body.orEmpty())
            .setStyle(NotificationCompat.BigTextStyle().bigText(event.body.orEmpty()))
            .setAutoCancel(true)
            .setContentIntent(openSessionIntent(context, event.sessionId))

        if (event.supportsActions) {
            if (event.requestId != null) {
                builder.addAction(action(context, ACTION_APPROVE, context.getString(R.string.action_allow), event))
                builder.addAction(action(context, ACTION_DENY, context.getString(R.string.action_deny), event))
            } else {
                builder.addAction(replyAction(context, event))
            }
        }

        val manager = NotificationManagerCompat.from(context)
        if (!manager.areNotificationsEnabled()) return
        try {
            manager.notify(event.sessionId, NOTIFICATION_ID, builder.build())
        } catch (_: SecurityException) {
            // Permission revoked between the check and the post: nothing to show.
        }
    }

    fun cancel(context: Context, sessionId: String) {
        NotificationManagerCompat.from(context).cancel(sessionId, NOTIFICATION_ID)
    }

    private fun openSessionIntent(context: Context, sessionId: String): PendingIntent {
        val intent = Intent(context, MainActivity::class.java)
            .putExtra(EXTRA_SESSION_ID, sessionId)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP)
        return PendingIntent.getActivity(
            context, sessionId.hashCode(), intent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
    }

    private fun action(context: Context, action: String, label: String, event: WearNotifyEvent): NotificationCompat.Action {
        val intent = Intent(context, WearNotificationActionReceiver::class.java)
            .setAction(action)
            .putExtra(EXTRA_SESSION_ID, event.sessionId)
            .putExtra(EXTRA_REQUEST_ID, event.requestId)
            .putExtra(EXTRA_TYPE, event.type)
        val pending = PendingIntent.getBroadcast(
            context, (action + event.sessionId).hashCode(), intent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        return NotificationCompat.Action.Builder(0, label, pending).build()
    }

    private fun replyAction(context: Context, event: WearNotifyEvent): NotificationCompat.Action {
        val intent = Intent(context, WearNotificationActionReceiver::class.java)
            .setAction(ACTION_REPLY)
            .putExtra(EXTRA_SESSION_ID, event.sessionId)
            .putExtra(EXTRA_TYPE, event.type)
        val pending = PendingIntent.getBroadcast(
            context, (ACTION_REPLY + event.sessionId).hashCode(), intent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_MUTABLE,
        )
        val remoteInput = RemoteInput.Builder(KEY_REMOTE_INPUT)
            .setLabel(context.getString(R.string.action_reply))
            .build()
        return NotificationCompat.Action.Builder(0, context.getString(R.string.action_reply), pending)
            .addRemoteInput(remoteInput)
            .build()
    }

    const val ACTION_APPROVE = "app.hapi.companion.wear.action.APPROVE"
    const val ACTION_DENY = "app.hapi.companion.wear.action.DENY"
    const val ACTION_REPLY = "app.hapi.companion.wear.action.REPLY"
    const val EXTRA_SESSION_ID = "app.hapi.companion.wear.extra.SESSION_ID"
    const val EXTRA_REQUEST_ID = "app.hapi.companion.wear.extra.REQUEST_ID"
    const val EXTRA_TYPE = "app.hapi.companion.wear.extra.TYPE"
}
