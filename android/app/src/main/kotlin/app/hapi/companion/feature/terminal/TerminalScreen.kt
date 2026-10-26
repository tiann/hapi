package app.hapi.companion.feature.terminal

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.automirrored.filled.Send
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.derivedStateOf
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.layout.onSizeChanged
import androidx.compose.ui.platform.LocalClipboardManager
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.rememberTextMeasurer
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import app.hapi.companion.R
import app.hapi.companion.ui.theme.ReadingColumn

/** Font ladder mirrored from the web `useTerminalFontSize` (sp instead of px). */
private val TERMINAL_FONT_SIZES = intArrayOf(9, 11, 13, 15, 17)

/** Connection dot colors mirror the web indicator (emerald / amber / hint). */
private val TerminalConnectedColor = Color(0xFF10B981)
private val TerminalConnectingColor = Color(0xFBBF24)

/**
 * Interactive remote terminal: monospace grid rendering of the
 * emulator snapshot, connection status chrome, and the web compact-control
 * input area (command box + direct quick-key pages with sticky Ctrl/Alt).
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
internal fun TerminalScreen(
    viewModel: TerminalViewModel,
    onBack: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val state by viewModel.uiState.collectAsState()
    Scaffold(
        modifier = modifier.fillMaxSize(),
        topBar = {
            TerminalTopBar(
                subtitle = state.session.subtitle ?: viewModel.sessionId,
                status = state.status,
                fontSizeSp = state.fontSizeSp,
                onStepFont = viewModel::stepFont,
                onBack = onBack,
            )
        },
        bottomBar = {
            ReadingColumn {
                TerminalInputArea(
                    state = state,
                    onWrite = viewModel::write,
                    modifier = Modifier
                        .fillMaxWidth()
                        .navigationBarsPadding()
                        .imePadding(),
                )
            }
        },
    ) { padding ->
        Column(
            modifier = Modifier
                .fillMaxSize()
                .padding(padding),
        ) {
            TerminalBanners(state = state, onRetry = viewModel::retry)
            if (state.session.supported) {
                TerminalGrid(
                    state = state,
                    onGridMeasured = viewModel::onGridMeasured,
                    modifier = Modifier
                        .fillMaxWidth()
                        .weight(1f),
                )
            } else {
                UnsupportedBody(modifier = Modifier.weight(1f))
            }
        }
    }
}

// ------------------------------------------------------------------ top bar --

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun TerminalTopBar(
    subtitle: String,
    status: TerminalStatus,
    fontSizeSp: Int,
    onStepFont: (up: Boolean) -> Unit,
    onBack: () -> Unit,
) {
    TopAppBar(
        navigationIcon = {
            IconButton(onClick = onBack) {
                Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = stringResource(R.string.chat_back))
            }
        },
        title = {
            Column {
                Text(stringResource(R.string.terminal_title), style = MaterialTheme.typography.titleMedium)
                Text(
                    subtitle,
                    style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
            }
        },
        actions = {
            TextButton(
                onClick = { onStepFont(false) },
                enabled = fontSizeSp > TERMINAL_FONT_SIZES.first(),
            ) {
                Text(stringResource(R.string.terminal_font_decrease))
            }
            TextButton(
                onClick = { onStepFont(true) },
                enabled = fontSizeSp < TERMINAL_FONT_SIZES.last(),
            ) {
                Text(stringResource(R.string.terminal_font_increase))
            }
            StatusDot(status)
        },
    )
}

@Composable
private fun StatusDot(status: TerminalStatus) {
    val (color, labelRes) = when (status) {
        TerminalStatus.Connected -> TerminalConnectedColor to R.string.terminal_status_connected
        TerminalStatus.Connecting -> TerminalConnectingColor to R.string.terminal_status_connecting
        TerminalStatus.Idle, is TerminalStatus.Error ->
            MaterialTheme.colorScheme.onSurfaceVariant to R.string.terminal_status_offline
    }
    val label = stringResource(labelRes)
    Box(
        modifier = Modifier
            .padding(end = 12.dp)
            .size(10.dp)
            .background(color, CircleShape)
            .semantics { contentDescription = label },
    )
}

// ------------------------------------------------------------------ banners --

@Composable
private fun TerminalBanners(state: TerminalUiState, onRetry: () -> Unit) {
    if (state.session.loaded && !state.session.active) {
        InfoBanner(text = stringResource(R.string.terminal_inactive))
    }
    if (!state.session.supported) {
        ErrorBanner(text = stringResource(R.string.terminal_unsupported), retryLabel = null, onRetry = onRetry)
    }
    val status = state.status
    if (status is TerminalStatus.Error && state.session.supported) {
        ErrorBanner(
            text = status.message,
            retryLabel = if (state.session.active) stringResource(R.string.terminal_retry) else null,
            onRetry = onRetry,
        )
    }
    state.exitInfo?.let { exit -> InfoBanner(text = exitBannerText(exit)) }
}

@Composable
private fun exitBannerText(exit: TerminalExitInfo): String = when {
    exit.code != null && exit.signal != null ->
        stringResource(R.string.terminal_exited_with_code_and_signal, exit.code, exit.signal)
    exit.code != null -> stringResource(R.string.terminal_exited_with_code, exit.code)
    else -> stringResource(R.string.terminal_exited)
}

@Composable
private fun InfoBanner(text: String) {
    Surface(
        color = MaterialTheme.colorScheme.surfaceContainerHigh,
        contentColor = MaterialTheme.colorScheme.onSurfaceVariant,
        modifier = Modifier.fillMaxWidth(),
    ) {
        Text(
            text = text,
            style = MaterialTheme.typography.labelMedium,
            modifier = Modifier.padding(horizontal = 16.dp, vertical = 8.dp),
        )
    }
}

@Composable
private fun ErrorBanner(text: String, retryLabel: String?, onRetry: () -> Unit) {
    Surface(
        color = MaterialTheme.colorScheme.errorContainer,
        contentColor = MaterialTheme.colorScheme.onErrorContainer,
        modifier = Modifier.fillMaxWidth(),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text(
                text = text,
                style = MaterialTheme.typography.labelMedium,
                maxLines = 3,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier
                    .weight(1f)
                    .padding(start = 16.dp, top = 8.dp, bottom = 8.dp),
            )
            if (retryLabel != null) {
                TextButton(onClick = onRetry) { Text(retryLabel) }
            }
        }
    }
}

@Composable
private fun UnsupportedBody(modifier: Modifier = Modifier) {
    Box(modifier = modifier.fillMaxWidth(), contentAlignment = Alignment.Center) {
        Text(
            text = stringResource(R.string.terminal_unsupported),
            style = MaterialTheme.typography.bodyMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
    }
}

// --------------------------------------------------------------------- grid --

@Composable
private fun TerminalGrid(
    state: TerminalUiState,
    onGridMeasured: (cols: Int, rows: Int) -> Unit,
    modifier: Modifier = Modifier,
) {
    val fontSizeSp = state.fontSizeSp
    val textMeasurer = rememberTextMeasurer()
    // Char cell metrics for the current font: measure one monospace glyph at
    // the exact text style lines render with, so cols/rows floor-divide true.
    val cellSize = remember(fontSizeSp) {
        val style = TextStyle(fontFamily = FontFamily.Monospace, fontSize = fontSizeSp.sp)
        textMeasurer.measure(AnnotatedString("M"), style).size
    }
    val snapshot = state.snapshot
    val listState = rememberLazyListState()
    val atBottom by remember {
        derivedStateOf {
            val info = listState.layoutInfo
            (info.visibleItemsInfo.lastOrNull()?.index ?: -1) >= info.totalItemsCount - 2
        }
    }
    LaunchedEffect(snapshot) {
        if (snapshot.lines.isNotEmpty() && atBottom) {
            listState.scrollToItem(snapshot.lines.lastIndex)
        }
    }
    // 8dp horizontal line padding (TerminalLineText) is subtracted from the
    // measured width before the char-count floor division.
    val horizontalChromePx = with(LocalDensity.current) { 8.dp.toPx() }
    Box(
        modifier = modifier
            .fillMaxSize()
            .onSizeChanged { size ->
                if (cellSize.width <= 0 || cellSize.height <= 0) return@onSizeChanged
                val cols = ((size.width - horizontalChromePx) / cellSize.width)
                    .toInt().coerceAtLeast(1)
                val rows = (size.height / cellSize.height).toInt().coerceAtLeast(1)
                if (cols > 0 && rows > 0) onGridMeasured(cols, rows)
            },
    ) {
        LazyColumn(state = listState, modifier = Modifier.fillMaxSize()) {
            items(count = snapshot.lines.size, key = { index -> index }) { index ->
                TerminalLineText(
                    line = snapshot.lines[index],
                    fontSizeSp = fontSizeSp,
                    cursorVisible = snapshot.cursorVisible,
                )
            }
        }
    }
}

@Composable
private fun TerminalLineText(
    line: TerminalSnapshotLine,
    fontSizeSp: Int,
    cursorVisible: Boolean,
) {
    val text = remember(line, cursorVisible) { buildLineAnnotatedString(line, cursorVisible) }
    Text(
        text = text,
        softWrap = false,
        overflow = TextOverflow.Clip,
        style = TextStyle(fontFamily = FontFamily.Monospace, fontSize = fontSizeSp.sp),
        modifier = Modifier
            .fillMaxWidth()
            .padding(horizontal = 4.dp),
    )
}

/**
 * Maps emulator runs to styled spans. Defaults follow Material (onSurface /
 * transparent), indexed + RGB colors are absolute (VGA/xterm palette),
 * `inverse` swaps fg/bg, and the cursor renders as a swapped block.
 */
