package app.hapi.companion.wear.notify

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import androidx.core.app.RemoteInput
import app.hapi.companion.wear.data.WatchRequests

/** Handles a tap on a watch notification's Allow / Deny / Reply action. */
class WearNotificationActionReceiver : BroadcastReceiver() {

    override fun onReceive(context: Context, intent: Intent) {
        val sessionId = intent.getStringExtra(WearNotifications.EXTRA_SESSION_ID) ?: return
        val type = intent.getStringExtra(WearNotifications.EXTRA_TYPE)
        when (intent.action) {
            WearNotifications.ACTION_APPROVE -> {
                val requestId = intent.getStringExtra(WearNotifications.EXTRA_REQUEST_ID) ?: return
                WatchRequests.approve(context, sessionId, requestId, type)
                WearNotifications.cancel(context, sessionId)
            }
            WearNotifications.ACTION_DENY -> {
                val requestId = intent.getStringExtra(WearNotifications.EXTRA_REQUEST_ID) ?: return
                WatchRequests.deny(context, sessionId, requestId, type)
                WearNotifications.cancel(context, sessionId)
            }
            WearNotifications.ACTION_REPLY -> {
                val text = RemoteInput.getResultsFromIntent(intent)
                    ?.getCharSequence(WearNotifications.KEY_REMOTE_INPUT)
                    ?.toString()?.trim()
                if (text.isNullOrEmpty()) return
                WatchRequests.reply(context, sessionId, text, type)
                WearNotifications.cancel(context, sessionId)
            }
        }
    }
}
