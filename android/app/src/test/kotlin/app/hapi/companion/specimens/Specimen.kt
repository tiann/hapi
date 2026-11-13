package app.hapi.companion.specimens

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.test.junit4.ComposeContentTestRule
import androidx.compose.ui.test.onRoot
import androidx.compose.ui.unit.dp
import app.hapi.companion.ui.theme.HapiTheme
import com.github.takahirom.roborazzi.captureRoboImage

/**
 * Deterministic visual specimens (fake data, no hub): the Android analogue of
 * the iOS `TypographySnapshotTests` captures. Plain `testDebugUnitTest` runs
 * compose every specimen as a smoke test; images are only written by
 * `./gradlew :app:recordRoborazziDebug`, into `app/build/outputs/roborazzi/`.
 * They are review aids, not committed goldens or store screenshots.
 */
internal enum class SpecimenTheme(val dark: Boolean, val oled: Boolean) {
    Light(dark = false, oled = false),
    Dark(dark = true, oled = false),
    Oled(dark = true, oled = true),
}

/** Phone-width canvas (Pixel 8 / 412dp) with the transcript's 16dp margins. */
@Composable
internal fun Specimen(theme: SpecimenTheme, content: @Composable () -> Unit) {
    HapiTheme(darkTheme = theme.dark, dynamicColor = false, oled = theme.oled) {
        Surface(color = MaterialTheme.colorScheme.background) {
            Box(Modifier.width(412.dp).padding(horizontal = 16.dp, vertical = 20.dp)) {
                Column { content() }
            }
        }
    }
}

internal fun ComposeContentTestRule.captureSpecimen(name: String, theme: SpecimenTheme) {
    waitForIdle()
    onRoot().captureRoboImage("build/outputs/roborazzi/specimens/$name-${theme.name.lowercase()}.png")
}
