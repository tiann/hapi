package app.hapi.companion.wear.data

import android.content.Context
import android.util.Log
import app.hapi.data.wear.WearContract
import com.google.android.gms.wearable.PutDataMapRequest
import com.google.android.gms.wearable.Wearable
import java.util.UUID

/** Watch -> Phone: every request is a `putDataItem`, matching [WearContract]'s transport choice. */
object WatchRequests {
    private const val TAG = "WatchRequests"

    fun requestSessions(context: Context) {
        WatchRepository.onSessionsLoading()
        put(context, WearContract.PATH_REQUEST_SESSIONS) {}
    }

    fun requestMessages(context: Context, sessionId: String, limit: Int = 50) {
        WatchRepository.onMessagesLoading(sessionId)
        put(context, WearContract.PATH_REQUEST_MESSAGES) {
            putString(WearContract.KEY_SESSION_ID, sessionId)
            putInt(WearContract.KEY_LIMIT, limit)
        }
    }

    fun approve(context: Context, sessionId: String, requestId: String, rawType: String?) =
        sendAction(context, sessionId, rawType) {
            putString(WearContract.KEY_ACTION, WearContract.ACTION_APPROVE)
            putString(WearContract.KEY_REQUEST_ID, requestId)
        }

    fun deny(context: Context, sessionId: String, requestId: String, rawType: String?) =
        sendAction(context, sessionId, rawType) {
            putString(WearContract.KEY_ACTION, WearContract.ACTION_DENY)
            putString(WearContract.KEY_REQUEST_ID, requestId)
        }

    fun reply(context: Context, sessionId: String, text: String, rawType: String?): String {
        val localId = UUID.randomUUID().toString()
        sendAction(context, sessionId, rawType) {
            putString(WearContract.KEY_ACTION, WearContract.ACTION_REPLY)
            putString(WearContract.KEY_TEXT, text)
            putString(WearContract.KEY_LOCAL_ID, localId)
        }
        return localId
    }

    private inline fun sendAction(
        context: Context,
        sessionId: String,
        rawType: String?,
        crossinline build: com.google.android.gms.wearable.DataMap.() -> Unit,
    ) = put(context, WearContract.PATH_REQUEST_ACTION) {
        putString(WearContract.KEY_SESSION_ID, sessionId)
        rawType?.let { putString(WearContract.KEY_TYPE, it) }
        build()
    }

    private inline fun put(context: Context, path: String, crossinline build: com.google.android.gms.wearable.DataMap.() -> Unit) {
        // GMS dedupes a putDataItem whose payload is byte-identical to the
        // item already at that path (e.g. a bare "refresh" with no other
        // fields) — KEY_TS always changes, so every call is a genuine diff
        // and onDataChanged fires on the phone every time.
        val request = PutDataMapRequest.create(path).apply {
            dataMap.build()
            dataMap.putLong(WearContract.KEY_TS, System.currentTimeMillis())
        }.asPutDataRequest().setUrgent()
        Wearable.getDataClient(context).putDataItem(request)
            .addOnFailureListener { error -> Log.w(TAG, "request $path failed", error) }
    }
}
