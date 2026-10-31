package app.hapi.companion.feature.home

import android.net.Uri
import androidx.activity.compose.BackHandler
import androidx.compose.animation.Crossfade
import androidx.compose.animation.core.tween
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.isImeVisible
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.Check
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.Search
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material3.Badge
import androidx.compose.material3.BadgedBox
import androidx.compose.material3.CenterAlignedTopAppBar
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.platform.LocalSoftwareKeyboardController
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import app.hapi.companion.R

@OptIn(ExperimentalMaterial3Api::class, ExperimentalLayoutApi::class)
@Composable
internal fun HomeTopBar(
    activeHubUrl: String,
    pairedHubs: List<String>,
    hasActiveFilters: Boolean,
    searchExpanded: Boolean,
    searchQuery: String,
    onOpenSearch: () -> Unit,
    onSearchQueryChange: (String) -> Unit,
    onCloseSearch: () -> Unit,
    onOpenFilters: () -> Unit,
    onSwitchHub: (String) -> Unit,
    onPairAnotherHub: () -> Unit,
    onOpenSettings: (() -> Unit)?,
    onSignOut: () -> Unit,
) {
    val keyboard = LocalSoftwareKeyboardController.current
    val focusManager = LocalFocusManager.current
    val hideKeyboard: () -> Unit = {
        focusManager.clearFocus()
        keyboard?.hide()
    }
    val closeSearch = {
        hideKeyboard()
        onCloseSearch()
    }
    val imeVisible = WindowInsets.isImeVisible
    BackHandler(enabled = searchExpanded) {
        if (imeVisible) hideKeyboard() else closeSearch()
    }

    Crossfade(targetState = searchExpanded, animationSpec = tween(150), label = "home-search") { searching ->
        CenterAlignedTopAppBar(
            title = {
                if (searching) {
                    HomeSearchField(searchQuery, onSearchQueryChange, hideKeyboard, closeSearch)
                } else {
                    Text(
                        stringResource(R.string.sessions_section_sessions),
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                    )
                }
            },
            navigationIcon = {
                if (!searching) {
                    // Match the two action widths so a truncated title stays centered.
                    Box(Modifier.width(96.dp)) {
                        HubMenu(activeHubUrl, pairedHubs, onSwitchHub, onPairAnotherHub, onOpenSettings, onSignOut)
                    }
                }
            },
            actions = {
                if (!searching) {
                    IconButton(onClick = onOpenSearch, modifier = Modifier.size(48.dp)) {
                        Icon(Icons.Default.Search, stringResource(R.string.sessions_search_open))
                    }
                    val filterState = stringResource(
                        if (hasActiveFilters) R.string.sessions_filters_active else R.string.sessions_filter_all,
                    )
                    IconButton(
                        onClick = onOpenFilters,
                        modifier = Modifier.size(48.dp).semantics { stateDescription = filterState },
                    ) {
                        BadgedBox(badge = { if (hasActiveFilters) Badge() }) {
                            Icon(painterResource(R.drawable.ic_filter_list), stringResource(R.string.sessions_filters))
                        }
                    }
                }
            },
        )
    }
}

@Composable
private fun HomeSearchField(query: String, onQueryChange: (String) -> Unit, onSearch: () -> Unit, onClose: () -> Unit) {
    val focusRequester = remember { FocusRequester() }
    val keyboard = LocalSoftwareKeyboardController.current
    val hint = stringResource(R.string.sessions_search_hint)

    LaunchedEffect(Unit) {
        focusRequester.requestFocus()
        keyboard?.show()
    }

    Row(Modifier.fillMaxWidth().heightIn(min = 48.dp), verticalAlignment = Alignment.CenterVertically) {
        Icon(
            Icons.Default.Search,
            contentDescription = null,
            tint = MaterialTheme.colorScheme.onSurfaceVariant,
            modifier = Modifier.padding(start = 4.dp, end = 12.dp),
        )
        BasicTextField(
            value = query,
            onValueChange = onQueryChange,
            singleLine = true,
            textStyle = MaterialTheme.typography.bodyLarge.copy(color = MaterialTheme.colorScheme.onSurface),
            cursorBrush = SolidColor(MaterialTheme.colorScheme.primary),
            keyboardOptions = KeyboardOptions(imeAction = ImeAction.Search),
            keyboardActions = KeyboardActions(onSearch = { onSearch() }),
            modifier = Modifier.weight(1f).heightIn(min = 48.dp).focusRequester(focusRequester)
                .semantics { contentDescription = hint }.testTag("home-search-input"),
            decorationBox = { input ->
                Box(contentAlignment = Alignment.CenterStart) {
                    if (query.isEmpty()) {
                        Text(
                            hint,
                            style = MaterialTheme.typography.bodyLarge,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                            maxLines = 1,
                            overflow = TextOverflow.Ellipsis,
                        )
                    }
                    input()
                }
            },
        )
        IconButton(onClick = onClose, modifier = Modifier.size(48.dp)) {
            Icon(Icons.Default.Close, stringResource(R.string.sessions_search_close))
        }
    }
}

@Composable
private fun HubMenu(
    activeHubUrl: String,
    pairedHubs: List<String>,
    onSwitchHub: (String) -> Unit,
    onPairAnotherHub: () -> Unit,
    onOpenSettings: (() -> Unit)?,
    onSignOut: () -> Unit,
) {
    var menuOpen by rememberSaveable(activeHubUrl) { mutableStateOf(false) }
    Box {
        IconButton(
            onClick = { menuOpen = true },
            modifier = Modifier.size(48.dp).semantics { stateDescription = activeHubUrl },
        ) {
            Icon(painterResource(R.drawable.ic_hubs), stringResource(R.string.home_hub_menu))
        }
        DropdownMenu(expanded = menuOpen, onDismissRequest = { menuOpen = false }) {
            Text(
                stringResource(R.string.home_switch_hub),
                style = MaterialTheme.typography.labelMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier.padding(horizontal = 16.dp, vertical = 8.dp),
            )
            pairedHubs.forEach { hub ->
                DropdownMenuItem(
                    text = { Text(Uri.parse(hub).authority ?: hub, maxLines = 2, overflow = TextOverflow.Ellipsis) },
                    trailingIcon = { if (hub == activeHubUrl) Icon(Icons.Default.Check, contentDescription = null) },
                    modifier = Modifier.semantics { selected = hub == activeHubUrl },
                    onClick = {
                        menuOpen = false
                        if (hub != activeHubUrl) onSwitchHub(hub)
                    },
                )
            }
            DropdownMenuItem(
                text = { Text(stringResource(R.string.home_pair_another)) },
                leadingIcon = { Icon(Icons.Default.Add, contentDescription = null) },
                onClick = { menuOpen = false; onPairAnotherHub() },
            )
            HorizontalDivider()
            if (onOpenSettings != null) {
                DropdownMenuItem(
                    text = { Text(stringResource(R.string.home_settings)) },
                    leadingIcon = { Icon(Icons.Default.Settings, contentDescription = null) },
                    onClick = { menuOpen = false; onOpenSettings() },
                )
            }
            DropdownMenuItem(
                text = { Text(stringResource(R.string.home_sign_out), color = MaterialTheme.colorScheme.error) },
                onClick = { menuOpen = false; onSignOut() },
            )
        }
    }
}
