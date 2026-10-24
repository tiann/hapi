package app.hapi.companion.feature.toasts

import app.hapi.companion.Routes
import app.hapi.protocol.wire.SyncEvent

/**
 * Hub-pushed toast presentation — the web twin is `ToastContainer` +
 * `toast-context` (6 s auto-dismiss, tap navigates to the session). The SSE
 * payload (`SyncEvent.Toast`) has no explicit action field: the jump target
 * is `sessionId`, falling back to a web `url` path; everything else is
 * display-only.
 */
object HubToasts {

    /** Web `TOAST_DURATION_MS` (`toast-context.tsx`): fixed 6 s auto-dismiss. */
    const val DURATION_MS = 6_000L

    /**
     * The one web-SPA url shape the app can map: `/sessions/<id>` (TanStack
     * route, optionally with query/fragment/sub-path). Lenient on purpose —
     * opening the session's chat is the closest Android affordance for any
     * session-targeted url.
     */
    private val WEB_SESSION_PATH = Regex("^/sessions/([^/?#]+)")

    /**
     * Snackbar text: title + body on two lines (the web card renders both);
     * blank lines are dropped so a body-less toast does not trail an empty
     * line (minor android-side adaptation).
     */
    fun message(toast: SyncEvent.Toast): String =
        listOf(toast.data.title, toast.data.body)
            .map { it.trim() }
            .filter { it.isNotEmpty() }
            .joinToString("\n")

    /**
     * Tap target, web click semantics: a session id wins; otherwise a known
     * web url path maps to its Android route; null = display-only (no action
     * label, plain 6 s banner).
     */
    fun routeFor(toast: SyncEvent.Toast): String? {
        if (toast.data.sessionId.isNotEmpty()) return Routes.chat(toast.data.sessionId)
        val fromUrl = WEB_SESSION_PATH.find(toast.data.url)?.groupValues?.get(1)
        return fromUrl?.takeIf { it.isNotEmpty() }?.let(Routes::chat)
    }
}
