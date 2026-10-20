package app.hapi.companion.wear

import android.util.Log
import androidx.work.BackoffPolicy
import androidx.work.Constraints
import androidx.work.ExistingWorkPolicy
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.WorkInfo
import androidx.work.WorkManager
import androidx.work.workDataOf
import app.hapi.companion.HapiApp
import app.hapi.companion.di.AppGraph
import app.hapi.companion.fcm.PermissionActionWorker
import app.hapi.companion.fcm.SendMessageWorker
import app.hapi.data.api.ApiError
import app.hapi.data.push.PushPayload
import app.hapi.data.push.PushType
import app.hapi.data.wear.WearContract
import app.hapi.data.wear.WearTranscript
import com.google.android.gms.wearable.DataEvent
import com.google.android.gms.wearable.DataEventBuffer
import com.google.android.gms.wearable.DataMap
import com.google.android.gms.wearable.DataMapItem
import com.google.android.gms.wearable.PutDataMapRequest
import com.google.android.gms.wearable.Wearable
import com.google.android.gms.wearable.WearableListenerService
import java.util.UUID
import java.util.concurrent.TimeUnit
import kotlin.coroutines.cancellation.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch

/**
 * Watch -> Phone: the phone is the only side holding hub credentials, so
 * every watch screen is really a remote view onto this service. All three
 * request paths resolve against the **active** paired hub only — the watch
 * mirrors whatever hub the phone app currently points at, not every paired
 * hub (unlike [app.hapi.data.push.PushActionRunner], which must guess which
 * hub owns a notification's session; the watch always knows "the" hub).
 */
