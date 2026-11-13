package app.hapi.companion.wear

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.wear.compose.navigation.SwipeDismissableNavHost
import androidx.wear.compose.navigation.composable
import androidx.wear.compose.navigation.rememberSwipeDismissableNavController
import app.hapi.companion.wear.notify.WearNotifications
import app.hapi.companion.wear.ui.SessionListScreen
import app.hapi.companion.wear.ui.TranscriptScreen
import app.hapi.companion.wear.ui.theme.WearCompanionTheme

private const val ROUTE_SESSIONS = "sessions"
private const val ROUTE_TRANSCRIPT = "transcript/{sessionId}"

class MainActivity : ComponentActivity() {

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        // A notification tap carries the session id directly; otherwise the
        // app opens on the session list (standard cold-launch).
        val openSessionId = intent.getStringExtra(WearNotifications.EXTRA_SESSION_ID)

        setContent {
            WearCompanionTheme {
                val navController = rememberSwipeDismissableNavController()
                SwipeDismissableNavHost(
                    navController = navController,
                    startDestination = if (openSessionId != null) "transcript/$openSessionId" else ROUTE_SESSIONS,
                ) {
                    composable(ROUTE_SESSIONS) {
                        SessionListScreen(onOpenSession = { id -> navController.navigate("transcript/$id") })
                    }
                    composable(ROUTE_TRANSCRIPT) { backStackEntry ->
                        val sessionId = backStackEntry.arguments?.getString("sessionId") ?: return@composable
                        TranscriptScreen(sessionId = sessionId)
                    }
                }
            }
        }
    }
}
