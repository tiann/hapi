package app.hapi.companion.feature.chat.blocks

import android.content.ActivityNotFoundException
import android.content.Intent
import android.media.MediaPlayer
import android.net.Uri
import android.widget.MediaController
import android.widget.VideoView
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.PlayArrow
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Slider
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import androidx.core.content.FileProvider
import app.hapi.companion.R
import app.hapi.companion.feature.chat.LocalChatMedia
import app.hapi.companion.ui.theme.hapi
import app.hapi.protocol.chat.GeneratedImageBlock
import coil.compose.AsyncImage
import coil.compose.AsyncImagePainter
import java.io.File
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

/**
 * One hub-generated media block (`generated-image` on the wire; the hub
 * endpoint serves any mime). Intent routing is the web's: `video/…` / `audio/…`
 * get players, `image/…` or a null mime keep the image treatment, everything
 * else is a file card. Non-image media never downloads on its own — the web
 * comment "Non-image media can be tens of MB; wait for explicit user intent"
 * is the rule here too, so those kinds show a Load/Prepare button first
 * (web report §3 / G3-G14).
 */
@Composable
fun GeneratedImageBlockView(block: GeneratedImageBlock, modifier: Modifier = Modifier) {
    when (generatedMediaKind(block.mimeType)) {
        GeneratedMediaKind.IMAGE -> GeneratedImageCardContent(block, modifier)
        GeneratedMediaKind.VIDEO,
        GeneratedMediaKind.AUDIO,
        GeneratedMediaKind.FILE,
        -> GeneratedGatedMediaCardContent(block, modifier)
    }
}

/**
 * Web G14 card shell: rounded bordered card with a "{label}: {fileName}"
 * hint header, used by every generated media kind (images included).
 */
@Composable
private fun GeneratedMediaCard(block: GeneratedImageBlock, modifier: Modifier = Modifier, content: @Composable () -> Unit) {
    val kind = generatedMediaKind(block.mimeType)
    val label = stringResource(kind.labelRes)
    Surface(
        shape = RoundedCornerShape(16.dp),
        color = MaterialTheme.colorScheme.surface.copy(alpha = 0.55f),
        border = BorderStroke(1.dp, MaterialTheme.colorScheme.outlineVariant),
        modifier = modifier.fillMaxWidth(),
    ) {
        Column(Modifier.padding(12.dp)) {
            Text(
                text = stringResource(R.string.media_displayed_header, label, block.fileName),
                style = MaterialTheme.typography.labelMedium,
                color = MaterialTheme.hapi.hint,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier.padding(bottom = 8.dp),
            )
            content()
        }
    }
}

/** The label ("Displayed video" …) localized, shared by the error line. */
@Composable
private fun mediaLabel(block: GeneratedImageBlock): String =
    stringResource(generatedMediaKind(block.mimeType).labelRes)

/** Web G8 error line: "{label} is unavailable. {error}". */
@Composable
private fun GeneratedMediaErrorLine(label: String, error: String?, modifier: Modifier = Modifier) {
    Text(
        text = stringResource(
            R.string.media_displayed_unavailable,
            label,
            error ?: stringResource(R.string.media_load_failed),
        ),
        style = MaterialTheme.typography.bodySmall,
        color = MaterialTheme.hapi.hint,
        modifier = modifier.padding(vertical = 4.dp),
    )
}

/**
 * Image intent: unchanged rendering — authed Coil thumbnail, tap opens the
 * full-screen viewer dialog (no skeleton: image loads hit the warm 256 MB
 * disk cache). On Coil failure the card now shows the web's unavailable
 * line instead of a silent empty hole (G8).
 */
@Composable
private fun GeneratedImageCardContent(block: GeneratedImageBlock, modifier: Modifier = Modifier) {
    val media = LocalChatMedia.current
    val url = remember(block.imageId) { media.generatedImageUrl(block.imageId) }
    var viewerOpen by remember(block.id) { mutableStateOf(false) }
    var failed by remember(block.id) { mutableStateOf(false) }
    val label = mediaLabel(block)
    val loader = media.imageLoader

    if (loader == null || url == null) {
        GeneratedMediaCard(block, modifier) {
            Text(
                text = "🖼 ${block.fileName}",
                style = MaterialTheme.typography.labelMedium,
                color = MaterialTheme.hapi.hint,
                modifier = Modifier.padding(vertical = 4.dp),
            )
        }
        return
    }

    GeneratedMediaCard(block, modifier) {
        if (failed) {
            GeneratedMediaErrorLine(label, error = null)
            return@GeneratedMediaCard
        }
        AsyncImage(
            model = url,
            imageLoader = loader,
            contentDescription = block.fileName,
            contentScale = ContentScale.Fit,
            onState = { state -> failed = state is AsyncImagePainter.State.Error },
            modifier = Modifier
                .fillMaxWidth()
                .heightIn(max = 360.dp)
                .clip(RoundedCornerShape(12.dp))
                .clickable { viewerOpen = true },
        )
    }

    if (viewerOpen) {
        Dialog(
            onDismissRequest = { viewerOpen = false },
            properties = DialogProperties(usePlatformDefaultWidth = false),
        ) {
            Box(
                modifier = Modifier
                    .fillMaxSize()
                    .background(Color.Black.copy(alpha = 0.92f))
                    .clickable { viewerOpen = false },
                contentAlignment = Alignment.Center,
            ) {
                AsyncImage(
                    model = url,
                    imageLoader = loader,
                    contentDescription = block.fileName,
                    contentScale = ContentScale.Fit,
                    modifier = Modifier.fillMaxSize().padding(8.dp),
                )
            }
        }
    }
}

