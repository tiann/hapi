package app.hapi.companion.feature.chat

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.rotate
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import app.hapi.companion.R
import app.hapi.companion.ui.theme.hapi
import app.hapi.protocol.chat.SessionStatusData
import app.hapi.protocol.chat.SessionStatusSubagent
import app.hapi.protocol.chat.SessionSubagentState
import app.hapi.protocol.chat.ThreadGoalStatus
import app.hapi.protocol.chat.elapsedSince
import app.hapi.protocol.chat.formatCompactDuration
import kotlinx.coroutines.delay

/** Live-state tone for still-running rows (emerald in the shared palette). */
private val RunningTone = androidx.compose.ui.graphics.Color(0xFF059669)

/** Live-state tone for rows blocked on someone else (amber in the shared palette). */
private val WaitingTone = androidx.compose.ui.graphics.Color(0xFFD97706)

/** Two columns once the panel is at least this wide (phone portrait stays single-column). */
private val TwoColumnMinWidth = 640.dp

/** Scroll cap for the expanded body: half the screen, never more than 24rem. */
private val BodyMaxHeight = 384.dp

/**
 * Collapsible summary of what the session is doing right now: thread goal,
 * todo snapshot, in-flight subagents and background terminals. Collapsed by
 * default; expands in place above the transcript. The clock only ticks while
 * at least one row is still moving.
 */
@Composable
internal fun SessionStatusPanel(
    status: SessionStatusData,
    modifier: Modifier = Modifier,
) {
    var expanded by rememberSaveable { mutableStateOf(false) }
    val nowMs = rememberNowMillis(status.hasLiveElapsed)

    Surface(
        modifier = modifier
            .fillMaxWidth()
            .padding(horizontal = 12.dp, vertical = 6.dp),
        shape = RoundedCornerShape(10.dp),
        color = MaterialTheme.colorScheme.surfaceContainerHigh,
        border = BorderStroke(1.dp, MaterialTheme.hapi.divider),
    ) {
        Column {
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .clickable { expanded = !expanded }
                    .padding(horizontal = 12.dp, vertical = 10.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Text(
                    text = stringResource(R.string.session_status_title),
                    style = MaterialTheme.typography.labelLarge,
                    color = MaterialTheme.colorScheme.onSurface,
                )
                Text(
                    text = "▼",
                    style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.hapi.hint,
                    modifier = Modifier
                        .padding(start = 8.dp)
                        .rotate(if (expanded) 180f else 0f),
                )
            }
            if (expanded) {
                HorizontalDivider(color = MaterialTheme.hapi.divider)
                StatusSections(status = status, nowMs = nowMs)
            }
        }
    }
}

/**
 * One-second clock shared by every elapsed label; stands still (and costs
 * nothing) while no row is live.
 */
@Composable
private fun rememberNowMillis(hasLiveElapsed: Boolean): Long {
    var nowMs by remember { mutableLongStateOf(System.currentTimeMillis()) }
    if (hasLiveElapsed) {
        LaunchedEffect(Unit) {
            while (true) {
                delay(1000)
                nowMs = System.currentTimeMillis()
            }
        }
    }
    return nowMs
}

private enum class StatusSectionKind { GOAL, TASKS, SUBAGENTS, TERMINALS }

@Composable
private fun StatusSections(status: SessionStatusData, nowMs: Long) {
    val sections = listOfNotNull(
        StatusSectionKind.GOAL.takeIf { status.goal != null },
        StatusSectionKind.TASKS.takeIf { status.tasks.isNotEmpty() },
        StatusSectionKind.SUBAGENTS.takeIf { status.subagents.isNotEmpty() },
        StatusSectionKind.TERMINALS.takeIf {
            status.terminals.isNotEmpty() || status.undiscoveredTerminalCount > 0
        },
    )
    val halfScreen = LocalConfiguration.current.screenHeightDp.dp * 0.5f

    BoxWithConstraints(
        modifier = Modifier
            .heightIn(max = minOf(halfScreen, BodyMaxHeight))
            .verticalScroll(rememberScrollState()),
    ) {
        val rows: List<List<StatusSectionKind>> = if (maxWidth >= TwoColumnMinWidth) {
            sections.chunked(2)
        } else {
            sections.map { listOf(it) }
        }
        Column(
            modifier = Modifier.padding(horizontal = 12.dp, vertical = 10.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            rows.forEach { row ->
                Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                    row.forEach { kind ->
                        Box(modifier = Modifier.weight(1f)) {
                            SectionContent(kind = kind, status = status, nowMs = nowMs)
                        }
                    }
                    // A lone trailing section still spans only its half, like
                    // the last cell of a flowing grid.
                    if (row.size == 1 && sections.size > 1) {
                        Box(modifier = Modifier.weight(1f))
                    }
                }
            }
        }
    }
}

