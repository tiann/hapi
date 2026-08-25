package app.hapi.companion.fcm

import android.app.NotificationChannel
import android.app.NotificationManager
import android.content.Context
import app.hapi.companion.R
import app.hapi.data.push.PushPayload

/**
 * The app's notification channels, created idempotently on app start
 * (`HapiApp.onCreate`) so they exist before the first FCM message — channel
 * routing itself lives in [PushPayload.channelId]:
 *
 *  - `permission_requests` — HIGH: an agent is blocked on the operator; the
 *    heads-up + sound interruption is the point.
 *  - `ready` — DEFAULT: the agent finished and is waiting for input.
 *  - `task_notifications` — DEFAULT: task completed/failed; also the bucket
 *    for unknown types / contract versions (never heads-up for those).
 *
 * minSdk is 26, so the channel APIs are unconditionally available. Importance
 * is only a creation-time default — operators can retune per channel in
 * system settings, which is exactly why these are three separate channels.
 */
object NotificationChannels {

    fun ensureCreated(context: Context) {
        val manager = context.getSystemService(NotificationManager::class.java) ?: return
        manager.createNotificationChannels(
            listOf(
                NotificationChannel(
                    PushPayload.CHANNEL_PERMISSION_REQUESTS,
                    context.getString(R.string.channel_permission_requests),
                    NotificationManager.IMPORTANCE_HIGH,
                ).apply {
                    description = context.getString(R.string.channel_permission_requests_desc)
                },
                NotificationChannel(
                    PushPayload.CHANNEL_READY,
                    context.getString(R.string.channel_ready),
                    NotificationManager.IMPORTANCE_DEFAULT,
                ).apply {
                    description = context.getString(R.string.channel_ready_desc)
                },
                NotificationChannel(
                    PushPayload.CHANNEL_TASK_NOTIFICATIONS,
                    context.getString(R.string.channel_task_notifications),
                    NotificationManager.IMPORTANCE_DEFAULT,
                ).apply {
                    description = context.getString(R.string.channel_task_notifications_desc)
                },
            )
        )
    }
}
