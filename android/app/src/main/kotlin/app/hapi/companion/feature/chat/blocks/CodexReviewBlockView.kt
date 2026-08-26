package app.hapi.companion.feature.chat.blocks

import androidx.compose.animation.animateContentSize
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.tooling.preview.Preview
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import app.hapi.companion.R
import app.hapi.companion.ui.markdown.Markdown
import app.hapi.companion.ui.theme.HapiTheme
import app.hapi.companion.ui.theme.hapi
import app.hapi.protocol.chat.CodexReview
import app.hapi.protocol.chat.CodexReviewBlock
import app.hapi.protocol.chat.CodexReviewFinding
import kotlin.math.roundToInt

/**
 * Codex `/review` verdict card (web `CodexReviewCard`): header with the
 * overall-correctness badge (+ confidence), the explanation as markdown, and
 * the findings list collapsed behind a count row.
 */
@Composable
fun CodexReviewBlockView(block: CodexReviewBlock, modifier: Modifier = Modifier) {
    val review = block.review
    val colors = MaterialTheme.hapi
    var findingsOpen by rememberSaveable(block.id) { mutableStateOf(false) }

    Surface(
        shape = RoundedCornerShape(12.dp),
        color = MaterialTheme.colorScheme.surfaceContainerLow,
        modifier = modifier.fillMaxWidth().animateContentSize(),
    ) {
        Column {
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(horizontal = 12.dp, vertical = 10.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Text(
                    text = stringResource(R.string.chat_review_title),
                    style = MaterialTheme.typography.titleSmall,
                    modifier = Modifier.weight(1f),
                )
                review.overallCorrectness?.let { verdict ->
                    VerdictBadge(verdict)
                }
                formatPercent(review.overallConfidenceScore)?.let { confidence ->
                    Spacer(modifier = Modifier.width(6.dp))
                    Text(
                        text = confidence,
                        style = MaterialTheme.typography.labelSmall,
                        color = colors.hint,
                    )
                }
            }
            review.overallExplanation?.takeIf { it.isNotBlank() }?.let { explanation ->
                HorizontalDivider(color = colors.divider)
                Markdown(
                    text = explanation,
                    modifier = Modifier.padding(horizontal = 12.dp, vertical = 8.dp),
                )
            }
            if (review.findings.isNotEmpty()) {
                HorizontalDivider(color = colors.divider)
                val findingsLabel = if (review.findings.size == 1) {
                    stringResource(R.string.chat_review_findings_one)
                } else {
                    stringResource(R.string.chat_review_findings_many, review.findings.size)
                }
                Text(
                    text = (if (findingsOpen) "▾ " else "▸ ") + findingsLabel,
                    style = MaterialTheme.typography.labelLarge,
                    modifier = Modifier
                        .fillMaxWidth()
                        .clickable { findingsOpen = !findingsOpen }
                        .padding(horizontal = 12.dp, vertical = 8.dp),
                )
                if (findingsOpen) {
                    Column(
                        modifier = Modifier.padding(start = 12.dp, end = 12.dp, bottom = 12.dp),
                        verticalArrangement = Arrangement.spacedBy(8.dp),
                    ) {
                        review.findings.forEach { FindingRow(it) }
                    }
                }
            }
        }
    }
}

@Composable
private fun VerdictBadge(verdict: String) {
    val (container, content) = when {
        verdict.contains("incorrect", ignoreCase = true) ->
            MaterialTheme.colorScheme.errorContainer to MaterialTheme.colorScheme.onErrorContainer
        verdict.contains("correct", ignoreCase = true) ->
            Color(0xFF34C759).copy(alpha = 0.18f) to MaterialTheme.colorScheme.onSurface
        else ->
            MaterialTheme.colorScheme.surfaceContainerHigh to MaterialTheme.colorScheme.onSurfaceVariant
    }
    Text(
        text = verdict,
        style = MaterialTheme.typography.labelSmall,
        color = content,
        modifier = Modifier
            .clip(RoundedCornerShape(6.dp))
            .background(container)
            .padding(horizontal = 6.dp, vertical = 2.dp),
    )
}

@Composable
private fun FindingRow(finding: CodexReviewFinding) {
    val colors = MaterialTheme.hapi
    Surface(
        shape = RoundedCornerShape(8.dp),
        color = MaterialTheme.colorScheme.surface,
        modifier = Modifier.fillMaxWidth(),
    ) {
        Column(modifier = Modifier.padding(10.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                finding.priority?.let { priority ->
                    val p = priority.roundToInt()
                    Text(
                        text = "P$p",
                        style = MaterialTheme.typography.labelSmall,
                        fontWeight = FontWeight.SemiBold,
                        color = if (p <= 1) MaterialTheme.colorScheme.onErrorContainer
                        else MaterialTheme.colorScheme.onSurfaceVariant,
                        modifier = Modifier
                            .clip(RoundedCornerShape(4.dp))
                            .background(
                                if (p <= 1) MaterialTheme.colorScheme.errorContainer
                                else MaterialTheme.colorScheme.surfaceContainerHigh,
                            )
                            .padding(horizontal = 4.dp, vertical = 1.dp),
                    )
                    Spacer(modifier = Modifier.width(6.dp))
                }
                Text(
                    text = finding.title,
                    style = MaterialTheme.typography.bodyMedium,
                    fontWeight = FontWeight.SemiBold,
                )
            }
            Text(
                text = finding.body,
                style = MaterialTheme.typography.bodySmall,
                modifier = Modifier.padding(top = 4.dp),
            )
            formatLocation(finding)?.let { location ->
                Text(
                    text = location,
                    style = MaterialTheme.typography.labelSmall.copy(fontFamily = FontFamily.Monospace, fontSize = 10.sp),
                    color = colors.hint,
                    modifier = Modifier.padding(top = 4.dp),
                )
            }
        }
    }
}

private fun formatPercent(value: Double?): String? {
    if (value == null || !value.isFinite()) return null
    return "${(value * 100).roundToInt()}%"
}

private fun formatLocation(finding: CodexReviewFinding): String? {
    val filePath = finding.filePath ?: return null
    val start = finding.lineStart?.roundToInt() ?: return filePath
    val end = finding.lineEnd?.roundToInt()
    return if (end != null && end != start) "$filePath:$start-$end" else "$filePath:$start"
}

@Preview(showBackground = true)
@Composable
private fun CodexReviewBlockPreview() {
    HapiTheme {
        Surface {
            CodexReviewBlockView(
                CodexReviewBlock(
                    id = "cr1",
                    localId = null,
                    createdAt = 0,
                    invokedAt = null,
                    review = CodexReview(
                        findings = listOf(
                            CodexReviewFinding(
                                title = "Cursor pair can split",
                                body = "beforeSeq is sent without beforeAt when the snapshot is stale.",
                                priority = 1.0,
                                confidenceScore = 0.9,
                                filePath = "web/src/lib/message-window-store.ts",
                                lineStart = 210.0,
                                lineEnd = 218.0,
                            ),
                        ),
                        overallCorrectness = "patch is incorrect",
                        overallExplanation = "One blocking issue in the pagination cursor handling.",
                        overallConfidenceScore = 0.82,
                    ),
                    meta = null,
                ),
                modifier = Modifier.padding(12.dp),
            )
        }
    }
}
