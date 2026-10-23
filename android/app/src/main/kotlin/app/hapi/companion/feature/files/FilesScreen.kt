package app.hapi.companion.feature.files

import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.automirrored.filled.KeyboardArrowRight
import androidx.compose.material.icons.filled.Check
import androidx.compose.material.icons.filled.KeyboardArrowDown
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material.icons.filled.Search
import androidx.compose.material3.Checkbox
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Tab
import androidx.compose.material3.TabRow
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.ui.platform.LocalClipboardManager
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalHapticFeedback
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import app.hapi.companion.R
import app.hapi.companion.ui.theme.hapi
import app.hapi.protocol.git.GitFileStatus
import app.hapi.protocol.wire.FileSearchItem
import kotlinx.coroutines.launch

/**
 * Session files browser (`chat/{sessionId}/files`), the Android take on web
 * `files.tsx`: **Changes** (branch header + staged/unstaged sections with
 * status letters and ±counts), **Browse** (lazily expanded directory tree,
 * configurable sort with dirs always first, hidden-file toggle, per-row
 * download), **Search** (debounced ripgrep query, sorted like the tree). Rows
 * open the file viewer — Changes rows carry their staged side so the viewer
 * opens on the right diff. A long-press on any file row opens the file-action
 * menu (copy path / copy absolute path / add to composer — web
 * `FileActionMenu`).
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun FilesScreen(
    viewModel: FilesViewModel,
    onBack: () -> Unit,
    onOpenFile: (path: String, staged: Boolean?) -> Unit,
    modifier: Modifier = Modifier,
    /** Insert a `path` reference into the chat composer; null hides the menu item. */
    onAddFileToComposer: ((path: String) -> Unit)? = null,
) {
    DisposableEffect(viewModel) {
        viewModel.start()
        onDispose { }
    }

    val changes by viewModel.changes.collectAsState()
    val browse by viewModel.browse.collectAsState()
    val search by viewModel.search.collectAsState()
    val sort by viewModel.sort.collectAsState()
    val downloads by viewModel.downloads.collectAsState()
    val workspacePath by viewModel.workspacePath.collectAsState()
    var tab by rememberSaveable { mutableIntStateOf(0) }

    // One file-action menu at a time (web keeps a page-level menu singleton).
    var menuPath by remember { mutableStateOf<String?>(null) }
    val menuActions = FileMenuActions(
        menuPath = menuPath,
        workspacePath = workspacePath,
        onOpenMenu = { path -> menuPath = path },
        onDismissMenu = { menuPath = null },
        onAddToComposer = onAddFileToComposer,
    )

    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    val snackbarHostState = remember { SnackbarHostState() }
    val downloadFailedTitle = stringResource(R.string.files_download_failed)
    val downloadFailedDefault = stringResource(R.string.files_download_failed_default)
    val downloadPicker = rememberLauncherForActivityResult(CreateDocumentNamed()) { uri ->
        val pending = viewModel.downloads.value.ready
        if (uri != null && pending != null) {
            scope.launch {
                if (!FileDownloads.writeTo(context, uri, pending.bytes)) {
                    snackbarHostState.showSnackbar("$downloadFailedTitle: $downloadFailedDefault")
                }
            }
        }
        viewModel.consumeReadyDownload()
    }
    LaunchedEffect(downloads.ready) {
        val pending = downloads.ready ?: return@LaunchedEffect
        downloadPicker.launch(pending.mimeType to pending.fileName)
    }
    LaunchedEffect(downloads.error) {
        downloads.error?.let { detail ->
            snackbarHostState.showSnackbar("$downloadFailedTitle: $detail")
            viewModel.clearDownloadError()
        }
    }

    Scaffold(
        modifier = modifier.fillMaxSize(),
        snackbarHost = { SnackbarHost(snackbarHostState) },
        topBar = {
            TopAppBar(
                navigationIcon = {
                    IconButton(onClick = onBack) {
                        Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = stringResource(R.string.files_back))
                    }
                },
                title = { Text(stringResource(R.string.files_title)) },
                actions = {
                    IconButton(
                        onClick = {
                            when (tab) {
                                0 -> viewModel.refreshChanges()
                                1 -> viewModel.refreshBrowse()
                                else -> viewModel.refreshSearch()
                            }
                        },
                    ) {
                        Icon(Icons.Filled.Refresh, contentDescription = stringResource(R.string.files_refresh))
                    }
                },
            )
        },
    ) { padding ->
        Column(
            modifier = Modifier
                .fillMaxSize()
                .padding(padding),
        ) {
            TabRow(selectedTabIndex = tab) {
                Tab(selected = tab == 0, onClick = { tab = 0 }, text = { Text(stringResource(R.string.files_tab_changes)) })
                Tab(selected = tab == 1, onClick = { tab = 1 }, text = { Text(stringResource(R.string.files_tab_browse)) })
                Tab(selected = tab == 2, onClick = { tab = 2 }, text = { Text(stringResource(R.string.files_tab_search)) })
            }
            when (tab) {
                0 -> ChangesTab(changes, onOpenFile, menuActions)
                1 -> BrowseTab(
                    browse,
                    downloads,
                    sort,
                    onSetSort = viewModel::setSort,
                    onToggleDirectory = viewModel::toggleDirectory,
                    onToggleHidden = viewModel::setShowHidden,
                    onOpenFile = { path -> onOpenFile(path, null) },
                    onDownloadFile = viewModel::downloadFile,
                    menuActions = menuActions,
                )
                else -> SearchTab(
                    search,
                    sort,
                    onSetSort = viewModel::setSort,
                    onQueryChange = viewModel::setSearchQuery,
                    onOpenFile = { path -> onOpenFile(path, null) },
                    menuActions = menuActions,
                )
            }
        }
    }
}

