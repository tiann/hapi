package app.hapi.companion.specimens

import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.ui.Modifier
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.performClick
import app.hapi.companion.feature.sessions.MachineFilterUi
import app.hapi.companion.feature.sessions.SessionDateRange
import app.hapi.companion.feature.sessions.SessionDateRangePickerDialog
import app.hapi.companion.feature.sessions.SessionFilterSheet
import app.hapi.companion.feature.sessions.SessionListUiState
import app.hapi.companion.ui.theme.HapiTheme
import com.github.takahirom.roborazzi.ExperimentalRoborazziApi
import com.github.takahirom.roborazzi.captureScreenRoboImage
import java.time.LocalDate
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

/** Window-level specimens (bottom sheet, dialog) at a phone size, captured with their scrim. */
@OptIn(ExperimentalRoborazziApi::class)
@RunWith(RobolectricTestRunner::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(sdk = [35], qualifiers = "w411dp-h890dp-xxhdpi")
class SessionFilterSpecimenTest {
    @get:Rule val compose = createComposeRule()

    private val today = LocalDate.of(2026, 11, 13).toEpochDay()

    private fun state(dateRange: SessionDateRange? = null) = SessionListUiState(
        rows = emptyList(),
        machineFilters = listOf(
            MachineFilterUi("m1", "debian", 1751),
            MachineFilterUi("m2", "mac", 930),
            MachineFilterUi("m3", "529e6566", 164, unnamed = true),
            MachineFilterUi("m4", "b459b4ee", 78, unnamed = true),
        ),
        activeMachineFilter = null,
        isRefreshing = false,
        hasLoaded = true,
        isOffline = false,
        dateRange = dateRange,
        dateActivityEpochDays = (0L..20L step 2).map { today - it }.toSet(),
    )

    @Test fun filterSheetDark() = sheet(dark = true)
    @Test fun filterSheetLight() = sheet(dark = false)
    @Test fun machineMenuDark() = sheet(dark = true, openMachines = true)
    @Test fun datePickerDark() = dates(dark = true)
    @Test fun datePickerLight() = dates(dark = false)

    private fun sheet(dark: Boolean, openMachines: Boolean = false) {
        compose.setContent {
            HapiTheme(darkTheme = dark, dynamicColor = false) {
                Surface(Modifier.fillMaxSize(), color = MaterialTheme.colorScheme.background) {}
                SessionFilterSheet(
                    state = state(),
                    onSelectSort = {}, onSetActiveFirst = {}, onSelectStatus = {}, onSetUnreadOnly = {},
                    onSelectMachine = {}, onOpenDates = {}, onClearDates = {}, onReset = {}, onDismiss = {},
                )
            }
        }
        compose.waitForIdle()
        if (openMachines) compose.onNodeWithTag("session-machine-filter").performClick()
        compose.waitForIdle()
        val name = if (openMachines) "machine-menu" else "filter-sheet"
        captureScreenRoboImage("build/outputs/roborazzi/specimens/$name-${if (dark) "dark" else "light"}.png")
    }

    private fun dates(dark: Boolean) {
        compose.setContent {
            HapiTheme(darkTheme = dark, dynamicColor = false) {
                Surface(Modifier.fillMaxSize(), color = MaterialTheme.colorScheme.background) {}
                SessionDateRangePickerDialog(
                    current = SessionDateRange(today - 6, today),
                    activityEpochDays = state().dateActivityEpochDays,
                    onApply = { _, _ -> }, onClear = {}, onDismiss = {},
                )
            }
        }
        compose.waitForIdle()
        captureScreenRoboImage("build/outputs/roborazzi/specimens/date-picker-${if (dark) "dark" else "light"}.png")
    }
}