private fun buildLineAnnotatedString(line: TerminalSnapshotLine, cursorVisible: Boolean): AnnotatedString =
    buildAnnotatedString {
        for (run in line.runs) {
            pushStyle(runSpanStyle(run, cursorVisible))
            append(run.text)
            pop()
        }
    }

private fun runSpanStyle(run: TerminalRun, cursorVisible: Boolean): SpanStyle {
    val style = run.style
    var foreground = style.foreground
    var background = style.background
    if (style.inverse) {
        val swap = foreground
        foreground = if (background is TerminalColor.Default) TerminalColor.Indexed(0) else background
        background = if (swap is TerminalColor.Default) TerminalColor.Indexed(7) else swap
    }
    // Cursor swap happens in Compose-color space: the cursor paints over
    // whatever resolved colors this run ended up with.
    var fgCompose = composeColor(foreground, defaultForeground = true, bold = style.bold)
    var bgCompose = composeColor(background, defaultForeground = false, bold = style.bold)
    if (run.isCursor && cursorVisible) {
        val swap = fgCompose
        fgCompose = TerminalCursorForeground
        bgCompose = if (swap == TerminalDefaultForeground) TerminalCursorBackground else swap
    }
    return SpanStyle(
        color = fgCompose,
        background = bgCompose,
        fontWeight = if (style.bold) FontWeight.Bold else null,
        fontStyle = if (style.italic) FontStyle.Italic else null,
        textDecoration = when {
            style.strikethrough && style.underline ->
                TextDecoration.combine(listOf(TextDecoration.LineThrough, TextDecoration.Underline))
            style.strikethrough -> TextDecoration.LineThrough
            style.underline -> TextDecoration.Underline
            else -> null
        },
    )
}

