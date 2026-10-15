package app.hapi.companion.wear.data

import app.hapi.companion.wear.notify.WearNotifications
import app.hapi.data.wear.WearContract
import com.google.android.gms.wearable.DataEvent
import com.google.android.gms.wearable.DataEventBuffer
import com.google.android.gms.wearable.DataMap
import com.google.android.gms.wearable.DataMapItem
import com.google.android.gms.wearable.WearableListenerService

/**
 * Receives phone -> watch Data Layer events. Also fires for the watch's own
 * outgoing requests under `/hapi/wear/req` (GMS delivers `onDataChanged` for
 * every local data layer change, not just remote ones) — the `when` below
 * only recognizes phone-originated paths, so those self-events fall through
 * to [Unit].
 */
class WatchDataLayerListenerService : WearableListenerService() {

    override fun onDataChanged(events: DataEventBuffer) {
        for (event in events) {
            if (event.type != DataEvent.TYPE_CHANGED) continue
            val map = DataMapItem.fromDataItem(event.dataItem).dataMap
            when (event.dataItem.uri.path) {
                WearContract.PATH_NOTIFY -> handleNotify(map)
                WearContract.PATH_SESSIONS -> handleSessions(map)
                WearContract.PATH_MESSAGES -> handleMessages(map)
                WearContract.PATH_ACTION_RESULT -> handleActionResult(map)
                else -> Unit
            }
        }
    }

    private fun handleNotify(map: DataMap) {
        val sessionId = map.getString(WearContract.KEY_SESSION_ID) ?: return
        val event = WearNotifyEvent(
            sessionId = sessionId,
            sessionName = map.getString(WearContract.KEY_SESSION_NAME),
            type = map.getString(WearContract.KEY_TYPE).orEmpty(),
            title = map.getString("title"),
            body = map.getString("body"),
            requestId = map.getString(WearContract.KEY_REQUEST_ID),
            severity = map.getString("severity"),
            supportsActions = map.getBoolean("supportsActions", false),
            ts = map.getLong(WearContract.KEY_TS, System.currentTimeMillis()),
        )
        WatchRepository.onNotify(event)
        WearNotifications.show(applicationContext, event)
    }

    private fun handleSessions(map: DataMap) {
        val error = map.getString(WearContract.KEY_ERROR)
        val rows = map.getDataMapArrayList(WearContract.KEY_SESSIONS).orEmpty().map { row ->
            WearSessionRow(
                id = row.getString(WearContract.KEY_SESSION_ID).orEmpty(),
                name = row.getString(WearContract.KEY_SESSION_NAME).orEmpty(),
                active = row.getBoolean(WearContract.KEY_ACTIVE, false),
                thinking = row.getBoolean(WearContract.KEY_THINKING, false),
                pendingRequestKinds = row.getStringArrayList(WearContract.KEY_PENDING_REQUEST_KINDS).orEmpty(),
                backgroundTaskCount = row.getInt(WearContract.KEY_BACKGROUND_TASK_COUNT, 0),
                updatedAt = row.getLong(WearContract.KEY_UPDATED_AT, 0L),
            )
        }.sortedWith(compareByDescending<WearSessionRow> { it.active }.thenByDescending { it.updatedAt })
        WatchRepository.onSessions(rows, error)
    }

    private fun handleMessages(map: DataMap) {
        val sessionId = map.getString(WearContract.KEY_SESSION_ID) ?: return
        val error = map.getString(WearContract.KEY_ERROR)
        val rows = map.getDataMapArrayList(WearContract.KEY_MESSAGES).orEmpty().map { row ->
            WearMessageRow(
                role = row.getString(WearContract.KEY_ROLE).orEmpty(),
                text = row.getString(WearContract.KEY_TEXT).orEmpty(),
                createdAt = row.getLong(WearContract.KEY_CREATED_AT, 0L),
            )
        }
        val truncated = map.getBoolean(WearContract.KEY_TRUNCATED, false)
        WatchRepository.onMessages(sessionId, rows, truncated, error)
    }

    private fun handleActionResult(map: DataMap) {
        val sessionId = map.getString(WearContract.KEY_SESSION_ID) ?: return
        WatchRepository.onActionResult(sessionId, map.getBoolean(WearContract.KEY_OK, false))
    }
}
