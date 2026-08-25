package app.hapi.companion.feature.settings

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SegmentedButton
import androidx.compose.material3.SegmentedButtonDefaults
import androidx.compose.material3.SingleChoiceSegmentedButtonRow
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import app.hapi.companion.R
import app.hapi.protocol.wire.UsageSummaryBucket
import app.hapi.protocol.wire.UsageSummaryResponse
import kotlin.math.max

/**
 * Owner-only token-usage dashboard (web `web/src/routes/settings/usage.tsx`
 * twin): range segmented control, stat tiles, the Canvas daily bar chart, and
 * byAgent/byModel bar lists.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun UsageScreen(
    viewModel: UsageViewModel,
    onBack: () -> Unit,
) {
    LaunchedEffect(viewModel) { viewModel.start() }
    val range by viewModel.range.collectAsState()
    val state by viewModel.state.collectAsState()

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text(stringResource(R.string.settings_usage)) },
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
            UsageRangeControl(selected = range, onSelect = viewModel::setRange)

            when (val current = state) {
                is UsageUiState.Loading -> Box(
                    modifier = Modifier
                        .fillMaxWidth()
                        .padding(vertical = 48.dp),
                    contentAlignment = Alignment.Center,
                ) { CircularProgressIndicator() }

                is UsageUiState.Error -> DashboardError(
                    isForbidden = current.isForbidden,
                    message = current.message,
                    onRetry = viewModel::retry,
                )

                is UsageUiState.Data -> UsageSummaryContent(
                    summary = current.summary,
                    dailyBars = current.dailyBars,
                )
            }
        }
    }
}

@Composable
private fun UsageRangeControl(selected: UsageRange, onSelect: (UsageRange) -> Unit) {
    val options = UsageRange.entries
    SingleChoiceSegmentedButtonRow(modifier = Modifier.fillMaxWidth()) {
        options.forEachIndexed { index, option ->
            SegmentedButton(
                selected = option == selected,
                onClick = { onSelect(option) },
                shape = SegmentedButtonDefaults.itemShape(index = index, count = options.size),
            ) {
                Text(stringResource(rangeLabelRes(option)))
            }
        }
    }
}

private fun rangeLabelRes(range: UsageRange): Int = when (range) {
    UsageRange.SEVEN_DAYS -> R.string.settings_usage_range_7d
    UsageRange.THIRTY_DAYS -> R.string.settings_usage_range_30d
    UsageRange.ALL -> R.string.settings_usage_range_all
}

/** The loaded dashboard body — also the preview entry point. */
@Composable
internal fun UsageSummaryContent(
    summary: UsageSummaryResponse,
    dailyBars: List<UsageMath.DailyBar>,
) {
    Column(verticalArrangement = Arrangement.spacedBy(16.dp)) {
        UsageStatTiles(summary = summary)

        UsageSection(title = stringResource(R.string.settings_usage_daily_title)) {
            if (summary.daily.isEmpty()) {
                EmptyHint()
            } else {
                DailyBarChart(
                    bars = dailyBars,
                    modifier = Modifier.padding(horizontal = 12.dp, vertical = 12.dp),
                )
            }
        }

        UsageSection(title = stringResource(R.string.settings_usage_by_agent)) {
            UsageBarList(rows = summary.byAgent)
        }
        UsageSection(title = stringResource(R.string.settings_usage_by_model)) {
            UsageBarList(rows = summary.byModel)
        }

        Text(
            text = stringResource(R.string.settings_usage_sessions, summary.totals.sessions),
            style = MaterialTheme.typography.labelMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
    }
}

/** The eight headline tiles, two per row (web tile grid twin). */
@Composable
internal fun UsageStatTiles(summary: UsageSummaryResponse) {
    val totals = summary.totals
    val tiles: List<Pair<Int, String>> = listOf(
        R.string.settings_usage_total to UsageMath.formatTokens(totals.totalTokens),
        R.string.settings_usage_uncached to UsageMath.formatTokens(totals.uncachedTokens),
        R.string.settings_usage_input to UsageMath.formatTokens(totals.inputTokens),
        R.string.settings_usage_output to UsageMath.formatTokens(totals.outputTokens),
        R.string.settings_usage_cache_read to UsageMath.formatTokens(totals.cacheReadTokens),
        R.string.settings_usage_cache_creation to UsageMath.formatTokens(totals.cacheCreationTokens),
        R.string.settings_usage_cache_hit_rate to UsageMath.cacheHitRate(totals),
        R.string.settings_usage_requests to UsageMath.formatTokens(totals.requests),
    )
    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        tiles.chunked(2).forEach { rowTiles ->
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                rowTiles.forEach { (labelRes, value) ->
                    StatTile(
                        label = stringResource(labelRes),
                        value = value,
                        modifier = Modifier.weight(1f),
                    )
                }
            }
        }
    }
}

