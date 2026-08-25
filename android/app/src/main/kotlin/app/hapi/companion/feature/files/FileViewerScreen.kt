package app.hapi.companion.feature.files

import android.graphics.BitmapFactory
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.platform.LocalClipboardManager
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import app.hapi.companion.R
import app.hapi.companion.ui.components.DiffView
import app.hapi.companion.ui.markdown.CodeBlock
import app.hapi.companion.ui.markdown.Markdown
import app.hapi.companion.ui.theme.hapi
import kotlinx.coroutines.delay

/**
 * Single-file viewer (`chat/{sessionId}/file`), the Android take on web
 * `file.tsx`: diff mode (parsed unified diff in [DiffView], staged/unstaged
 * toggle) ⇄ full mode ([CodeBlock] with its 400-line highlight cap and copy
 * button; markdown gets a Source/Preview toggle over the shared [Markdown]
 * renderer; images decode to a bitmap). Top bar shows the file name with the
 * middle-ellipsized path and a copy-path action.
 *
 * Chat citations may carry a line number; per-line highlighting inside the
 * single-`Text` [CodeBlock] isn't cheap, so the viewer shows a "Line N" hint
 * chip instead of scrolling/highlighting (noted B-M4c trade-off).
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun FileViewerScreen(
    viewModel: FileViewerViewModel,
    onBack: () -> Unit,
    modifier: Modifier = Modifier,
) {
    DisposableEffect(viewModel) {
        viewModel.start()
        onDispose { }
    }

    val state by viewModel.state.collectAsState()
    val colors = MaterialTheme.hapi

    Scaffold(
        modifier = modifier.fillMaxSize(),
        topBar = {
            TopAppBar(
                navigationIcon = {
                    IconButton(onClick = onBack) {
                        Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = stringResource(R.string.files_back))
                    }
                },
                title = {
                    Column {
                        Text(
                            text = state.fileName,
                            maxLines = 1,
                            overflow = TextOverflow.Ellipsis,
                        )
                        Text(
                            text = formatFileMetadata(state.sizeBytes, state.modifiedAt) ?: state.path,
                            fontSize = 11.sp,
                            color = colors.hint,
                            maxLines = 1,
                            overflow = TextOverflow.MiddleEllipsis,
                        )
                    }
                },
                actions = {
                    IconButton(onClick = viewModel::refresh) {
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
            PathRow(path = state.path)
            ModeToggleRow(state, viewModel)

            Column(
                modifier = Modifier
                    .fillMaxSize()
                    .verticalScroll(rememberScrollState())
                    .padding(horizontal = 12.dp, vertical = 8.dp),
                verticalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                when (state.mode) {
                    ViewerMode.DIFF -> DiffContent(state)
                    ViewerMode.FILE -> FileContent(state)
                }
            }
        }
    }
}

@Composable
private fun PathRow(path: String) {
    val colors = MaterialTheme.hapi
    // Sync clipboard API is the deliberate choice, matching CodeBlock's copy.
    @Suppress("DEPRECATION")
    val clipboard = LocalClipboardManager.current
    var copied by remember { mutableStateOf(false) }
    LaunchedEffect(copied) {
        if (copied) {
            delay(1600)
            copied = false
        }
    }

    Row(
        modifier = Modifier
            .fillMaxWidth()
            .padding(start = 16.dp, end = 8.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        Text(
            text = path,
            fontSize = 12.sp,
            color = colors.hint,
            maxLines = 1,
            overflow = TextOverflow.MiddleEllipsis,
            modifier = Modifier.weight(1f),
        )
        Text(
            text = stringResource(if (copied) R.string.files_viewer_copied else R.string.files_viewer_copy_path),
            fontSize = 12.sp,
            fontWeight = FontWeight.Medium,
            color = if (copied) MaterialTheme.colorScheme.primary else colors.hint,
            modifier = Modifier
                .clickable {
                    clipboard.setText(AnnotatedString(path))
                    copied = true
                }
                .padding(horizontal = 8.dp, vertical = 6.dp),
        )
    }
}

@Composable
private fun ModeToggleRow(state: FileViewerUiState, viewModel: FileViewerViewModel) {
    val hasDiff = state.diff is DiffUiState.Ready
    val isMarkdownFile = (state.content as? FileContentUiState.Text)?.isMarkdown == true
    if (!hasDiff && !isMarkdownFile && state.focusLine == null) return

    Row(
        modifier = Modifier
            .fillMaxWidth()
            .padding(horizontal = 12.dp, vertical = 6.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        if (hasDiff) {
            ModeChip(stringResource(R.string.files_viewer_diff), state.mode == ViewerMode.DIFF) { viewModel.setMode(ViewerMode.DIFF) }
            ModeChip(stringResource(R.string.files_viewer_file), state.mode == ViewerMode.FILE) { viewModel.setMode(ViewerMode.FILE) }
        }
        if (hasDiff && state.mode == ViewerMode.DIFF) {
            Text("·", color = MaterialTheme.hapi.hint)
            ModeChip(stringResource(R.string.files_viewer_unstaged), !state.staged) { viewModel.setStaged(false) }
            ModeChip(stringResource(R.string.files_viewer_staged), state.staged) { viewModel.setStaged(true) }
        }
        if (isMarkdownFile && state.mode == ViewerMode.FILE) {
            if (hasDiff) Text("·", color = MaterialTheme.hapi.hint)
            ModeChip(stringResource(R.string.files_viewer_source), !state.markdownPreview) { viewModel.setMarkdownPreview(false) }
            ModeChip(stringResource(R.string.files_viewer_preview), state.markdownPreview) { viewModel.setMarkdownPreview(true) }
        }
        state.focusLine?.let { line ->
            Text(
                text = stringResource(R.string.files_viewer_line, line),
                fontSize = 11.sp,
                color = MaterialTheme.hapi.hint,
                modifier = Modifier.padding(start = 4.dp),
            )
        }
    }
}

@Composable
private fun ModeChip(label: String, selected: Boolean, onClick: () -> Unit) {
    val colors = MaterialTheme.hapi
    Text(
        text = label,
        fontSize = 12.sp,
        fontWeight = FontWeight.SemiBold,
        color = if (selected) MaterialTheme.colorScheme.onPrimary else colors.hint,
        modifier = Modifier
            .background(
                color = if (selected) MaterialTheme.colorScheme.primary else colors.codeHeaderBackground,
                shape = RoundedCornerShape(50),
            )
            .clickable(onClick = onClick)
            .padding(horizontal = 10.dp, vertical = 4.dp),
    )
}

// ---------------------------------------------------------------- content --

@Composable
private fun DiffContent(state: FileViewerUiState) {
    when (val diff = state.diff) {
        DiffUiState.Loading -> LoadingBlock()
        DiffUiState.Empty -> HintBlock(stringResource(R.string.files_viewer_no_changes))
        is DiffUiState.Failed -> HintBlock(diff.message)
        is DiffUiState.Ready -> diff.files.forEach { file ->
            DiffView(file = file, compact = false, modifier = Modifier.fillMaxWidth())
        }
    }
}

@Composable
private fun FileContent(state: FileViewerUiState) {
    when (val content = state.content) {
        FileContentUiState.Loading -> LoadingBlock()
        is FileContentUiState.Failed -> HintBlock(content.message)
        FileContentUiState.Empty -> HintBlock(stringResource(R.string.files_viewer_empty))
        FileContentUiState.Binary -> HintBlock(stringResource(R.string.files_viewer_binary))
        is FileContentUiState.Image -> ImageContent(content, state.fileName)
        is FileContentUiState.Text ->
            if (content.isMarkdown && state.markdownPreview) {
                Markdown(text = content.text, modifier = Modifier.fillMaxWidth())
            } else {
                CodeBlock(
                    code = content.text,
                    language = content.language,
                    modifier = Modifier.fillMaxWidth(),
                )
            }
    }
}

@Composable
private fun ImageContent(content: FileContentUiState.Image, fileName: String) {
    val bitmap = remember(content) {
        BitmapFactory.decodeByteArray(content.bytes, 0, content.bytes.size)?.asImageBitmap()
    }
    if (bitmap == null) {
        // SVG and other formats BitmapFactory can't decode.
        HintBlock(stringResource(R.string.files_viewer_image_unsupported))
    } else {
        Image(
            bitmap = bitmap,
            contentDescription = fileName,
            contentScale = ContentScale.Fit,
            modifier = Modifier.fillMaxWidth(),
        )
    }
}

@Composable
private fun LoadingBlock() {
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
private fun HintBlock(text: String) {
    Text(
        text = text,
        fontSize = 13.sp,
        color = MaterialTheme.hapi.hint,
        modifier = Modifier.padding(horizontal = 8.dp, vertical = 16.dp),
    )
}