// ------------------------------------------------------- file-action menu --

/** Cross-tab wiring for the long-press file menu (web `FileActionMenu` twin). */
private data class FileMenuActions(
    val menuPath: String?,
    val workspacePath: String?,
    val onOpenMenu: (String) -> Unit,
    val onDismissMenu: () -> Unit,
    val onAddToComposer: ((path: String) -> Unit)?,
)

/**
 * The long-press file-action menu (web `FileActionMenu` twin), anchored inside
 * a row; expanded only for the row whose path the menu holds.
 */
@Composable
private fun FileActionsMenu(actions: FileMenuActions, path: String) {
    // Sync clipboard API is the deliberate choice (PathRow / CodeBlock precedent).
    @Suppress("DEPRECATION")
    val clipboard = LocalClipboardManager.current
    val haptic = LocalHapticFeedback.current

    fun copy(value: String) {
        clipboard.setText(AnnotatedString(value))
        haptic.performHapticFeedback(HapticFeedbackType.LongPress)
        actions.onDismissMenu()
    }

    DropdownMenu(
        expanded = actions.menuPath == path,
        onDismissRequest = actions.onDismissMenu,
    ) {
        Text(
            text = stringResource(R.string.files_menu_title),
            fontSize = 11.sp,
            fontWeight = FontWeight.SemiBold,
            letterSpacing = 0.8.sp,
            color = MaterialTheme.hapi.hint,
            modifier = Modifier.padding(horizontal = 16.dp, vertical = 6.dp),
        )
        DropdownMenuItem(
            text = { Text(stringResource(R.string.files_menu_copy_path)) },
            onClick = { copy(path) },
        )
        DropdownMenuItem(
            text = { Text(stringResource(R.string.files_menu_copy_absolute_path)) },
            onClick = {
                copy(FilePaths.resolveAbsoluteFilePath(actions.workspacePath, path))
            },
        )
        actions.onAddToComposer?.let { addToComposer ->
            DropdownMenuItem(
                text = { Text(stringResource(R.string.files_menu_add_to_composer)) },
                onClick = {
                    actions.onDismissMenu()
                    addToComposer(path)
                },
            )
        }
    }
}

// ------------------------------------------------------------ Changes tab --

