package app.hapi.companion.fcm

import android.app.Notification
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.app.RemoteInput
import app.hapi.companion.MainActivity
import app.hapi.companion.R
import app.hapi.data.push.PushPayload
import app.hapi.data.push.PushSeverity
import app.hapi.data.push.PushType

/**
 * Builds and updates the OS notifications behind FCM pushes (B-M4a).
 *
 * Identity: every notification for a session+type pair shares the tag
 * `type-<sessionId>` ([PushPayload.notificationTag]) and one fixed id — a
 * newer push *coalesces* (replaces) the previous one, and the action workers
 * update the same slot through pending → done/failed states.
 *
 * Actions (contract v1, known types only):
 *  - `permission-request` → Allow / Deny → [NotificationActionReceiver] →
 *    expedited [PermissionActionWorker].
 *  - `ready` / `task-notification` → inline Reply (RemoteInput) →
 *    [SendMessageWorker]; plus a mark-as-read style Dismiss.
 *
 * Unknown types / contract versions render title+body with tap-to-open only.
 */
object PushNotifications {

    /** Single id; per-notification identity comes from the tag. */
    private const val NOTIFICATION_ID = 0x4150 // 'HP'

    /** Internal intent route for notification taps (no public URI on purpose). */
    const val ACTION_OPEN_SESSION = "app.hapi.companion.action.OPEN_SESSION"
    const val EXTRA_SESSION_ID = "app.hapi.companion.extra.SESSION_ID"

    const val KEY_REMOTE_INPUT = "hapi_reply"

    /** Severity accents per `hub/src/fcm/fcmService.ts` (blue/green/amber/red). */
    private fun severityColor(severity: PushSeverity?): Int? = when (severity) {
        PushSeverity.INFO -> 0xFF3B82F6.toInt()
        PushSeverity.SUCCESS -> 0xFF22C55E.toInt()
        PushSeverity.WARNING -> 0xFFF59E0B.toInt()
        PushSeverity.ERROR -> 0xFFEF4444.toInt()
        null -> null
    }

    /** Renders [payload] (already past the suppress-when-open check). */
    fun show(context: Context, payload: PushPayload) {
        val builder = baseBuilder(context, payload.channelId, payload.sessionId)
            .setContentTitle(payload.displayTitle)
            .setContentText(firstLine(payload.displayBody))
            .setStyle(NotificationCompat.BigTextStyle().bigText(payload.displayBody))
            .setSubText(payload.sessionName?.takeIf { it != payload.displayTitle })
            .setAutoCancel(true)

        severityColor(payload.severity)?.let(builder::setColor)

        if (payload.supportsActions) {
            when (payload.type) {
                PushType.PERMISSION_REQUEST -> addPermissionActions(context, builder, payload)
                PushType.READY, PushType.TASK_NOTIFICATION -> addReplyActions(context, builder, payload)
                null -> Unit
            }
        }

        notify(context, payload.notificationTag, builder.build())
    }

    // ------------------------------------------------------ action updates --

    /** Replaces the notification with an in-progress state (actions removed). */
    fun showActionProgress(
        context: Context,
        tag: String,
        sessionId: String?,
        channelId: String,
        title: String,
        text: String,
    ) {
        val builder = baseBuilder(context, channelId, sessionId)
            .setContentTitle(title)
            .setContentText(text)
            .setOnlyAlertOnce(true)
            .setOngoing(true)
            .setProgress(0, 0, true)
        notify(context, tag, builder.build())
    }

    /**
     * Terminal state after a worker finished. Success-ish results self-expire
     * ([Notification.Builder.setTimeoutAfter]); failures stay until dismissed.
     */
    fun showActionResult(
        context: Context,
        tag: String,
        sessionId: String?,
        channelId: String,
        title: String,
        text: String,
        autoExpire: Boolean,
    ) {
        val builder = baseBuilder(context, channelId, sessionId)
            .setContentTitle(title)
            .setContentText(text)
            .setStyle(NotificationCompat.BigTextStyle().bigText(text))
            .setOnlyAlertOnce(true)
            .setAutoCancel(true)
        if (autoExpire) builder.setTimeoutAfter(RESULT_TIMEOUT_MS)
        notify(context, tag, builder.build())
    }

    fun cancel(context: Context, tag: String) {
        NotificationManagerCompat.from(context).cancel(tag, NOTIFICATION_ID)
    }

    // ------------------------------------------------------------- helpers --

    private fun baseBuilder(context: Context, channelId: String, sessionId: String?) =
        NotificationCompat.Builder(context, channelId)
            .setSmallIcon(R.drawable.ic_stat_hapi)
            .apply { sessionId?.let { setContentIntent(openSessionIntent(context, it)) } }