/**
 * Terminal colors are theme-independent (VT palettes must render the same on
 * light and dark apps); only the two defaults would need Material — they map
 * to near-black / white, which reads correctly on both themes.
 */
private val TerminalDefaultForeground = Color(0xFFD8DEE9)
private val TerminalDefaultBackground = Color.Transparent
private val TerminalCursorForeground = Color(0xFF12161C)
private val TerminalCursorBackground = Color(0xFFD8DEE9)

private fun composeColor(color: TerminalColor, defaultForeground: Boolean, bold: Boolean): Color = when (color) {
    is TerminalColor.Default -> if (defaultForeground) TerminalDefaultForeground else TerminalDefaultBackground
    // Palette/RGB values are alpha-less 0xRRGGBB; Compose's Color(Int) reads ARGB.
    is TerminalColor.Indexed -> argb(TerminalPalette.resolveIndexed(color.index, bold))
    is TerminalColor.Rgb -> argb(color.rgb)
}

private fun argb(rgb: Int): Color = Color(0xFF000000.toInt() or rgb)

// ------------------------------------------------------------- input area --

private const val INPUT_MODE_COMMAND = "command"
private const val INPUT_MODE_DIRECT = "direct"

@Composable
private fun TerminalInputArea(
    state: TerminalUiState,
    onWrite: (String) -> Unit,
    modifier: Modifier = Modifier,
) {
    val inputEnabled = state.session.active && state.status == TerminalStatus.Connected
    var inputMode by rememberSaveable { mutableStateOf(INPUT_MODE_COMMAND) }
    var directPage by rememberSaveable { mutableStateOf(DIRECT_KEY_PAGE_IDS.first()) }
    var commandDraft by rememberSaveable { mutableStateOf("") }
    // Sticky Ctrl/Alt (screen-local; a rotation clears them, like the web
    // route resetting modifiers when its inputs re-mount).
    var ctrlActive by remember { mutableStateOf(false) }
    var altActive by remember { mutableStateOf(false) }

    fun resetModifiers() {
        ctrlActive = false
        altActive = false
    }

    /** Quick-key dispatch: apply sticky modifiers, send, consume them. */
    fun dispatch(sequence: String) {
        if (!inputEnabled) return
        val modifierState = ModifierState(ctrl = ctrlActive, alt = altActive)
        onWrite(applyModifierState(sequence, modifierState))
        if (shouldResetModifiers(sequence, modifierState)) resetModifiers()
    }

    fun submitCommand() {
        if (!inputEnabled || commandDraft.trim().isEmpty()) return
        onWrite(buildTerminalCommandSequence(commandDraft))
        commandDraft = ""
        resetModifiers()
    }

    Column(
        modifier = modifier.padding(horizontal = 8.dp, vertical = 6.dp),
        verticalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        SegmentedRow(
            options = listOf(
                INPUT_MODE_COMMAND to stringResource(R.string.terminal_input_mode_command),
                INPUT_MODE_DIRECT to stringResource(R.string.terminal_input_mode_direct),
            ),
            selected = inputMode,
            onSelect = {
                inputMode = it
                resetModifiers()
            },
            rowLabel = stringResource(R.string.terminal_input_mode),
        )
        if (inputMode == INPUT_MODE_COMMAND) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                OutlinedTextField(
                    value = commandDraft,
                    onValueChange = { commandDraft = it },
                    placeholder = { Text(stringResource(R.string.terminal_command_placeholder)) },
                    modifier = Modifier
                        .weight(1f)
                        .heightIn(min = 52.dp),
                    enabled = inputEnabled,
                    singleLine = false,
                    maxLines = 3,
                    textStyle = TextStyle(fontFamily = FontFamily.Monospace, fontSize = 13.sp),
                    keyboardOptions = KeyboardOptions(imeAction = ImeAction.Send),
                    keyboardActions = KeyboardActions(onSend = { submitCommand() }),
                )
                IconButton(
                    onClick = { submitCommand() },
                    enabled = inputEnabled && commandDraft.trim().isNotEmpty(),
                ) {
                    Icon(
                        Icons.AutoMirrored.Filled.Send,
                        contentDescription = stringResource(R.string.terminal_command_run),
                    )
                }
            }
            QuickKeyGrid(
                inputs = BASIC_COMMANDS,
                enabled = inputEnabled,
                ctrlActive = false,
                altActive = false,
                rowLabel = stringResource(R.string.terminal_command_shortcuts),
                // Command templates fill the box (web handleCommandTemplate);
                // the trailing space in `cd ` survives verbatim.
                onPress = { input -> input.sequence?.let { commandDraft = it } },
                onToggleModifier = {},
            )
            QuickKeyGrid(
                inputs = COMMAND_MODE_KEYS,
                enabled = inputEnabled,
                ctrlActive = false,
                altActive = false,
                rowLabel = stringResource(R.string.terminal_command_input_label),
                onPress = { input ->
                    // Android-only ⏎ key: insert an explicit newline into the
                    // draft (sent as CR by buildTerminalCommandSequence).
                    when (input.sequence) {
                        "\n" -> commandDraft += "\n"
                        else -> input.sequence?.let { dispatch(it) }
                    }
                },
                onToggleModifier = {},
            )
        } else {
            val clipboard = LocalClipboardManager.current
            val pasteLabel = stringResource(R.string.terminal_paste)
            SegmentedRow(
                options = DIRECT_KEY_PAGE_IDS.map { page -> page to stringResource(directPageLabel(page)) },
                selected = directPage,
                onSelect = { directPage = it },
                rowLabel = stringResource(R.string.terminal_direct_pages),
            )
            QuickKeyGrid(
                inputs = DIRECT_KEY_PAGES[directPage].orEmpty(),
                enabled = inputEnabled,
                ctrlActive = ctrlActive,
                altActive = altActive,
                rowLabel = stringResource(R.string.terminal_direct_pages),
                onPress = { input -> input.sequence?.let { dispatch(it) } },
                onToggleModifier = { modifier ->
                    if (!inputEnabled) return@QuickKeyGrid
                    // Web toggleModifier: enabling one clears the other.
                    if (modifier == MODIFIER_CTRL) {
                        ctrlActive = !ctrlActive
                        altActive = false
                    } else {
                        altActive = !altActive
                        ctrlActive = false
                    }
                },
                leading = if (directPage == "control") {
                    {
                        OutlinedButton(
                            onClick = {
                                val text = clipboard.getText()?.text
                                // Raw paste, no bracketed-paste wrapping (web parity).
                                if (!text.isNullOrEmpty()) dispatch(text)
                            },
                            enabled = inputEnabled,
                            modifier = Modifier
                                .fillMaxWidth()
                                .heightIn(min = 36.dp),
                            contentPadding = PaddingValues(horizontal = 8.dp),
                        ) { Text(pasteLabel) }
                    }
                } else {
                    null
                },
            )
        }
    }
}

