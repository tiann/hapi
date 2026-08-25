package app.hapi.companion.feature.settings

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.collectAsState
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.lerp
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.unit.dp
import app.hapi.companion.R
import app.hapi.protocol.wire.SqliteStorageUsageResponse

/**
 * Owner-only sqlite storage dashboard (web
 * `web/src/routes/settings/storage.tsx` + `StorageUsagePie` twin): a Canvas
 * donut of db/wal/shm plus legend rows with byte formatting, total and path,
 * and an explicit refresh.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun StorageScreen(
    viewModel: StorageViewModel,
    onBack: () -> Unit,
) {
    LaunchedEffect(viewModel) { viewModel.start() }
    val state by viewModel.state.collectAsState()

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text(stringResource(R.string.settings_storage)) },
                navigationIcon = {
                    IconButton(onClick = onBack) {
                        Icon(
                            Icons.AutoMirrored.Filled.ArrowBack,
                            contentDescription = stringResource(R.string.settings_back),
                        )
                    }
                },
            )
        },
    ) { padding ->
        Column(
            modifier = Modifier
                .fillMaxSize()
                .padding(padding)
                .verticalScroll(rememberScrollState())
                .padding(16.dp),
            verticalArrangement = Arrangement.spacedBy(16.dp),
        ) {
            Text(
                text = stringResource(R.string.settings_storage_description),
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            when (val current = state) {
                is StorageUiState.Loading -> Box(
                    modifier = Modifier
                        .fillMaxWidth()
                        .padding(vertical = 48.dp),
                    contentAlignment = Alignment.Center,
                ) { CircularProgressIndicator() }

                is StorageUiState.Error -> DashboardError(
                    isForbidden = current.isForbidden,
                    message = current.message,
                    onRetry = viewModel::refresh,
                )

                is StorageUiState.Data -> {
                    StorageUsageCard(usage = current.usage)
                    Button(
                        onClick = viewModel::refresh,
                        enabled = !current.isRefreshing,
                        modifier = Modifier.align(Alignment.End),
                    ) {
                        Text(
                            stringResource(
                                if (current.isRefreshing) R.string.settings_storage_refreshing
                                else R.string.settings_storage_refresh
                            ),
                        )
                    }
                }
            }
        }
    }
}

/** Shared owner-gate/error body for both dashboards (usage + storage). */
@Composable
internal fun DashboardError(
    isForbidden: Boolean,
    message: String?,
    onRetry: () -> Unit,
) {
    Surface(
        shape = MaterialTheme.shapes.medium,
        color = MaterialTheme.colorScheme.surfaceContainerLow,
        modifier = Modifier.fillMaxWidth(),
    ) {
        Column(
            modifier = Modifier.padding(16.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            Text(
                text = stringResource(
                    if (isForbidden) R.string.settings_owner_only else R.string.settings_load_error
                ),
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurface,
            )
            if (!isForbidden && !message.isNullOrBlank()) {
                Text(
                    text = message,
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
            if (!isForbidden) {
                Button(onClick = onRetry) { Text(stringResource(R.string.settings_retry)) }
            }
        }
    }
}

/** Donut + legend + total/path rows for one sqlite usage snapshot. */
@Composable
internal fun StorageUsageCard(usage: SqliteStorageUsageResponse, modifier: Modifier = Modifier) {
    val slices = StorageMath.slices(usage)
    Surface(
        shape = MaterialTheme.shapes.medium,
        color = MaterialTheme.colorScheme.surfaceContainerLow,
        modifier = modifier.fillMaxWidth(),
    ) {
        Column(modifier = Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            Text(
                text = stringResource(R.string.settings_storage_chart_title),
                style = MaterialTheme.typography.titleSmall,
            )
            if (slices.isEmpty()) {
                Text(
                    text = stringResource(R.string.settings_storage_chart_empty),
                    style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            } else {
                Box(modifier = Modifier.fillMaxWidth(), contentAlignment = Alignment.Center) {
                    StorageDonut(slices = slices, modifier = Modifier.size(180.dp))
                    Column(horizontalAlignment = Alignment.CenterHorizontally) {
                        // Hero number: the one figure the chart exists for.
                        Text(
                            text = UsageMath.formatBytes(usage.totalBytes),
                            style = MaterialTheme.typography.titleLarge,
                        )
                        Text(
                            text = stringResource(R.string.settings_storage_total),
                            style = MaterialTheme.typography.labelSmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    }
                }
                Column {
                    slices.forEach { slice -> StorageLegendRow(slice) }
                }
            }
            HorizontalDivider(color = MaterialTheme.colorScheme.outlineVariant)
            LabeledValueRow(
                label = stringResource(R.string.settings_storage_total),
                value = UsageMath.formatBytes(usage.totalBytes),
            )
            Column {
                Text(
                    text = stringResource(R.string.settings_storage_path),
                    style = MaterialTheme.typography.labelMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
                Text(
                    text = usage.path,
                    style = MaterialTheme.typography.bodySmall,
                    fontFamily = FontFamily.Monospace,
                )
            }
        }
    }
}

@Composable
private fun StorageLegendRow(slice: StorageMath.Slice) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .padding(vertical = 6.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Box(
            modifier = Modifier
                .size(10.dp)
                .background(sliceColor(slice.key), RoundedCornerShape(3.dp)),
        )
        Text(
            text = stringResource(sliceLabelRes(slice.key)),
            style = MaterialTheme.typography.bodyMedium,
            modifier = Modifier.padding(start = 10.dp),
        )
        Spacer(modifier = Modifier.weight(1f))
        Text(
            text = "${UsageMath.formatBytes(slice.bytes)} · ${StorageMath.formatPercent(slice.percent)}",
            style = MaterialTheme.typography.bodyMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
    }
}

@Composable
private fun LabeledValueRow(label: String, value: String) {
    Row(modifier = Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
        Text(
            text = label,
            style = MaterialTheme.typography.labelMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        Spacer(modifier = Modifier.weight(1f))
        Text(text = value, style = MaterialTheme.typography.bodyMedium)
    }
}

/**
 * Slice colors mirror the web formula (link / 55% link–hint mix / hint) in
 * Material tokens, so they track dynamic color and every theme mode. Fixed
 * per entity — a missing wal/shm file never repaints its neighbors — and the
 * legend rows carry identity, so color is never the only channel.
 */
@Composable
private fun sliceColor(key: StorageMath.SliceKey): Color = when (key) {
    StorageMath.SliceKey.DATABASE -> MaterialTheme.colorScheme.primary
    StorageMath.SliceKey.WAL -> lerp(
        MaterialTheme.colorScheme.primary,
        MaterialTheme.colorScheme.onSurfaceVariant,
        0.45f,
    )
    StorageMath.SliceKey.SHM -> MaterialTheme.colorScheme.onSurfaceVariant
}

private fun sliceLabelRes(key: StorageMath.SliceKey): Int = when (key) {
    StorageMath.SliceKey.DATABASE -> R.string.settings_storage_database
    StorageMath.SliceKey.WAL -> R.string.settings_storage_wal
    StorageMath.SliceKey.SHM -> R.string.settings_storage_shm
}

/**
 * The donut ring on a plain [Canvas]: stroke arcs per slice with a small
 * angular gap standing in for the 2px surface spacer whenever more than one
 * slice is drawn. Angles come precomputed from [StorageMath.slices].
 */
@Composable
internal fun StorageDonut(slices: List<StorageMath.Slice>, modifier: Modifier = Modifier) {
    val colors = slices.map { sliceColor(it.key) }
    Canvas(modifier = modifier) {
        val thickness = 26.dp.toPx()
        val inset = thickness / 2
        val arcSize = Size(size.width - thickness, size.height - thickness)
        val gapDegrees = if (slices.size > 1) 2f else 0f
        slices.forEachIndexed { index, slice ->
            val rawSweep = slice.endAngle - slice.startAngle
            // Keep hairline slices visible: drop the gap before dropping the arc.
            val gapped = rawSweep - gapDegrees > MIN_SWEEP_DEGREES
            val sweep = if (gapped) rawSweep - gapDegrees else rawSweep.coerceAtLeast(MIN_SWEEP_DEGREES)
            drawArc(
                color = colors[index],
                startAngle = if (gapped) slice.startAngle + gapDegrees / 2 else slice.startAngle,
                sweepAngle = sweep,
                useCenter = false,
                topLeft = Offset(inset, inset),
                size = arcSize,
                style = Stroke(width = thickness),
            )
        }
    }
}

private const val MIN_SWEEP_DEGREES = 0.5f