/**
 * Video / audio / file intents — the web's gated card (G4): a Load /
 * Prepare-download button until the user asks, a pulsing skeleton while
 * fetching (G7), then the type's renderer, or the unavailable error line
 * (G8, no separate "unsupported" class: unknown mimes are FILE cards).
 */
@Composable
private fun GeneratedGatedMediaCardContent(block: GeneratedImageBlock, modifier: Modifier = Modifier) {
    val kind = generatedMediaKind(block.mimeType)
    val media = LocalChatMedia.current
    val url = remember(block.imageId) { media.generatedImageUrl(block.imageId) }
    var loadRequested by remember(block.id) { mutableStateOf(false) }
    var file by remember(block.id) { mutableStateOf<File?>(null) }
    var error by remember(block.id) { mutableStateOf<Throwable?>(null) }
    val label = mediaLabel(block)

    LaunchedEffect(block.imageId, loadRequested) {
        if (!loadRequested || file != null) return@LaunchedEffect
        val fetcher = media.fetchGeneratedMedia
        if (fetcher == null || url == null) {
            error = GeneratedMediaUnavailableException()
            return@LaunchedEffect
        }
        try {
            file = fetcher(url, block.imageId, block.fileName)
            error = null
        } catch (cancelled: kotlinx.coroutines.CancellationException) {
            throw cancelled
        } catch (t: Throwable) {
            error = t
        }
    }

    GeneratedMediaCard(block, modifier) {
        val current = file
        when {
            current != null -> when (kind) {
                GeneratedMediaKind.VIDEO -> GeneratedVideoPlayer(current, block, label)
                GeneratedMediaKind.AUDIO -> GeneratedAudioPlayer(current, label)
                GeneratedMediaKind.FILE -> GeneratedFileActions(current, block)
                GeneratedMediaKind.IMAGE -> Unit // unreachable: images never gate
            }
            error != null -> GeneratedMediaErrorLine(label, error!!.message)
            !loadRequested -> GeneratedMediaGateButton(kind) { loadRequested = true }
            else -> GeneratedMediaSkeleton()
        }
    }
}

/** Web G4 gate: h-48 w-72 subtle box whose label is the Load / Prepare button. */
@Composable
private fun GeneratedMediaGateButton(kind: GeneratedMediaKind, onLoad: () -> Unit) {
    Surface(
        onClick = onLoad,
        shape = RoundedCornerShape(12.dp),
        color = MaterialTheme.colorScheme.surface.copy(alpha = 0.4f),
        border = BorderStroke(1.dp, MaterialTheme.colorScheme.outlineVariant),
        modifier = Modifier.widthIn(max = 288.dp).fillMaxWidth().height(192.dp),
    ) {
        Box(contentAlignment = Alignment.Center, modifier = Modifier.fillMaxSize()) {
            Text(
                text = stringResource(kind.loadActionRes ?: R.string.media_prepare_download),
                style = MaterialTheme.typography.bodyMedium,
            )
        }
    }
}

/** Web G7 loading skeleton: gray pulsing h-48 w-72 block. */
@Composable
private fun GeneratedMediaSkeleton() {
    val transition = rememberInfiniteTransition(label = "generated-media-pulse")
    val alpha by transition.animateFloat(
        initialValue = 1f,
        targetValue = 0.4f,
        animationSpec = infiniteRepeatable(tween(700, easing = LinearEasing), RepeatMode.Reverse),
        label = "generated-media-pulse-alpha",
    )
    Box(
        modifier = Modifier
            .widthIn(max = 288.dp)
            .fillMaxWidth()
            .height(192.dp)
            .clip(RoundedCornerShape(12.dp))
            .alpha(alpha)
            .background(MaterialTheme.colorScheme.surface.copy(alpha = 0.4f)),
    )
}

