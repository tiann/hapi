package app.hapi.companion.ui.components

import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Icon
import androidx.compose.material3.LocalContentColor
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.tooling.preview.Preview
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import app.hapi.companion.R
import app.hapi.companion.ui.theme.HapiTheme
import app.hapi.companion.ui.theme.hapi

/**
 * Brand logo per agent flavor — port of `web/src/components/AgentFlavorIcon.tsx`
 * (brand SVGs via @lobehub/icons, the same source the web ships).
 *
 * Color variants (agy/claude/codex/gemini) keep their literal brand fills and
 * render untinted so they stay visible on both light and dark surfaces — the
 * reason the web picked Color for them. Mono variants (cursor/grok/kimi/
 * opencode/pi) are currentColor upstream and tint with [LocalContentColor];
 * copilot mirrors the web's fixed GitHub-mark tint (#24292F light /
 * #E6EDF3 dark). Unknown flavors fall back to the web's "Un" badge.
 */
@Composable
fun AgentFlavorIcon(flavor: String?, modifier: Modifier = Modifier.size(16.dp)) {
    when (val normalized = flavor?.trim()?.lowercase().orEmpty()) {
        in COLOR_FLAVOR_ICONS -> Image(
            painter = painterResource(COLOR_FLAVOR_ICONS.getValue(normalized)),
            contentDescription = null,
            modifier = modifier,
        )

        in MONO_FLAVOR_ICONS -> Icon(
            painter = painterResource(MONO_FLAVOR_ICONS.getValue(normalized)),
            contentDescription = null,
            modifier = modifier,
            tint = LocalContentColor.current,
        )

        "copilot" -> Icon(
            painter = painterResource(R.drawable.ic_agent_copilot),
            contentDescription = null,
            modifier = modifier,
            tint = if (MaterialTheme.hapi.isDark) Color(0xFFE6EDF3) else Color(0xFF24292F),
        )

        else -> Box(
            modifier = modifier.background(
                color = MaterialTheme.colorScheme.surfaceContainerHigh,
                shape = RoundedCornerShape(3.dp),
            ),
            contentAlignment = Alignment.Center,
        ) {
            Text(
                text = "Un",
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                fontSize = 8.sp,
                lineHeight = 8.sp,
                fontWeight = FontWeight.SemiBold,
                maxLines = 1,
                softWrap = false,
            )
        }
    }
}

private val COLOR_FLAVOR_ICONS: Map<String, Int> = mapOf(
    "agy" to R.drawable.ic_agent_agy,
    "claude" to R.drawable.ic_agent_claude,
    "codex" to R.drawable.ic_agent_codex,
    "gemini" to R.drawable.ic_agent_gemini,
)

private val MONO_FLAVOR_ICONS: Map<String, Int> = mapOf(
    "cursor" to R.drawable.ic_agent_cursor,
    "grok" to R.drawable.ic_agent_grok,
    "kimi" to R.drawable.ic_agent_kimi,
    "opencode" to R.drawable.ic_agent_opencode,
    "pi" to R.drawable.ic_agent_pi,
)

// -------------------------------------------------------------- preview --

@Composable
private fun AgentFlavorIconStrip() {
    Column(
        modifier = Modifier.padding(12.dp),
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        val flavors = listOf(
            "agy", "claude", "codex", "copilot", "cursor",
            "gemini", "grok", "kimi", "opencode", "pi", "mystery",
        )
        flavors.chunked(6).forEach { chunk ->
            Row(
                horizontalArrangement = Arrangement.spacedBy(10.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                chunk.forEach { flavor -> AgentFlavorIcon(flavor) }
            }
        }
    }
}

@Preview(showBackground = true, name = "Agent icons · light")
@Composable
private fun AgentFlavorIconPreviewLight() {
    HapiTheme(darkTheme = false, dynamicColor = false) {
        Surface { AgentFlavorIconStrip() }
    }
}

@Preview(showBackground = true, name = "Agent icons · dark")
@Composable
private fun AgentFlavorIconPreviewDark() {
    HapiTheme(darkTheme = true, dynamicColor = false) {
        Surface { AgentFlavorIconStrip() }
    }
}
