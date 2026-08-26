package app.hapi.companion.fcm

import app.hapi.companion.HapiApp
import app.hapi.companion.di.AppGraph
import app.hapi.companion.di.localizedForAppLanguage
import app.hapi.data.push.PushPayload
import app.hapi.data.push.shouldSuppressPush
import com.google.firebase.messaging.FirebaseMessagingService
import com.google.firebase.messaging.RemoteMessage

/**
 * FCM entry point (B-M4a). Messages are **data-only** by contract
 * (`docs/api/native-companion-contract.md`) — a `notification` block would
 * stop `onMessageReceived` from running in the background — so every render
 * decision is client-side: [PushPayload] parses/routes, [PushNotifications]
 * builds, and the one suppression rule ([shouldSuppressPush]) skips the OS
 * notification only when the app is foreground *with that session's chat
 * open* (the in-app SSE stream is already showing the event).
 *
 * Without a Firebase config this service is inert — no token, no delivery —
 * and [app.hapi.companion.push.PushBinding] keeps the rest of the push
 * surface no-op'd to match.
 */
class HapiFirebaseMessagingService : FirebaseMessagingService() {

    private val appGraph: AppGraph
        get() = (application as HapiApp).appGraph

    /** Token minted or rotated: (re-)register it with every paired hub. */
    override fun onNewToken(token: String) {
        appGraph.onPushTokenRotated(token)
    }

    override fun onMessageReceived(message: RemoteMessage) {
        val payload = PushPayload.parse(message.data) ?: return
        val graph = appGraph
        if (shouldSuppressPush(graph.foreground, graph.openChatSessionId.value, payload.sessionId)) {
            return
        }
        // In-app language (B-M5a): notification strings resolve from this
        // service context, which per-app locales miss on API < 33.
        PushNotifications.show(localizedForAppLanguage(graph.appLanguage.value), payload)
    }
}