@Composable
private fun StatTile(label: String, value: String, modifier: Modifier = Modifier) {
    Surface(
        shape = MaterialTheme.shapes.medium,
        color = MaterialTheme.colorScheme.surfaceContainerLow,
        modifier = modifier,
    ) {
        Column(modifier = Modifier.padding(horizontal = 12.dp, vertical = 10.dp)) {
            Text(
                text = label,
                style = MaterialTheme.typography.labelMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
            Text(
                text = value,
                style = MaterialTheme.typography.titleLarge,
                modifier = Modifier.padding(top = 2.dp),
            )
        }
    }
}

@Composable
private fun UsageSection(title: String, content: @Composable () -> Unit) {
    Surface(
        shape = MaterialTheme.shapes.medium,
        color = MaterialTheme.colorScheme.surfaceContainerLow,
        modifier = Modifier.fillMaxWidth(),
    ) {
        Column {
            Text(
                text = title,
                style = MaterialTheme.typography.titleSmall,
                modifier = Modifier.padding(start = 16.dp, end = 16.dp, top = 12.dp, bottom = 4.dp),
            )
            content()
        }
    }
}

@Composable
private fun EmptyHint() {
    Text(
        text = stringResource(R.string.settings_usage_empty),
        style = MaterialTheme.typography.bodyMedium,
        color = MaterialTheme.colorScheme.onSurfaceVariant,
        modifier = Modifier.padding(horizontal = 16.dp, vertical = 12.dp),
    )
}

/**
 * Ranked share list (byAgent/byModel): name + tokens + a thin track bar
 * scaled to the top row, sub-line with requests and in/out split. Top 8 rows,
 * like the web.
 */
@Composable
internal fun UsageBarList(rows: List<UsageSummaryBucket>) {
    if (rows.isEmpty()) {
        EmptyHint()
        return
    }
    val maxTokens = max(rows.first().totalTokens, 1L)
    Column(modifier = Modifier.padding(horizontal = 16.dp, vertical = 8.dp)) {
        rows.take(MAX_BUCKET_ROWS).forEach { row ->
            Column(modifier = Modifier.padding(vertical = 6.dp)) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text(
                        text = row.key,
                        style = MaterialTheme.typography.bodyMedium,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                        modifier = Modifier.weight(1f),
                    )
                    Text(
                        text = UsageMath.formatTokens(row.totalTokens),
                        style = MaterialTheme.typography.bodyMedium,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        modifier = Modifier.padding(start = 12.dp),
                    )
                }
                ShareTrack(fraction = row.totalTokens.toFloat() / maxTokens)
                Text(
                    text = stringResource(
                        R.string.settings_usage_bucket_details,
                        row.requests,
                        UsageMath.formatTokens(row.inputTokens),
                        UsageMath.formatTokens(row.outputTokens),
                    ),
                    style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    modifier = Modifier.padding(top = 4.dp),
                )
            }
        }
    }
}

/** Thin rounded share bar (web 6px track twin); min 2% so tiny rows register. */
@Composable
private fun ShareTrack(fraction: Float) {
    Box(
        modifier = Modifier
            .fillMaxWidth()
            .padding(top = 6.dp)
            .height(6.dp)
            .background(MaterialTheme.colorScheme.surfaceContainerHighest, RoundedCornerShape(3.dp)),
    ) {
        Box(
            modifier = Modifier
                .fillMaxWidth(fraction.coerceIn(0.02f, 1f))
                .height(6.dp)
                .background(MaterialTheme.colorScheme.primary, RoundedCornerShape(3.dp)),
        )
    }
}

private const val MAX_BUCKET_ROWS = 8
