package app.hapi.companion.feature.chat

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import app.hapi.companion.R
import app.hapi.protocol.catalog.PermissionMode
import app.hapi.protocol.catalog.PermissionModeTone
import app.hapi.protocol.catalog.PermissionModes

/**
 * Display rule for the persistent permission-mode chip — a port of the web
 * StatusBar predicate (StatusBar.tsx:253-261): resolve the raw wire id, keep
 * it only when the flavor offers it, and hide `default` everywhere except
 * copilot (model=auto sessions still surface the bottom-right mode chip).
 *
 * This consults the *unfiltered* flavor catalog: the concurrent-clients
 * Safe-Yolo carve-out only narrows the switcher, never the chip. Unknown
 * wire ids stay hidden (no raw fallback — same as the web span, which keys
 * off `isPermissionModeAllowedForFlavor`).
 */
object PermissionModeChipRule {
    fun displayMode(rawMode: String?, flavor: String?): PermissionMode? {
        val mode = PermissionMode.fromWireId(rawMode) ?: return null
        if (!PermissionModes.isAllowedForFlavor(mode, flavor)) return null
        if (mode == PermissionMode.Default && flavor != "copilot") return null
        return mode
    }
}

/**
 * Persistent permission-mode indicator above the composer — parity with the
 * web StatusBar mode span (StatusBar.tsx:389-393): plain toned text, en
 * catalog labels, no i18n (mode labels are hardcoded on web too). Tones map
 * like the web `PERMISSION_TONE_CLASSES` (StatusBar.tsx:43-48):
 * neutral=hint, info=blue, warning=amber, danger=red.
 *
 * The web span is *not* clickable — the switcher lives in the composer
 * settings sheet. Android mirrors that split except the chip tap opens the
 * session config sheet (same surface the top-bar gear opens), since there
 * is no Shift+Tab equivalent.
 */
@Composable
internal fun PermissionModeChip(
    config: SessionConfigUi,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val mode = PermissionModeChipRule.displayMode(config.permissionMode, config.flavor) ?: return
    val sectionTitle = stringResource(R.string.chat_config_permission_mode)
    Row(
        modifier = modifier
            .fillMaxWidth()
            .clickable(onClick = onClick)
            .padding(horizontal = 16.dp, vertical = 6.dp),
        horizontalArrangement = Arrangement.End,
    ) {
        Text(
            text = mode.label,
            style = MaterialTheme.typography.labelMedium,
            color = when (mode.tone) {
                PermissionModeTone.Neutral -> MaterialTheme.colorScheme.onSurfaceVariant
                PermissionModeTone.Info -> MaterialTheme.colorScheme.primary
                PermissionModeTone.Warning -> MaterialTheme.colorScheme.tertiary
                PermissionModeTone.Danger -> MaterialTheme.colorScheme.error
            },
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
            modifier = Modifier.semantics { contentDescription = sectionTitle + ": " + mode.label },
        )
    }
}
