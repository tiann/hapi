package app.hapi.companion.wear

import android.content.Context
import android.util.Log
import app.hapi.data.push.PushPayload
import app.hapi.data.wear.WearContract
import com.google.android.gms.wearable.PutDataMapRequest
import com.google.android.gms.wearable.Wearable

/**
 * Phone -> Watch: relays a decoded FCM [PushPayload] over the Data Layer so a
 * paired Wear OS app can show it (and act on it) without its own FCM
 * registration. See `:core:data`'s `WearContract` for why Data Layer and not
 * a second push channel: FCM locks one Firebase project per signed APK, and
 * the watch sharing the phone's registration avoids a second one entirely.
 *
 * Fire-and-forget: no watch paired means `putDataItem` just has no listener,
 * which costs nothing worth guarding against.
 */
object WearRelay {
    private const val TAG = "WearRelay"

    fun relay(context: Context, payload: PushPayload) {
        val request = PutDataMapRequest.create(WearContract.PATH_NOTIFY).apply {
            dataMap.putString(WearContract.KEY_SESSION_ID, payload.sessionId)
            payload.sessionName?.let { dataMap.putString(WearContract.KEY_SESSION_NAME, it) }
            dataMap.putString(WearContract.KEY_TYPE, payload.rawType)
            payload.title?.let { dataMap.putString("title", it) }
            payload.displayBody.takeIf { it.isNotBlank() }?.let { dataMap.putString("body", it) }
            payload.requestId?.let { dataMap.putString(WearContract.KEY_REQUEST_ID, it) }
            payload.severity?.let { dataMap.putString("severity", it.wire) }
            payload.contractVersion?.let { dataMap.putString("contractVersion", it) }
            dataMap.putBoolean("supportsActions", payload.supportsActions)
            dataMap.putLong(WearContract.KEY_TS, System.currentTimeMillis())
        }.asPutDataRequest().setUrgent()

        Wearable.getDataClient(context).putDataItem(request)
            .addOnFailureListener { error -> Log.w(TAG, "relay failed", error) }
    }
}
