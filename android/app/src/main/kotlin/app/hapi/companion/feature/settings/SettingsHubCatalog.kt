package app.hapi.companion.feature.settings

import androidx.annotation.StringRes
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.List
import androidx.compose.material.icons.filled.DateRange
import androidx.compose.material.icons.filled.Settings
import androidx.compose.ui.graphics.vector.ImageVector
import app.hapi.companion.R
import app.hapi.companion.Routes

/**
 * Inputs to hub-row visibility gates. Today only the owner gate
 * (`ns === 'default'`, the web twin of `OWNER_ONLY_CATEGORIES` in
 * `SettingsNav.tsx`); extend this class — not the entry shape — when a future
 * category needs more context (e.g. a feature flag).
 */
data class SettingsHubState(val isOwner: Boolean)

/**
 * One settings-hub row: a category destination. Rows render in list order as
 * icon + title + summary cards; `route` is a navigation route handled by the
 * hub screen's `onOpenCategory`.
 *
 * Adding a category (Display, Chat, Voice, Machines, a fork-only feature …)
 * is a single list element in [SettingsHubCatalog.entries] — no hub layout
 * surgery. Keep entries with no content on the current branch OUT of the
 * catalog rather than gating them to `false`: an empty subpage route is worse
 * than an absent row.
 */
class SettingsHubEntry(
    val route: String,
    @StringRes val titleRes: Int,
    @StringRes val descriptionRes: Int? = null,
    val icon: ImageVector,
    val isVisible: (SettingsHubState) -> Boolean = { true },
)

/**
 * Declarative category list behind the settings hub. Mirrors the web's
 * `web/src/routes/settings/categories.ts` where the branch has content:
 * general (appearance/language/about) plus the owner-only usage and storage
 * dashboards. Display/Chat/Voice/Machines join here in later slices.
 */
object SettingsHubCatalog {

    val entries: List<SettingsHubEntry> = listOf(
        SettingsHubEntry(
            route = Routes.SETTINGS_GENERAL,
            titleRes = R.string.settings_category_general,
            descriptionRes = R.string.settings_category_general_summary,
            icon = Icons.Default.Settings,
        ),
        SettingsHubEntry(
            route = Routes.SETTINGS_USAGE,
            titleRes = R.string.settings_usage,
            descriptionRes = R.string.settings_usage_summary,
            icon = Icons.Default.DateRange,
            isVisible = { state -> state.isOwner },
        ),
        SettingsHubEntry(
            route = Routes.SETTINGS_STORAGE,
            titleRes = R.string.settings_storage,
            descriptionRes = R.string.settings_storage_summary,
            icon = Icons.AutoMirrored.Filled.List,
            isVisible = { state -> state.isOwner },
        ),
    )

    /** Rows to render for [state], in catalog order. */
    fun visibleEntries(state: SettingsHubState): List<SettingsHubEntry> =
        entries.filter { entry -> entry.isVisible(state) }
}
