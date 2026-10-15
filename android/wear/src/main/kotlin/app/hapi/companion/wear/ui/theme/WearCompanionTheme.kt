package app.hapi.companion.wear.ui.theme

import androidx.compose.runtime.Composable
import androidx.wear.compose.material.Colors
import androidx.wear.compose.material.MaterialTheme

/** HAPI coral accent on the stock Wear Material dark palette. */
private val HapiWearColors = Colors(
    primary = androidx.compose.ui.graphics.Color(0xFFF25562),
    primaryVariant = androidx.compose.ui.graphics.Color(0xFFC43E49),
    secondary = androidx.compose.ui.graphics.Color(0xFFF25562),
    secondaryVariant = androidx.compose.ui.graphics.Color(0xFFC43E49),
)

@Composable
fun WearCompanionTheme(content: @Composable () -> Unit) {
    MaterialTheme(colors = HapiWearColors, content = content)
}