/**
 * Video player — web G11 (`<video controls playsInline>`): framework
 * [VideoView] + [MediaController] in an [AndroidView], zero new media
 * dependencies (no Media3 on the classpath; adding it just for this card
 * is not worth the ~MB). Plays the downloaded cache file (no streaming:
 * the hub URL needs the JWT header the platform player cannot send).
 * Codec failures surface the web's unavailable line with a playback reason.
 */
@Composable
private fun GeneratedVideoPlayer(file: File, block: GeneratedImageBlock, label: String) {
    var playbackFailed by remember(block.id) { mutableStateOf(false) }
    val videoView = remember { mutableStateOf<VideoView?>(null) }
    DisposableEffect(file) {
        onDispose { videoView.value?.stopPlayback() }
    }
    if (playbackFailed) {
        GeneratedMediaErrorLine(label, stringResource(R.string.media_playback_failed))
        return
    }
    Box(
        modifier = Modifier
            .fillMaxWidth()
            .heightIn(min = 128.dp)
            .clip(RoundedCornerShape(12.dp))
            .background(MaterialTheme.colorScheme.surface.copy(alpha = 0.4f)),
        contentAlignment = Alignment.Center,
    ) {
        AndroidView(
            factory = { context ->
                VideoView(context).apply {
                    setBackgroundColor(android.graphics.Color.BLACK)
                    setVideoURI(Uri.fromFile(file))
                    val controller = MediaController(context)
                    controller.setMediaPlayer(this)
                    setMediaController(controller)
                    setOnErrorListener { _, _, _ ->
                        playbackFailed = true
                        true
                    }
                    videoView.value = this
                }
            },
            modifier = Modifier
                .fillMaxWidth()
                .heightIn(max = 448.dp)
                .clip(RoundedCornerShape(12.dp)),
        )
    }
}

/**
 * Audio player — web G12 (`<audio controls preload="metadata">`) degraded to
 * a compact row: play/pause + scrub + m:ss readout. The browser element's
 * volume/speed chrome has no framework-free equivalent here (device volume
 * keys cover volume); no waveform — the web card has none either.
 */
@Composable
private fun GeneratedAudioPlayer(file: File, label: String) {
    var prepared by remember(file) { mutableStateOf(false) }
    var playing by remember(file) { mutableStateOf(false) }
    var durationMs by remember(file) { mutableIntStateOf(0) }
    var positionMs by remember(file) { mutableIntStateOf(0) }
    var dragging by remember(file) { mutableStateOf(false) }
    var dragFraction by remember(file) { mutableFloatStateOf(0f) }
    var playbackFailed by remember(file) { mutableStateOf(false) }

    if (playbackFailed) {
        GeneratedMediaErrorLine(label, stringResource(R.string.media_playback_failed))
        return
    }

    val player = remember(file) { MediaPlayer() }
    DisposableEffect(player) {
        onDispose { player.release() }
    }
    LaunchedEffect(player) {
        player.setOnPreparedListener { p ->
            durationMs = p.duration
            prepared = true
        }
        player.setOnCompletionListener { playing = false }
        player.setOnErrorListener { _, _, _ ->
            playing = false
            playbackFailed = true
            true
        }
        runCatching {
            player.setDataSource(file.absolutePath)
            player.prepareAsync()
        }.onFailure { playbackFailed = true }
    }
    LaunchedEffect(playing) {
        while (playing) {
            positionMs = player.currentPosition
            delay(250)
        }
    }

    Row(
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(8.dp),
        modifier = Modifier.fillMaxWidth(),
    ) {
        IconButton(
            enabled = prepared,
            onClick = {
                if (playing) {
                    player.pause()
                    playing = false
                } else {
                    player.start()
                    playing = true
                }
            },
        ) {
            if (playing) {
                Icon(painterResource(R.drawable.ic_pause), stringResource(R.string.media_pause))
            } else {
                Icon(Icons.Filled.PlayArrow, stringResource(R.string.media_play))
            }
        }
        val fraction = if (dragging) {
            dragFraction
        } else if (durationMs > 0) {
            positionMs.coerceIn(0, durationMs).toFloat() / durationMs
        } else {
            0f
        }
        Slider(
            enabled = prepared,
            value = fraction.coerceIn(0f, 1f),
            onValueChange = {
                dragging = true
                dragFraction = it
            },
            onValueChangeFinished = {
                if (durationMs > 0) {
                    player.seekTo((dragFraction * durationMs).toInt().coerceIn(0, durationMs))
                    positionMs = player.currentPosition
                }
                dragging = false
            },
            modifier = Modifier.weight(1f),
        )
        Text(
            text = "${formatPlaybackTime(positionMs)} / ${formatPlaybackTime(durationMs)}",
            style = MaterialTheme.typography.labelSmall,
            color = MaterialTheme.hapi.hint,
        )
    }
}

