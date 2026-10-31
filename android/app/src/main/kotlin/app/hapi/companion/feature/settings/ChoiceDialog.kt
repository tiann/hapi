package app.hapi.companion.feature.settings

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.selection.selectableGroup
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Check
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.Immutable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.unit.dp

/**
 * One entry of a [ChoiceDialog]: the value to hand back on selection, its
 * display label, and an optional [ChoiceSwatch] preview chip painted in
 * front of it. Options without a swatch (e.g. language names) simply omit
 * the leading slot.
 */
@Immutable
data class ChoiceOption<T>(
    val value: T,
    val label: String,
    val swatch: ChoiceSwatch? = null,
)

/**
 * A small two-tone preview chip shown inside a [ChoiceDialog]. The colors
 * are fixed values that depict what the option *is* — deliberately not
 * derived from the active color scheme, mirroring how the web color-theme
 * cards hardcode their preview colors: a "light" chip must stay light even
 * when the dialog itself is dark. [outline] adds a hairline border for
 * chips whose halves would otherwise disappear against the dialog surface.
 */
@Immutable
data class ChoiceSwatch(
    val startColor: Color,
    val endColor: Color,
    val outline: Boolean = false,
)

/** Fixed light preview: the light theme's canvas. */
private val LIGHT_PREVIEW = Color(0xFFFFFFFF)

/** Fixed dark preview: the dark theme's canvas (pure black stays OLED-only). */
private val DARK_PREVIEW = Color(0xFF1C1B1F)

/**
 * Preview chip for a theme mode. Follow-system spans the light and dark
 * palettes so the split itself carries the meaning; OLED is outlined pure
 * black; the plain dark chip uses the dark canvas rather than black so the
 * two remain distinguishable at a glance.
 */
internal fun themeModeSwatch(mode: ThemeMode): ChoiceSwatch = when (mode) {
    ThemeMode.SYSTEM -> ChoiceSwatch(startColor = LIGHT_PREVIEW, endColor = DARK_PREVIEW)
    ThemeMode.LIGHT -> ChoiceSwatch(startColor = LIGHT_PREVIEW, endColor = LIGHT_PREVIEW, outline = true)
    ThemeMode.DARK -> ChoiceSwatch(startColor = DARK_PREVIEW, endColor = DARK_PREVIEW)
    ThemeMode.OLED -> ChoiceSwatch(startColor = Color(0xFF000000), endColor = Color(0xFF000000), outline = true)
}

/**
 * Expressive single-choice dialog for small exclusive pickers (the theme and
 * language settings). Each option renders as a full-width choice card: the
 * selected card fills with [androidx.compose.material3.ColorScheme.secondaryContainer]
 * and carries a trailing check, optional swatches anchor what each option
 * means, and everything else stays plain. Rows keep radio semantics via
 * [Modifier.selectable] with [Role.RadioButton] inside a `selectableGroup`,
 * so TalkBack announces the standard "selected, n of m" picker phrasing —
 * and, unlike the radio rows this replaces, each option is one focus
 * target instead of two (row + radio with its own click handler).
 *
 * Choosing an option is the only commit gesture: tapping one invokes
 * [onSelect] immediately, exactly like the previous dialogs.
 */
@Composable
internal fun <T> ChoiceDialog(
    title: String,
    options: List<ChoiceOption<T>>,
    selected: T,
    onSelect: (T) -> Unit,
    onDismiss: () -> Unit,
    dismissLabel: String? = null,
) {
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(title) },
        text = {
            Column(
                modifier = Modifier.selectableGroup(),
                verticalArrangement = Arrangement.spacedBy(4.dp),
            ) {
                options.forEach { option ->
                    ChoiceRow(
                        option = option,
                        selected = option.value == selected,
                        onClick = { onSelect(option.value) },
                    )
                }
            }
        },
        confirmButton = {
            if (dismissLabel != null) {
                TextButton(onClick = onDismiss) { Text(dismissLabel) }
            }
        },
    )
}

@Composable
private fun <T> ChoiceRow(
    option: ChoiceOption<T>,
    selected: Boolean,
    onClick: () -> Unit,
) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .selectable(selected = selected, role = Role.RadioButton, onClick = onClick)
            .background(
                color = if (selected) {
                    MaterialTheme.colorScheme.secondaryContainer
                } else {
                    Color.Transparent
                },
                shape = MaterialTheme.shapes.small,
            )
            .padding(horizontal = 12.dp, vertical = 8.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        option.swatch?.let { swatch ->
            SwatchChip(swatch)
            Spacer(modifier = Modifier.width(12.dp))
        }
        Text(
            text = option.label,
            style = MaterialTheme.typography.bodyMedium,
            color = if (selected) {
                MaterialTheme.colorScheme.onSecondaryContainer
            } else {
                MaterialTheme.colorScheme.onSurface
            },
            modifier = Modifier.weight(1f),
        )
        if (selected) {
            Icon(
                imageVector = Icons.Default.Check,
                contentDescription = null,
                tint = MaterialTheme.colorScheme.onSecondaryContainer,
            )
        }
    }
}

/** Rounded two-tone chip: left half [ChoiceSwatch.startColor], right half [ChoiceSwatch.endColor]. */
@Composable
private fun SwatchChip(swatch: ChoiceSwatch) {
    val shape = RoundedCornerShape(6.dp)
    Row(
        modifier = Modifier
            .size(width = 36.dp, height = 20.dp)
            .clip(shape)
            .then(
                if (swatch.outline) {
                    Modifier.border(
                        width = 1.dp,
                        color = MaterialTheme.colorScheme.outlineVariant,
                        shape = shape,
                    )
                } else {
                    Modifier
                },
            ),
    ) {
        Box(
            modifier = Modifier
                .weight(1f)
                .fillMaxHeight()
                .background(swatch.startColor),
        )
        Box(
            modifier = Modifier
                .weight(1f)
                .fillMaxHeight()
                .background(swatch.endColor),
        )
    }
}