@Composable
private fun directPageLabel(page: String): Int = when (page) {
    "control" -> R.string.terminal_direct_page_control
    "navigation" -> R.string.terminal_direct_page_navigation
    "shell" -> R.string.terminal_direct_page_shell
    else -> R.string.terminal_direct_page_symbols
}

/** Web-style segmented selector (two or four options, one selected). */
@Composable
private fun SegmentedRow(
    options: List<Pair<String, String>>,
    selected: String,
    onSelect: (String) -> Unit,
    rowLabel: String,
) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .height(40.dp)
            .semantics { contentDescription = rowLabel },
        horizontalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        options.forEach { (value, label) ->
            val active = value == selected
            if (active) {
                Button(
                    onClick = { onSelect(value) },
                    modifier = Modifier.weight(1f),
                    contentPadding = PaddingValues(horizontal = 4.dp),
                ) {
                    Text(label, maxLines = 1, overflow = TextOverflow.Ellipsis)
                }
            } else {
                OutlinedButton(
                    onClick = { onSelect(value) },
                    modifier = Modifier.weight(1f),
                    contentPadding = PaddingValues(horizontal = 4.dp),
                ) {
                    Text(label, maxLines = 1, overflow = TextOverflow.Ellipsis)
                }
            }
        }
    }
}