/**
 * File intent — web G13's bordered icon + filename row; the browser's single
 * download link becomes the two Android outlets the platform offers: Open
 * (ACTION_VIEW over the FileProvider cache uri) and Save (system
 * ACTION_CREATE_DOCUMENT picker, no storage permission needed).
 */
@Composable
private fun GeneratedFileActions(file: File, block: GeneratedImageBlock) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    var openFailed by remember(block.id) { mutableStateOf(false) }
    var saveFailed by remember(block.id) { mutableStateOf(false) }
    val mimeType = block.mimeType ?: "application/octet-stream"
    val saveLauncher = rememberLauncherForActivityResult(
        ActivityResultContracts.CreateDocument(mimeType),
    ) { uri ->
        if (uri == null) return@rememberLauncherForActivityResult
        scope.launch {
            val saved = withContext(Dispatchers.IO) {
                runCatching {
                    context.contentResolver.openOutputStream(uri)?.use { out ->
                        file.inputStream().use { it.copyTo(out) }
                    } ?: error("stream closed")
                }.isSuccess
            }
            saveFailed = !saved
        }
    }

    if (openFailed) {
        Text(
            text = stringResource(R.string.media_open_failed),
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.error,
            modifier = Modifier.padding(bottom = 4.dp),
        )
    }
    if (saveFailed) {
        Text(
            text = stringResource(R.string.media_save_failed),
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.error,
            modifier = Modifier.padding(bottom = 4.dp),
        )
    }
    Row(
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(8.dp),
        modifier = Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(12.dp))
            .border(
                BorderStroke(1.dp, MaterialTheme.colorScheme.outlineVariant),
                RoundedCornerShape(12.dp),
            )
            .background(MaterialTheme.colorScheme.surface.copy(alpha = 0.4f))
            .padding(horizontal = 12.dp, vertical = 8.dp),
    ) {
        Icon(
            painterResource(R.drawable.ic_file),
            contentDescription = null,
            tint = MaterialTheme.hapi.hint,
            modifier = Modifier.size(24.dp),
        )
        Text(
            text = block.fileName,
            style = MaterialTheme.typography.bodyMedium,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
            modifier = Modifier.weight(1f),
        )
        TextButton(onClick = {
            openFailed = false
            val uri = FileProvider.getUriForFile(context, "${context.packageName}.attachments", file)
            val open = Intent(Intent.ACTION_VIEW).apply {
                setDataAndType(uri, mimeType)
                addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
            }
            try {
                context.startActivity(open)
            } catch (_: ActivityNotFoundException) {
                openFailed = true
            }
        }) { Text(stringResource(R.string.media_open)) }
        TextButton(onClick = {
            saveFailed = false
            saveLauncher.launch(block.fileName)
        }) { Text(stringResource(R.string.media_save)) }
    }
}

@androidx.compose.ui.tooling.preview.Preview(showBackground = true)
@Composable
private fun GeneratedMediaBlocksPreview() {
    // Gate states only — the loaded players (VideoView/MediaPlayer) are not
    // instantiated in previews; with the default ChatMedia (null fetcher)
    // a tapped gate would surface the unavailable line.
    app.hapi.companion.ui.theme.HapiTheme {
        androidx.compose.material3.Surface {
            Column(
                modifier = Modifier.padding(12.dp),
                verticalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                GeneratedImageBlockView(
                    GeneratedImageBlock(
                        id = "g1", localId = null, createdAt = 0, invokedAt = null,
                        imageId = "img-1", fileName = "screenshot.png",
                        mimeType = null, source = null, meta = null,
                    ),
                )
                GeneratedImageBlockView(
                    GeneratedImageBlock(
                        id = "g2", localId = null, createdAt = 0, invokedAt = null,
                        imageId = "img-2", fileName = "clip.mp4",
                        mimeType = "video/mp4", source = null, meta = null,
                    ),
                )
                GeneratedImageBlockView(
                    GeneratedImageBlock(
                        id = "g3", localId = null, createdAt = 0, invokedAt = null,
                        imageId = "img-3", fileName = "voice-memo.m4a",
                        mimeType = "audio/mp4", source = null, meta = null,
                    ),
                )
                GeneratedImageBlockView(
                    GeneratedImageBlock(
                        id = "g4", localId = null, createdAt = 0, invokedAt = null,
                        imageId = "img-4", fileName = "report.pdf",
                        mimeType = "application/pdf", source = null, meta = null,
                    ),
                )
            }
        }
    }
}