@Composable
private fun ChangesTab(
    state: ChangesUiState,
    onOpenFile: (path: String, staged: Boolean?) -> Unit,
    menuActions: FileMenuActions,
) {
    val colors = MaterialTheme.hapi

    Column(modifier = Modifier.fillMaxSize()) {
        state.error?.let { ErrorBanner(it) }

        when {
            state.loading && state.status == null -> CenteredProgress()
            state.status == null -> CenteredHint(stringResource(R.string.files_git_unavailable))
            else -> {
                val status = state.status

                Row(
                    modifier = Modifier
                        .fillMaxWidth()
                        .padding(horizontal = 16.dp, vertical = 10.dp),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(8.dp),
                ) {
                    Icon(
                        GitBranchGlyph,
                        contentDescription = null,
                        tint = colors.hint,
                        modifier = Modifier.size(16.dp),
                    )
                    Column {
                        Text(
                            text = status.branch ?: stringResource(R.string.files_detached_head),
                            fontWeight = FontWeight.SemiBold,
                            style = MaterialTheme.typography.bodyMedium,
                        )
                        Text(
                            text = stringResource(
                                R.string.files_staged_unstaged,
                                status.totalStaged,
                                status.totalUnstaged,
                            ),
                            fontSize = 12.sp,
                            color = colors.hint,
                        )
                    }
                }

                if (status.stagedFiles.isEmpty() && status.unstagedFiles.isEmpty()) {
                    CenteredHint(stringResource(R.string.files_no_changes))
                } else {
                    LazyColumn(modifier = Modifier.fillMaxSize()) {
                        if (status.stagedFiles.isNotEmpty()) {
                            item(key = "staged-header") {
                                SectionHeader(stringResource(R.string.files_staged_header, status.stagedFiles.size))
                            }
                            items(
                                status.stagedFiles.size,
                                key = { "staged-${status.stagedFiles[it].fullPath}-$it" },
                            ) { index ->
                                val file = status.stagedFiles[index]
                                GitFileRow(file, menuActions) { onOpenFile(file.fullPath, true) }
                            }
                        }
                        if (status.unstagedFiles.isNotEmpty()) {
                            item(key = "unstaged-header") {
                                SectionHeader(stringResource(R.string.files_unstaged_header, status.unstagedFiles.size))
                            }
                            items(
                                status.unstagedFiles.size,
                                key = { "unstaged-${status.unstagedFiles[it].fullPath}-$it" },
                            ) { index ->
                                val file = status.unstagedFiles[index]
                                GitFileRow(file, menuActions) { onOpenFile(file.fullPath, false) }
                            }
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun SectionHeader(text: String) {
    Text(
        text = text,
        fontSize = 12.sp,
        fontWeight = FontWeight.SemiBold,
        color = MaterialTheme.hapi.hint,
        modifier = Modifier
            .fillMaxWidth()
            .background(MaterialTheme.hapi.codeHeaderBackground)
            .padding(horizontal = 16.dp, vertical = 6.dp),
    )
}

@OptIn(ExperimentalFoundationApi::class)
@Composable
private fun GitFileRow(file: GitFileStatus, menuActions: FileMenuActions, onClick: () -> Unit) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .combinedClickable(
                onClick = onClick,
                onLongClick = { menuActions.onOpenMenu(file.fullPath) },
            )
            .padding(horizontal = 16.dp, vertical = 8.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        Column(modifier = Modifier.weight(1f)) {
            Text(
                text = file.fileName,
                style = MaterialTheme.typography.bodyMedium,
                fontWeight = FontWeight.Medium,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
            val subtitle = file.oldPath?.let { "$it → ${file.fullPath}" }
                ?: file.filePath.ifEmpty { stringResource(R.string.files_project_root) }
            Text(
                text = subtitle,
                fontSize = 12.sp,
                color = MaterialTheme.hapi.hint,
                maxLines = 1,
                overflow = TextOverflow.MiddleEllipsis,
            )
        }
        if (file.linesAdded > 0 || file.linesRemoved > 0) {
            Text(
                text = buildString {
                    if (file.linesAdded > 0) append("+${file.linesAdded}")
                    if (file.linesAdded > 0 && file.linesRemoved > 0) append(' ')
                    if (file.linesRemoved > 0) append("-${file.linesRemoved}")
                },
                fontFamily = FontFamily.Monospace,
                fontSize = 11.sp,
                color = MaterialTheme.hapi.hint,
            )
        }
        StatusBadge(file)
        FileActionsMenu(menuActions, file.fullPath)
    }
}

@Composable
private fun StatusBadge(file: GitFileStatus) {
    val color = statusColor(file.status, MaterialTheme.hapi.isDark)
    Text(
        text = statusLetter(file.status),
        fontSize = 10.sp,
        fontWeight = FontWeight.SemiBold,
        color = color,
        modifier = Modifier
            .border(1.dp, color, RoundedCornerShape(4.dp))
            .padding(horizontal = 6.dp, vertical = 2.dp),
    )
}

// ------------------------------------------------------------- Browse tab --

@Composable
private fun BrowseTab(
    state: BrowseUiState,
    downloads: DownloadsUiState,
    sort: DirectorySort,
    onSetSort: (DirectorySort) -> Unit,
    onToggleDirectory: (String) -> Unit,
    onToggleHidden: (Boolean) -> Unit,
    onOpenFile: (path: String) -> Unit,
    onDownloadFile: (path: String, fileName: String) -> Unit,
    menuActions: FileMenuActions,
) {
    val colors = MaterialTheme.hapi

    Column(modifier = Modifier.fillMaxSize()) {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .clickable { onToggleHidden(!state.showHidden) }
                .padding(start = 8.dp, end = 4.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Checkbox(checked = state.showHidden, onCheckedChange = onToggleHidden)
            Text(stringResource(R.string.files_show_hidden), fontSize = 13.sp, color = colors.hint)
            Spacer(Modifier.weight(1f))
            DirectorySortMenuButton(sort, onSetSort)
        }

        LazyColumn(modifier = Modifier.fillMaxSize()) {
            items(state.rows.size) { index ->
                when (val row = state.rows[index]) {
                    is BrowseRow.Dir -> DirectoryRow(row, onToggleDirectory)
                    is BrowseRow.File -> FileRow(row, downloads, onOpenFile, onDownloadFile, menuActions)
                    is BrowseRow.Loading -> Row(
                        modifier = Modifier
                            .fillMaxWidth()
                            .padding(start = rowIndent(row.depth) + 16.dp, top = 10.dp, bottom = 10.dp),
                    ) {
                        CircularProgressIndicator(modifier = Modifier.size(16.dp), strokeWidth = 2.dp)
                    }
                    is BrowseRow.Error -> Text(
                        text = row.message,
                        fontSize = 12.sp,
                        color = MaterialTheme.colorScheme.error,
                        modifier = Modifier
                            .fillMaxWidth()
                            .padding(start = rowIndent(row.depth) + 16.dp, top = 8.dp, bottom = 8.dp, end = 16.dp),
                    )
                }
            }
        }
    }
}

// -------------------------------------------------------------- sort menu --

/**
 * Sort control (web `DirectorySortMenu` twin): field group keeps the current
 * direction; direction labels follow the field (A→Z / oldest / smallest …).
 */
@Composable
private fun DirectorySortMenuButton(sort: DirectorySort, onChange: (DirectorySort) -> Unit) {
    var expanded by remember { mutableStateOf(false) }

    Box {
        IconButton(onClick = { expanded = true }) {
            Icon(SortGlyph, contentDescription = stringResource(R.string.files_sort))
        }
        DropdownMenu(expanded = expanded, onDismissRequest = { expanded = false }) {
            Text(
                text = stringResource(R.string.files_sort_by),
                fontSize = 11.sp,
                fontWeight = FontWeight.SemiBold,
                letterSpacing = 0.8.sp,
                color = MaterialTheme.hapi.hint,
                modifier = Modifier.padding(horizontal = 16.dp, vertical = 6.dp),
            )
            for (field in DirectorySortField.entries) {
                DropdownMenuItem(
                    text = { Text(stringResource(sortFieldLabelRes(field))) },
                    onClick = {
                        onChange(sort.copy(field = field))
                        expanded = false
                    },
                    trailingIcon = {
                        if (sort.field == field) Icon(Icons.Default.Check, contentDescription = null)
                    },
                )
            }
            HorizontalDivider(modifier = Modifier.padding(vertical = 4.dp))
            for (direction in DirectorySortDirection.entries) {
                DropdownMenuItem(
                    text = { Text(stringResource(sortDirectionLabelRes(sort.field, direction))) },
                    onClick = {
                        onChange(sort.copy(direction = direction))
                        expanded = false
                    },
                    trailingIcon = {
                        if (sort.direction == direction) Icon(Icons.Default.Check, contentDescription = null)
                    },
                )
            }
        }
    }
}

private fun sortFieldLabelRes(field: DirectorySortField): Int = when (field) {
    DirectorySortField.NAME -> R.string.files_sort_name
    DirectorySortField.MODIFIED -> R.string.files_sort_modified
    DirectorySortField.SIZE -> R.string.files_sort_size
}

private fun sortDirectionLabelRes(field: DirectorySortField, direction: DirectorySortDirection): Int =
    when (field) {
        DirectorySortField.NAME ->
            if (direction == DirectorySortDirection.ASC) R.string.files_sort_name_asc else R.string.files_sort_name_desc
        DirectorySortField.MODIFIED ->
            if (direction == DirectorySortDirection.ASC) R.string.files_sort_oldest else R.string.files_sort_newest
        DirectorySortField.SIZE ->
            if (direction == DirectorySortDirection.ASC) R.string.files_sort_smallest else R.string.files_sort_largest
    }

private fun rowIndent(depth: Int) = (depth * 16).dp

@Composable
private fun DirectoryRow(row: BrowseRow.Dir, onToggle: (String) -> Unit) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .clickable { onToggle(row.path) }
            .padding(start = rowIndent(row.depth) + 8.dp, end = 16.dp, top = 8.dp, bottom = 8.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(4.dp),
    ) {
        Icon(
            if (row.expanded) Icons.Filled.KeyboardArrowDown else Icons.AutoMirrored.Filled.KeyboardArrowRight,
            contentDescription = stringResource(if (row.expanded) R.string.files_collapse else R.string.files_expand),
            tint = MaterialTheme.hapi.hint,
            modifier = Modifier.size(18.dp),
        )
        Icon(
            FolderGlyph,
            contentDescription = null,
            tint = MaterialTheme.colorScheme.primary,
            modifier = Modifier.size(18.dp),
        )
        Text(
            text = row.name,
            style = MaterialTheme.typography.bodyMedium,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
        )
    }
}

@OptIn(ExperimentalFoundationApi::class)
@Composable
private fun FileRow(
    row: BrowseRow.File,
    downloads: DownloadsUiState,
    onOpenFile: (path: String) -> Unit,
    onDownloadFile: (path: String, fileName: String) -> Unit,
    menuActions: FileMenuActions,
) {
    val isDownloading = downloads.inFlightPath == row.path
    // One download at a time (web `downloadingPath` single-flight).
    val downloadBusy = downloads.inFlightPath != null || downloads.ready != null

    Row(
        modifier = Modifier
            .fillMaxWidth()
            .combinedClickable(
                onClick = { onOpenFile(row.path) },
                onLongClick = { menuActions.onOpenMenu(row.path) },
            )
            // Files align with sibling directory names (chevron width offset).
            .padding(start = rowIndent(row.depth) + 30.dp, end = 8.dp, top = 8.dp, bottom = 8.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Column(modifier = Modifier.weight(1f)) {
            Text(
                text = row.name,
                style = MaterialTheme.typography.bodyMedium,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
            formatFileMetadata(row.size, row.modified)?.let {
                Text(text = it, fontSize = 11.sp, color = MaterialTheme.hapi.hint)
            }
        }
        if (isDownloading) {
            CircularProgressIndicator(modifier = Modifier.size(16.dp), strokeWidth = 2.dp)
        } else {
            IconButton(
                onClick = { onDownloadFile(row.path, row.name) },
                enabled = !downloadBusy,
            ) {
                Icon(
                    DownloadGlyph,
                    contentDescription = stringResource(R.string.files_download_named, row.name),
                )
            }
        }
        FileActionsMenu(menuActions, row.path)
    }
}

// ------------------------------------------------------------- Search tab --

@Composable
private fun SearchTab(
    state: SearchUiState,
    sort: DirectorySort,
    onSetSort: (DirectorySort) -> Unit,
    onQueryChange: (String) -> Unit,
    onOpenFile: (path: String) -> Unit,
    menuActions: FileMenuActions,
) {
    Column(modifier = Modifier.fillMaxSize()) {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .padding(horizontal = 16.dp, vertical = 8.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            OutlinedTextField(
                value = state.query,
                onValueChange = onQueryChange,
                modifier = Modifier.weight(1f),
                placeholder = { Text(stringResource(R.string.files_search_placeholder)) },
                leadingIcon = { Icon(Icons.Filled.Search, contentDescription = null) },
                singleLine = true,
            )
            // Web shows the sort control once a query is in flight (files.tsx).
            if (state.query.isNotBlank()) {
                Spacer(Modifier.width(8.dp))
                DirectorySortMenuButton(sort, onSetSort)
            }
        }

        when {
            state.query.isBlank() -> CenteredHint(stringResource(R.string.files_search_hint))
            state.loading -> CenteredProgress()
            state.error != null -> ErrorBanner(state.error)
            state.searched && state.results.isEmpty() -> CenteredHint(stringResource(R.string.files_search_no_match))
            else -> LazyColumn(modifier = Modifier.fillMaxSize()) {
                items(state.results, key = { it.fullPath }) { item ->
                    SearchResultRow(item, menuActions) { onOpenFile(item.fullPath) }
                }
            }
        }
    }
}

@OptIn(ExperimentalFoundationApi::class)
@Composable
private fun SearchResultRow(item: FileSearchItem, menuActions: FileMenuActions, onClick: () -> Unit) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .combinedClickable(
                onClick = onClick,
                onLongClick = { menuActions.onOpenMenu(item.fullPath) },
            )
            .padding(horizontal = 16.dp, vertical = 8.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Column(modifier = Modifier.weight(1f)) {
            Text(
                text = item.fullPath,
                style = MaterialTheme.typography.bodyMedium,
                maxLines = 1,
                overflow = TextOverflow.MiddleEllipsis,
            )
            formatFileMetadata(item.size, item.modified)?.let {
                Text(text = it, fontSize = 11.sp, color = MaterialTheme.hapi.hint)
            }
        }
        FileActionsMenu(menuActions, item.fullPath)
    }
}

// ------------------------------------------------------------------ misc --

@Composable
private fun ErrorBanner(message: String) {
    Text(
        text = message,
        fontSize = 12.sp,
        color = MaterialTheme.colorScheme.onErrorContainer,
        modifier = Modifier
            .fillMaxWidth()
            .background(MaterialTheme.colorScheme.errorContainer)
            .padding(horizontal = 16.dp, vertical = 8.dp),
    )
}

@Composable
private fun CenteredProgress() {
    Box(
        modifier = Modifier
            .fillMaxWidth()
            .padding(top = 48.dp),
        contentAlignment = Alignment.Center,
    ) {
        CircularProgressIndicator()
    }
}

@Composable
private fun CenteredHint(text: String) {
    Box(
        modifier = Modifier
            .fillMaxWidth()
            .padding(horizontal = 24.dp, vertical = 48.dp),
        contentAlignment = Alignment.Center,
    ) {
        Text(text = text, fontSize = 13.sp, color = MaterialTheme.hapi.hint)
    }
}