@Composable
private fun SectionContent(kind: StatusSectionKind, status: SessionStatusData, nowMs: Long) {
    when (kind) {
        StatusSectionKind.GOAL -> status.goal?.let { goal ->
            Section(title = stringResource(R.string.session_status_goal)) {
                Text(
                    text = goal.objective,
                    style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.onSurface,
                )
                val used = if (goal.timeUsedSeconds > 0) {
                    " · " + formatCompactDuration(goal.timeUsedSeconds * 1000)
                } else {
                    ""
                }
                Text(
                    text = goalStatusLabel(goal.status) + used,
                    style = MaterialTheme.typography.labelMedium,
                    color = MaterialTheme.hapi.hint,
                    modifier = Modifier.padding(top = 2.dp),
                )
            }
        }

        StatusSectionKind.TASKS -> Section(
            title = stringResource(R.string.session_status_tasks) +
                " · ${status.tasks.count { it.status == "completed" }}/${status.tasks.size}",
        ) {
            Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
                status.tasks.forEach { task ->
                    TaskRow(text = task.content, status = task.status)
                }
            }
        }

        StatusSectionKind.SUBAGENTS -> Section(title = stringResource(R.string.session_status_subagents)) {
            Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                status.subagents.forEach { subagent ->
                    SubagentRow(subagent = subagent, nowMs = nowMs)
                }
            }
        }

        StatusSectionKind.TERMINALS -> Section(title = stringResource(R.string.session_status_terminals)) {
            Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                status.terminals.forEach { terminal ->
                    TerminalRow(
                        command = terminal.command,
                        secondLine = listOfNotNull(
                            terminal.cwd,
                            elapsedSince(terminal.startedAt, nowMs),
                        ).joinToString(" · "),
                    )
                }
                if (status.undiscoveredTerminalCount > 0) {
                    Text(
                        text = stringResource(
                            R.string.session_status_terminals_unavailable,
                            status.undiscoveredTerminalCount,
                        ),
                        style = MaterialTheme.typography.labelMedium,
                        color = MaterialTheme.hapi.hint,
                    )
                    if (status.possibleTerminalCommands.isNotEmpty()) {
                        Column {
                            Text(
                                text = stringResource(R.string.session_status_terminals_possible),
                                style = MaterialTheme.typography.labelSmall,
                                color = MaterialTheme.hapi.hint,
                            )
                            status.possibleTerminalCommands.forEach { command ->
                                Text(
                                    text = command,
                                    style = MaterialTheme.typography.labelSmall,
                                    fontFamily = FontFamily.Monospace,
                                    color = MaterialTheme.colorScheme.onSurface,
                                    maxLines = 1,
                                    overflow = TextOverflow.Ellipsis,
                                )
                            }
                        }
                    }
                }
            }
        }
    }
}

/** Localized goal status label; unknown statuses fall back to the raw value. */
@Composable
private fun goalStatusLabel(status: String): String = when (status) {
    ThreadGoalStatus.ACTIVE -> stringResource(R.string.session_status_goal_active)
    ThreadGoalStatus.PAUSED -> stringResource(R.string.session_status_goal_paused)
    ThreadGoalStatus.BUDGET_LIMITED -> stringResource(R.string.session_status_goal_budget_limited)
    ThreadGoalStatus.USAGE_LIMITED -> stringResource(R.string.session_status_goal_usage_limited)
    ThreadGoalStatus.BLOCKED -> stringResource(R.string.session_status_goal_blocked)
    ThreadGoalStatus.COMPLETE -> stringResource(R.string.session_status_goal_complete)
    else -> status
}

@Composable
private fun Section(title: String, content: @Composable () -> Unit) {
    Column {
        Text(
            text = title,
            style = MaterialTheme.typography.labelSmall,
            color = MaterialTheme.hapi.hint,
        )
        Column(modifier = Modifier.padding(top = 4.dp)) {
            content()
        }
    }
}

@Composable
private fun TaskRow(text: String, status: String) {
    val completed = status == "completed"
    val inProgress = status == "in_progress"
    val tone = when {
        completed -> RunningTone
        inProgress -> MaterialTheme.hapi.link
        else -> MaterialTheme.hapi.hint
    }
    val glyph = when {
        completed -> "☑"
        inProgress -> "◉"
        else -> "☐"
    }
    val trimmed = text.trim()
    Row {
        Text(glyph, style = MaterialTheme.typography.bodyMedium, color = tone)
        Text(
            text = trimmed.ifEmpty { stringResource(R.string.session_status_task_empty) },
            style = MaterialTheme.typography.bodyMedium,
            color = tone,
            textDecoration = if (completed) TextDecoration.LineThrough else null,
            modifier = Modifier.padding(start = 6.dp),
        )
    }
}

@Composable
private fun SubagentRow(subagent: SessionStatusSubagent, nowMs: Long) {
    val tone = when (subagent.state) {
        SessionSubagentState.ERROR -> MaterialTheme.colorScheme.error
        SessionSubagentState.WAITING -> WaitingTone
        else -> RunningTone
    }
    val label = when (subagent.state) {
        SessionSubagentState.ERROR -> stringResource(R.string.session_status_subagent_error)
        SessionSubagentState.WAITING -> stringResource(R.string.session_status_subagent_waiting)
        else -> stringResource(R.string.session_status_subagent_running)
    }
    val elapsed = elapsedSince(subagent.startedAt, subagent.endedAt ?: nowMs)
    Column {
        Row(verticalAlignment = Alignment.Top) {
            Text("●", style = MaterialTheme.typography.labelSmall, color = tone)
            Text(
                text = subagent.title,
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurface,
                modifier = Modifier
                    .weight(1f)
                    .padding(start = 6.dp),
            )
            Text(
                text = label + (elapsed?.let { " · $it" } ?: ""),
                style = MaterialTheme.typography.labelMedium,
                color = tone,
                modifier = Modifier.padding(start = 8.dp),
            )
        }
        subagent.detail?.let { detail ->
            Text(
                text = detail,
                style = MaterialTheme.typography.labelMedium,
                color = MaterialTheme.hapi.hint,
                modifier = Modifier.padding(start = 14.dp, top = 1.dp),
            )
        }
    }
}

@Composable
private fun TerminalRow(command: String, secondLine: String?) {
    Column {
        Text(
            text = command,
            style = MaterialTheme.typography.labelMedium,
            fontFamily = FontFamily.Monospace,
            color = MaterialTheme.colorScheme.onSurface,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
        )
        if (secondLine != null && secondLine.isNotEmpty()) {
            Text(
                text = secondLine,
                style = MaterialTheme.typography.labelSmall,
                color = MaterialTheme.hapi.hint,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
        }
    }
}
