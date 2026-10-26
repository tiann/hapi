package app.hapi.companion.feature.home

import android.content.res.Configuration
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.width
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.unit.Density
import androidx.compose.ui.unit.dp
import androidx.test.platform.app.InstrumentationRegistry
import app.hapi.companion.R
import app.hapi.companion.ui.theme.HapiTheme
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import java.util.Locale

class HomeTopBarTest {
    @get:Rule val compose = createComposeRule()
    private val context = InstrumentationRegistry.getInstrumentation().targetContext
    private val configuration = mutableStateOf(Configuration(context.resources.configuration).apply { setLocale(Locale.ENGLISH) })
    private val showFilters = mutableStateOf(true)
    private val filtered = mutableStateOf(false)
    private val actions = mutableListOf<String>()

    private fun mount() {
        compose.setContent {
            val config = configuration.value
            CompositionLocalProvider(
                LocalContext provides context.createConfigurationContext(config),
                LocalConfiguration provides config,
                LocalDensity provides Density(LocalDensity.current.density, config.fontScale),
            ) {
                HapiTheme {
                    Box(Modifier.width(320.dp).testTag("home-bar")) {
                        HomeTopBar(
                            activeHubUrl = "https://alpha.example",
                            pairedHubs = listOf("https://alpha.example", "https://beta.example"),
                            hasMachineFilters = showFilters.value,
                            hasActiveFilter = filtered.value,
                            onOpenFilters = { actions += "filters" },
                            onSwitchHub = { actions += it },
                            onPairAnotherHub = { actions += "pair" },
                            onOpenSettings = { actions += "settings" },
                            onSignOut = { actions += "sign-out" },
                        )
                    }
                }
            }
        }
    }

    private fun label(id: Int) = context.createConfigurationContext(configuration.value).getString(id)
    private fun openHubMenu() = compose.onNodeWithContentDescription(label(R.string.home_hub_menu)).performClick()

    @Test fun titleStaysCenteredWithIconOnlyActionsInBothLanguagesAndLargeFonts() {
        mount()
        for (locale in listOf(Locale.ENGLISH, Locale.SIMPLIFIED_CHINESE)) {
            for (fontScale in listOf(1f, 2f)) {
                compose.runOnIdle {
                    configuration.value = Configuration(configuration.value).apply { setLocale(locale); this.fontScale = fontScale }
                }
                val title = compose.onNodeWithText(label(R.string.sessions_section_sessions)).getUnclippedBoundsInRoot()
                val bar = compose.onNodeWithTag("home-bar").getUnclippedBoundsInRoot()
                assertEquals("Title centered at $locale / $fontScale", (bar.left.value + bar.right.value) / 2,
                    (title.left.value + title.right.value) / 2, 1f)
                compose.onNodeWithText(label(R.string.sessions_filters)).assertDoesNotExist()
                compose.onNodeWithText(label(R.string.home_hub)).assertDoesNotExist()
                compose.onNodeWithContentDescription(label(R.string.home_hub_menu)).assertIsDisplayed()
                    .assertWidthIsEqualTo(48.dp).assertHeightIsEqualTo(48.dp)
                compose.onNodeWithContentDescription(label(R.string.sessions_filters)).assertIsDisplayed()
                    .assertWidthIsEqualTo(48.dp).assertHeightIsEqualTo(48.dp)
            }
        }
    }

    @Test fun oneHubMenuOwnsSwitchPairSettingsAndSignOut() {
        mount()
        compose.onNodeWithContentDescription(label(R.string.home_menu)).assertDoesNotExist()
        openHubMenu()
        compose.onNodeWithText("alpha.example").assertIsSelected().performClick()
        compose.runOnIdle { assertEquals(emptyList<String>(), actions) }
        openHubMenu()
        compose.onNodeWithText("beta.example").assertIsNotSelected().performClick()
        openHubMenu()
        compose.onAllNodesWithText(label(R.string.home_pair_another)).assertCountEquals(1)
        compose.onNodeWithText(label(R.string.home_pair_another)).performClick()
        openHubMenu()
        compose.onAllNodesWithText(label(R.string.home_settings)).assertCountEquals(1)
        compose.onNodeWithText(label(R.string.home_settings)).performClick()
        openHubMenu()
        compose.onNodeWithText(label(R.string.home_sign_out)).performClick()
        compose.runOnIdle { assertEquals(listOf("https://beta.example", "pair", "settings", "sign-out"), actions) }
        compose.onNodeWithText("alpha.example").assertDoesNotExist()
    }

    @Test fun filterActionShowsAppliedStateAndDisappearsWhenNotNeeded() {
        mount()
        compose.onNodeWithContentDescription(label(R.string.sessions_filters)).performClick()
        compose.runOnIdle { assertEquals(listOf("filters"), actions); filtered.value = true }
        compose.onNodeWithContentDescription(label(R.string.sessions_filters))
            .assert(SemanticsMatcher.expectValue(SemanticsProperties.StateDescription, label(R.string.sessions_filters_active)))
        compose.runOnIdle { showFilters.value = false }
        compose.onNodeWithContentDescription(label(R.string.sessions_filters)).assertDoesNotExist()
        val title = compose.onNodeWithText(label(R.string.sessions_section_sessions)).getUnclippedBoundsInRoot()
        assertEquals(160f, (title.left.value + title.right.value) / 2, 1f)
    }
}