class PhoneWearListenerService : WearableListenerService() {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)

    override fun onDataChanged(events: DataEventBuffer) {
        for (event in events) {
            if (event.type != DataEvent.TYPE_CHANGED) continue
            val map = DataMapItem.fromDataItem(event.dataItem).dataMap
            when (event.dataItem.uri.path) {
                WearContract.PATH_REQUEST_SESSIONS -> scope.launch { handleSessions() }
                WearContract.PATH_REQUEST_MESSAGES -> scope.launch { handleMessages(map) }
                WearContract.PATH_REQUEST_ACTION -> handleAction(map)
            }
        }
    }

    private val appGraph: AppGraph
        get() = (application as HapiApp).appGraph

    private suspend fun handleSessions() {
        val hubUrl = appGraph.pushHubAccess.registry.state.value.activeHubUrl
        if (hubUrl == null) {
            putResponse(WearContract.PATH_SESSIONS) { putString(WearContract.KEY_ERROR, "not_paired") }
            return
        }
        try {
            val response = appGraph.pushHubAccess.withApi(hubUrl) { api -> api.getSessions(limit = SESSIONS_LIMIT, order = "updatedAt") }
            val rows = ArrayList<DataMap>(response.sessions.size)
            for (session in response.sessions) {
                rows += DataMap().apply {
                    putString(WearContract.KEY_SESSION_ID, session.id)
                    putString(
                        WearContract.KEY_SESSION_NAME,
                        session.metadata?.name ?: session.metadata?.path ?: session.id.take(8),
                    )
                    putBoolean(WearContract.KEY_ACTIVE, session.active)
                    putBoolean(WearContract.KEY_THINKING, session.thinking)
                    putLong(WearContract.KEY_UPDATED_AT, session.updatedAt)
                    putInt(WearContract.KEY_BACKGROUND_TASK_COUNT, session.backgroundTaskCount)
                    putStringArrayList(WearContract.KEY_PENDING_REQUEST_KINDS, ArrayList(session.pendingRequestKinds))
                }
            }
            putResponse(WearContract.PATH_SESSIONS) { putDataMapArrayList(WearContract.KEY_SESSIONS, rows) }
        } catch (cancellation: CancellationException) {
            throw cancellation
        } catch (error: Exception) {
            Log.w(TAG, "handleSessions failed", error)
            putResponse(WearContract.PATH_SESSIONS) { putString(WearContract.KEY_ERROR, errorMessage(error)) }
        }
    }

    private suspend fun handleMessages(request: DataMap) {
        val sessionId = request.getString(WearContract.KEY_SESSION_ID) ?: return
        val limit = request.getInt(WearContract.KEY_LIMIT, MESSAGES_LIMIT).coerceIn(1, MESSAGES_LIMIT)
        val hubUrl = appGraph.pushHubAccess.registry.state.value.activeHubUrl
        if (hubUrl == null) {
            putResponse(WearContract.PATH_MESSAGES) {
                putString(WearContract.KEY_SESSION_ID, sessionId)
                putString(WearContract.KEY_ERROR, "not_paired")
            }
            return
        }
        try {
            val response = appGraph.pushHubAccess.withApi(hubUrl) { api -> api.getMessages(sessionId, limit = limit) }
            val rows = ArrayList<DataMap>()
            var truncatedChars = false
            for (message in response.messages) {
                val line = WearTranscript.extractLine(message) ?: continue
                val text = if (line.text.length > WearContract.MAX_MESSAGE_TEXT_CHARS) {
                    truncatedChars = true
                    line.text.take(WearContract.MAX_MESSAGE_TEXT_CHARS) + "…"
                } else line.text
                rows += DataMap().apply {
                    putString(WearContract.KEY_ROLE, line.role)
                    putString(WearContract.KEY_TEXT, text)
                    putLong(WearContract.KEY_CREATED_AT, line.createdAt)
                }
            }
            putResponse(WearContract.PATH_MESSAGES) {
                putString(WearContract.KEY_SESSION_ID, sessionId)
                putDataMapArrayList(WearContract.KEY_MESSAGES, rows)
                if (truncatedChars) putBoolean(WearContract.KEY_TRUNCATED, true)
            }
        } catch (cancellation: CancellationException) {
            throw cancellation
        } catch (error: Exception) {
            Log.w(TAG, "handleMessages failed", error)
            putResponse(WearContract.PATH_MESSAGES) {
                putString(WearContract.KEY_SESSION_ID, sessionId)
                putString(WearContract.KEY_ERROR, errorMessage(error))
            }
        }
    }

    /**
     * Reuses the exact same [PermissionActionWorker] / [SendMessageWorker]
     * WorkManager path `NotificationActionReceiver` uses for phone
     * notification taps: offline-surviving retry, and the phone's own
     * notification (if any) updates in step with the watch action. The
     * watch gets its own ack separately — see [PATH_ACTION_RESULT] below.
     */
    private fun handleAction(request: DataMap) {
        val sessionId = request.getString(WearContract.KEY_SESSION_ID) ?: return
        // When the action was triggered from a relayed push (the common
        // case: tapping Allow/Deny/Reply on the watch notification), the
        // watch echoes the original `rawType` so the phone can rebuild
        // PushPayload.notificationTag ("$rawType-$sessionId") and keep its
        // own notification for the same request in sync, instead of leaving
        // a stale Allow/Deny behind after the watch already answered it. A
        // proactive in-app send with no associated push has no type to
        // echo — falls back to a tag/channel nothing else will ever match.
        val rawType = request.getString(WearContract.KEY_TYPE)
        when (request.getString(WearContract.KEY_ACTION)) {
            WearContract.ACTION_APPROVE, WearContract.ACTION_DENY -> {
                val requestId = request.getString(WearContract.KEY_REQUEST_ID) ?: return
                val approve = request.getString(WearContract.KEY_ACTION) == WearContract.ACTION_APPROVE
                val tag = rawType?.let { "$it-$sessionId" } ?: "wear-$sessionId-$requestId"
                enqueueAndAck(
                    uniqueName = "wear-permission-$sessionId-$requestId",
                    work = OneTimeWorkRequestBuilder<PermissionActionWorker>().setInputData(
                        workDataOf(
                            PermissionActionWorker.KEY_SESSION_ID to sessionId,
                            PermissionActionWorker.KEY_REQUEST_ID to requestId,
                            PermissionActionWorker.KEY_APPROVE to approve,
                            PermissionActionWorker.KEY_TAG to tag,
                            PermissionActionWorker.KEY_CHANNEL_ID to PushPayload.CHANNEL_PERMISSION_REQUESTS,
                            PermissionActionWorker.KEY_TITLE to "",
                        )
                    ),
                    sessionId = sessionId,
                )
            }
            WearContract.ACTION_REPLY -> {
                val text = request.getString(WearContract.KEY_TEXT)?.trim()
                if (text.isNullOrEmpty()) return
                val localId = request.getString(WearContract.KEY_LOCAL_ID) ?: UUID.randomUUID().toString()
                val tag = rawType?.let { "$it-$sessionId" } ?: "wear-$sessionId-$localId"
                val channelId = if (rawType == PushType.READY.wire) {
                    PushPayload.CHANNEL_READY
                } else {
                    PushPayload.CHANNEL_TASK_NOTIFICATIONS
                }
                enqueueAndAck(
                    uniqueName = "wear-reply-$localId",
                    work = OneTimeWorkRequestBuilder<SendMessageWorker>().setInputData(
                        workDataOf(
                            SendMessageWorker.KEY_SESSION_ID to sessionId,
                            SendMessageWorker.KEY_TEXT to text,
                            SendMessageWorker.KEY_LOCAL_ID to localId,
                            SendMessageWorker.KEY_TAG to tag,
                            SendMessageWorker.KEY_CHANNEL_ID to channelId,
                            SendMessageWorker.KEY_TITLE to "",
                        )
                    ),
                    sessionId = sessionId,
                )
            }
        }
    }

    private fun enqueueAndAck(uniqueName: String, work: androidx.work.OneTimeWorkRequest.Builder, sessionId: String) {
        val request = work
            .setConstraints(Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build())
            .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 10L, TimeUnit.SECONDS)
            .build()
        val manager = WorkManager.getInstance(applicationContext)
        manager.enqueueUniqueWork(uniqueName, ExistingWorkPolicy.KEEP, request)
        scope.launch {
            // Best-effort ack: the first terminal WorkInfo for this unique
            // name. The phone notification (via PushNotifications) remains
            // the durable result surface; this just lets the watch screen
            // stop showing "sending...".
            val info = manager.getWorkInfosForUniqueWorkFlow(uniqueName)
                .first { infos -> infos.firstOrNull()?.state?.isFinished == true }
                .first()
            putResponse(WearContract.PATH_ACTION_RESULT) {
                putString(WearContract.KEY_SESSION_ID, sessionId)
                putBoolean(WearContract.KEY_OK, info.state == WorkInfo.State.SUCCEEDED)
            }
        }
    }

    private inline fun putResponse(path: String, build: DataMap.() -> Unit) {
        val request = PutDataMapRequest.create(path).apply {
            dataMap.build()
            dataMap.putLong(WearContract.KEY_TS, System.currentTimeMillis())
        }.asPutDataRequest().setUrgent()
        Wearable.getDataClient(applicationContext).putDataItem(request)
            .addOnFailureListener { error -> Log.w(TAG, "putResponse $path failed", error) }
    }

    private fun errorMessage(error: Exception): String = when (error) {
        is ApiError -> "hub_error_${error.status}"
        else -> "unreachable"
    }

    private companion object {
        const val TAG = "PhoneWearListener"
        const val SESSIONS_LIMIT = 15
        const val MESSAGES_LIMIT = 50
    }
}