/**
 * Grid of quick keys: 4 per row (web `grid-cols-4`), with an optional leading
 * cell (paste). Modifier toggles show their sticky state as filled.
 */
@Composable
private fun QuickKeyGrid(
    inputs: List<QuickInput>,
    enabled: Boolean,
    ctrlActive: Boolean,
    altActive: Boolean,
    rowLabel: String,
    onPress: (QuickInput) -> Unit,
    onToggleModifier: (String) -> Unit,
    leading: (@Composable () -> Unit)? = null,
) {
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .semantics { contentDescription = rowLabel },
        verticalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        val rows = remember(inputs, leading) {
            val cells: List<QuickInput?> = buildList {
                if (leading != null) add(null)
                inputs.forEach { add(it) }
            }
            cells.chunked(4)
        }
        rows.forEach { rowInputs ->
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.spacedBy(6.dp),
            ) {
                rowInputs.forEach { input ->
                    when (input) {
                        // The leading slot (paste) is only ever the first cell.
                        null -> Box(modifier = Modifier.weight(1f)) { leading?.invoke() }
                        else -> QuickKeyButton(
                            input = input,
                            enabled = enabled,
                            active = (input.modifier == MODIFIER_CTRL && ctrlActive) ||
                                (input.modifier == MODIFIER_ALT && altActive),
                            // weight lives here: the button itself is not in RowScope.
                            modifier = Modifier.weight(1f),
                            onPress = onPress,
                            onToggleModifier = onToggleModifier,
                        )
                    }
                }
                // Pad short rows so every cell keeps equal width.
                repeat(4 - rowInputs.size) { Box(Modifier.weight(1f)) }
            }
        }
    }
}

@Composable
private fun QuickKeyButton(
    input: QuickInput,
    enabled: Boolean,
    active: Boolean,
    modifier: Modifier = Modifier,
    onPress: (QuickInput) -> Unit,
    onToggleModifier: (String) -> Unit,
) {
    val stickyModifier = input.modifier
    if (stickyModifier != null) {
        Button(
            onClick = { onToggleModifier(stickyModifier) },
            enabled = enabled,
            modifier = modifier.heightIn(min = 36.dp),
            contentPadding = PaddingValues(horizontal = 4.dp),
            colors = if (active) {
                ButtonDefaults.buttonColors()
            } else {
                ButtonDefaults.buttonColors(
                    containerColor = MaterialTheme.colorScheme.surfaceContainerHigh,
                    contentColor = MaterialTheme.colorScheme.onSurface,
                )
            },
        ) {
            Text(input.label, maxLines = 1, overflow = TextOverflow.Ellipsis)
        }
    } else {
        OutlinedButton(
            onClick = { onPress(input) },
            enabled = enabled,
            modifier = modifier.heightIn(min = 36.dp),
            contentPadding = PaddingValues(horizontal = 4.dp),
        ) {
            Text(input.label, maxLines = 1, overflow = TextOverflow.Ellipsis)
        }
    }
}
