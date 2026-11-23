package app.hapi.companion

import android.app.Application
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.foundation.text.BasicText
import androidx.compose.runtime.SideEffect
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.ui.test.junit4.createEmptyComposeRule
import androidx.navigation.NavHostController
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable
import androidx.navigation.compose.navigation
import androidx.navigation.compose.rememberNavController
import androidx.test.core.app.ActivityScenario
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

/** Uses a real Android saved-state round trip, but simple destinations and no live Hub. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], application = Application::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class HubNavigationRestorationTest {
    @get:Rule val compose = createEmptyComposeRule()

    private val activeHubUrl = mutableStateOf<String?>(HUB_A)
    private lateinit var navController: NavHostController
    private var firstComposedDestination: String? = null

    @Test fun sameHubRecreationKeepsTheExactOpenChat() = withNavigation { scenario ->
        openChat()
        scenario.recreate()
        scenario.mountNavigation()

        assertEquals("NavHost must have restored the chat before the Hub guard runs", Routes.CHAT, firstComposedDestination)
        assertDestination(Routes.CHAT, SESSION)
    }

    @Test fun switchingHubPopsTheOldChatAndItsFiles() = withNavigation {
        openChat()
        compose.runOnIdle { navController.navigate(Routes.files(SESSION)) }
        assertDestination(Routes.FILES, SESSION)

        compose.runOnIdle { activeHubUrl.value = HUB_B }

        assertDestination(Routes.HOME)
        compose.runOnIdle { assertNull(navController.previousBackStackEntry) }
    }

    @Test fun switchingHubWhileRecreatingDoesNotRetainTheOldChat() = withNavigation { scenario ->
        openChat()
        scenario.recreate()
        scenario.mountNavigation(hubUrl = HUB_B)

        assertEquals(Routes.CHAT, firstComposedDestination)
        assertDestination(Routes.HOME)
        compose.runOnIdle { assertNull(navController.previousBackStackEntry) }
    }

    @Test fun removingTheLastHubStillClearsTheStackAndShowsPairing() = withNavigation {
        openChat()

        compose.runOnIdle { activeHubUrl.value = null }

        assertDestination(Routes.PAIRING_LANDING)
        compose.runOnIdle { assertNull(navController.previousBackStackEntry) }
    }

    @Test fun aPairedColdStartWithNoSavedStackOpensHome() = withNavigation {
        assertDestination(Routes.HOME)
        compose.runOnIdle { assertNull(navController.previousBackStackEntry) }
    }

    private fun withNavigation(block: (ActivityScenario<ComponentActivity>) -> Unit) {
        ActivityScenario.launch(ComponentActivity::class.java).use { scenario ->
            scenario.mountNavigation()
            block(scenario)
        }
    }

    private fun ActivityScenario<ComponentActivity>.mountNavigation(hubUrl: String? = activeHubUrl.value) {
        onActivity { activity ->
            firstComposedDestination = null
            activeHubUrl.value = hubUrl
            activity.setContent {
                val nav = rememberNavController()
                val hub = activeHubUrl.value
                val start = remember { if (hub == null) Routes.PAIRING else Routes.HOME }
                HandleActiveHubNavigation(nav, hub)
                NavHost(nav, startDestination = start) {
                    composable(Routes.HOME) { BasicText("Sessions") }
                    composable(Routes.CHAT) { BasicText("Chat") }
                    composable(Routes.FILES) { BasicText("Files") }
                    navigation(startDestination = Routes.PAIRING_LANDING, route = Routes.PAIRING) {
                        composable(Routes.PAIRING_LANDING) { BasicText("Pair a Hub") }
                    }
                }
                val destinationBeforeEffects = nav.currentDestination?.route
                SideEffect {
                    navController = nav
                    if (firstComposedDestination == null) firstComposedDestination = destinationBeforeEffects
                }
            }
        }
        compose.waitForIdle()
    }

    private fun openChat() {
        compose.runOnIdle { navController.navigate(Routes.chat(SESSION)) }
        assertDestination(Routes.CHAT, SESSION)
    }

    private fun assertDestination(route: String, sessionId: String? = null) {
        compose.runOnIdle {
            assertEquals(route, navController.currentDestination?.route)
            if (sessionId != null) {
                assertEquals(sessionId, navController.currentBackStackEntry?.arguments?.getString("sessionId"))
            }
        }
    }

    private companion object {
        const val HUB_A = "https://a.example.test"
        const val HUB_B = "https://b.example.test"
        const val SESSION = "session-a"
    }
}
