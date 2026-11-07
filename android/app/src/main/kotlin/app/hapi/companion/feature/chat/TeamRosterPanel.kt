package app.hapi.companion.feature.chat

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
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
import androidx.compose.ui.draw.rotate
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.dp
import app.hapi.companion.R
import app.hapi.companion.ui.theme.hapi
import app.hapi.protocol.chat.TeamMemberDot
import app.hapi.protocol.chat.TeamRosterModel
import app.hapi.protocol.chat.TeamTaskMark
import app.hapi.protocol.chat.rosterDot
import app.hapi.protocol.chat.rosterMark

/** Tone for a member that is currently working (emerald in the shared palette). */
private val ActiveMemberTone = Color(0xFF10B981)

/** Tone for a completed task row (emerald in the shared palette). */
private val CompletedTaskTone = Color(0xFF059669)

/** Dot size for a member chip status indicator. */
private val MemberDotSize = 6.dp

/**
 * Collapsible roster of the session's subagent team: members with live
 * status, tracked tasks with progress, and the most recent member-to-member
 * messages. Mounted only while the session carries team state; collapsed by
 * default, expands in place above the transcript.
 */
@Composable
internal fun TeamRosterPanel(
    roster: TeamRosterModel,
    modifier: Modifier = Modifier,
) {
    var expanded by rememberSaveable { mutableStateOf(false) }

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
                    text = stringResource(R.string.team_roster_title, roster.teamName),
                    style = MaterialTheme.typography.labelLarge,
                    color = MaterialTheme.colorScheme.onSurface,
                )
                Text(
                    text = rosterCountsLine(roster),
                    style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.hapi.hint,
                    modifier = Modifier
                        .weight(1f)
                        .padding(start = 8.dp),
                )
                Text(
                    text = "▼",
                    style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.hapi.hint,
                    modifier = Modifier.rotate(if (expanded) 180f else 0f),
                )
            }
            if (expanded) {
                HorizontalDivider(color = MaterialTheme.hapi.divider)
                RosterBody(roster = roster)
            }
        }
    }
}

/** "N members (M active) · done/total tasks" summary for the collapsed header. */
@Composable
private fun rosterCountsLine(roster: TeamRosterModel): String = buildString {
    append(
        stringResource(
            if (roster.usesSingularMemberNoun) R.string.team_roster_members_one
            else R.string.team_roster_members_many,
            roster.members.size,
        )
    )
    if (roster.showsActiveMembers) {
        append(" ")
        append(stringResource(R.string.team_roster_active_members, roster.activeMemberCount))
    }
    if (roster.showsTaskProgress) {
        append(" · ")
        append(
            stringResource(
                R.string.team_roster_task_progress,
                roster.completedTaskCount,
                roster.tasks.size,
            )
        )
    }
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun RosterBody(roster: TeamRosterModel) {
    Column(
        modifier = Modifier.padding(horizontal = 12.dp, vertical = 10.dp),
        verticalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        roster.description?.let { description ->
            Text(
                text = description,
                style = MaterialTheme.typography.labelMedium,
                color = MaterialTheme.hapi.hint,
            )
        }
        if (roster.members.isNotEmpty()) {
            RosterSection(title = stringResource(R.string.team_roster_members_section)) {
                FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                    roster.members.forEach { member ->
                        MemberChip(
                            name = member.name,
                            agentType = member.agentType,
                            dot = member.rosterDot(),
                        )
                    }
                }
            }
        }
        if (roster.tasks.isNotEmpty()) {
            RosterSection(title = stringResource(R.string.team_roster_tasks_section)) {
                Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
                    roster.tasks.forEach { task ->
                        TaskRow(
                            title = task.title,
                            owner = task.owner,
                            mark = task.rosterMark(),
                        )
                    }
                }
            }
        }
        if (roster.recentMessages.isNotEmpty()) {
            RosterSection(title = stringResource(R.string.team_roster_messages_section)) {
                Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
                    roster.recentMessages.forEach { message ->
                        MessageRow(from = message.from, to = message.to, summary = message.summary)
                    }
                }
            }
        }
    }
}

@Composable
private fun RosterSection(title: String, content: @Composable () -> Unit) {
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

/** Pill with a status dot, the member name and its optional agent type. */
@Composable
private fun MemberChip(name: String, agentType: String?, dot: TeamMemberDot) {
    val dotColor = when (dot) {
        TeamMemberDot.ACTIVE -> ActiveMemberTone
        TeamMemberDot.SHUTDOWN -> MaterialTheme.colorScheme.error
        TeamMemberDot.NEUTRAL -> MaterialTheme.hapi.hint
    }
    Surface(
        shape = RoundedCornerShape(50),
        color = MaterialTheme.colorScheme.surfaceContainerHighest,
    ) {
        Row(
            modifier = Modifier.padding(horizontal = 8.dp, vertical = 3.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(4.dp),
        ) {
            Box(
                modifier = Modifier
                    .size(MemberDotSize)
                    .background(dotColor, CircleShape),
            )
            Text(
                text = name,
                style = MaterialTheme.typography.labelMedium,
                color = MaterialTheme.colorScheme.onSurface,
            )
            agentType?.let { type ->
                Text(
                    text = "($type)",
                    style = MaterialTheme.typography.labelMedium,
                    color = MaterialTheme.hapi.hint,
                )
            }
        }
    }
}

/** One tracked task: status glyph + title in the status tone, owner as suffix. */
@Composable
private fun TaskRow(title: String, owner: String?, mark: TeamTaskMark) {
    val tone = when (mark) {
        TeamTaskMark.COMPLETED -> CompletedTaskTone
        TeamTaskMark.IN_PROGRESS -> MaterialTheme.hapi.link
        TeamTaskMark.BLOCKED -> MaterialTheme.colorScheme.error
        TeamTaskMark.PENDING -> MaterialTheme.hapi.hint
    }
    val glyph = when (mark) {
        TeamTaskMark.COMPLETED -> "☑"
        TeamTaskMark.IN_PROGRESS -> "▶"
        TeamTaskMark.BLOCKED -> "⚠"
        TeamTaskMark.PENDING -> "☐"
    }
    val text = buildAnnotatedString {
        append(glyph)
        append(" ")
        append(title)
        owner?.let {
            withStyle(SpanStyle(color = MaterialTheme.hapi.hint)) {
                append(" [$it]")
            }
        }
    }
    Text(
        text = text,
        style = MaterialTheme.typography.labelMedium,
        color = tone,
    )
}

/** One member-to-member message: sender and recipient emphasized, body dimmed. */
@Composable
private fun MessageRow(from: String, to: String, summary: String) {
    val fg = MaterialTheme.colorScheme.onSurface
    val text = buildAnnotatedString {
        withStyle(SpanStyle(color = fg)) { append(from) }
        append(" → ")
        withStyle(SpanStyle(color = fg)) { append(to) }
        append(": ")
        append(summary)
    }
    Text(
        text = text,
        style = MaterialTheme.typography.labelSmall,
        color = MaterialTheme.hapi.hint,
    )
}