    private fun notify(context: Context, tag: String, notification: Notification) {
        val manager = NotificationManagerCompat.from(context)
        // POST_NOTIFICATIONS may be ungranted (API 33+) — notify() would be
        // silently dropped anyway; skipping keeps lint honest and explicit.
        if (!manager.areNotificationsEnabled()) return
        try {
            manager.notify(tag, NOTIFICATION_ID, notification)
        } catch (_: SecurityException) {
            // Permission revoked between check and post: nothing to show.
        }
    }

    /**
     * Tap-through: an explicit intent into [MainActivity] carrying the
     * session id — MainActivity feeds it to the existing navigation flow
     * (`AppGraph.pendingOpenSessionId`). Deliberately *not* a URI deep link:
     * this route is internal, nothing external should be able to speak it.
     */
    private fun openSessionIntent(context: Context, sessionId: String): PendingIntent {
        val intent = Intent(context, MainActivity::class.java)
            .setAction(ACTION_OPEN_SESSION)
            .putExtra(EXTRA_SESSION_ID, sessionId)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        return PendingIntent.getActivity(
            context,
            requestCode(sessionId, slot = 0),
            intent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
    }

    private fun addPermissionActions(
        context: Context,
        builder: NotificationCompat.Builder,
        payload: PushPayload,
    ) {
        val requestId = payload.requestId ?: return
        builder.addAction(
            NotificationCompat.Action.Builder(
                /* icon = */ 0,
                context.getString(R.string.notif_action_allow),
                actionIntent(context, NotificationActionReceiver.ACTION_APPROVE, payload, requestId, slot = 1),
            ).build()
        )
        builder.addAction(
            NotificationCompat.Action.Builder(
                /* icon = */ 0,
                context.getString(R.string.notif_action_deny),
                actionIntent(context, NotificationActionReceiver.ACTION_DENY, payload, requestId, slot = 2),
            ).build()
        )
    }

    private fun addReplyActions(
        context: Context,
        builder: NotificationCompat.Builder,
        payload: PushPayload,
    ) {
        val remoteInput = RemoteInput.Builder(KEY_REMOTE_INPUT)
            .setLabel(context.getString(R.string.notif_reply_hint))
            .build()
        builder.addAction(
            NotificationCompat.Action.Builder(
                /* icon = */ 0,
                context.getString(R.string.notif_action_reply),
                actionIntent(
                    context,
                    NotificationActionReceiver.ACTION_REPLY,
                    payload,
                    requestId = null,
                    slot = 3,
                    // RemoteInput results must be attachable → mutable.
                    mutable = true,
                ),
            ).addRemoteInput(remoteInput).setAllowGeneratedReplies(false).build()
        )
        builder.addAction(
            NotificationCompat.Action.Builder(
                /* icon = */ 0,
                context.getString(R.string.notif_action_dismiss),
                actionIntent(context, NotificationActionReceiver.ACTION_DISMISS, payload, requestId = null, slot = 4),
            ).build()
        )
    }

    private fun actionIntent(
        context: Context,
        action: String,
        payload: PushPayload,
        requestId: String?,
        slot: Int,
        mutable: Boolean = false,
    ): PendingIntent {
        val intent = Intent(context, NotificationActionReceiver::class.java)
            .setAction(action)
            .putExtra(NotificationActionReceiver.EXTRA_SESSION_ID, payload.sessionId)
            .putExtra(NotificationActionReceiver.EXTRA_TAG, payload.notificationTag)
            .putExtra(NotificationActionReceiver.EXTRA_CHANNEL_ID, payload.channelId)
            .putExtra(NotificationActionReceiver.EXTRA_TITLE, payload.displayTitle)
            .apply { requestId?.let { putExtra(NotificationActionReceiver.EXTRA_REQUEST_ID, it) } }
        val mutability = if (mutable) PendingIntent.FLAG_MUTABLE else PendingIntent.FLAG_IMMUTABLE
        return PendingIntent.getBroadcast(
            context,
            requestCode(payload.notificationTag, slot),
            intent,
            PendingIntent.FLAG_UPDATE_CURRENT or mutability,
        )
    }

    /** Distinct PendingIntents per (tag, action-slot) so extras never collide. */
    private fun requestCode(key: String, slot: Int): Int = key.hashCode() * 31 + slot

    private fun firstLine(text: String): String = text.lineSequence().firstOrNull().orEmpty()

    private const val RESULT_TIMEOUT_MS = 5_000L
}
