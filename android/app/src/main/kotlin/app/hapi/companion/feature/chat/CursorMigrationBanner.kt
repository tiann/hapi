package app.hapi.companion.feature.chat

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import app.hapi.companion.R

/**
 * CursorMigrationBanner — port of `web/src/components/CursorMigrationBanner.tsx`.
 *
 * Surfaces the in-progress automatic legacy-stream-json → ACP migration, so
 * the 15-20s "dark wait" while the migrator transplants the store.db,
 * replays notifications and tears down the verify probe doesn't read as
 * "broken / nothing is happening". Deliberately minimal — no fake progress
 * bar (there is no phase data; a fake percentage would lie), just an
 * indeterminate spinner + a short explanation.
 *
 * tiann/hapi#873: `'ambiguous'` means the migrator refused to transplant the
 * legacy store (duplicate workspace drawers or a size sanity mismatch) — the
 * banner switches to a "manual review needed" surface instead of silently
 * disappearing.
 */
enum class CursorMigrationBannerState {
    /** `cursorMigrationState === 'in_progress'` — spinner + upgrading copy. */
    InProgress,

    /** `cursorMigrationState === 'ambiguous'` — manual-review copy (#873). */
    Ambiguous,
}

/**
 * Maps `metadata.cursorMigrationState` to the banner state. Absent, cleared
 * and unknown-future values all map to null (no banner) — the hub clears the
 * flag in the same metadata write that flips `cursorSessionProtocol`, so the
 * banner disappears in the same SSE patch that re-renders the chat as ACP.
 */
fun cursorMigrationBannerState(cursorMigrationState: String?): CursorMigrationBannerState? =
    when (cursorMigrationState) {
        "in_progress" -> CursorMigrationBannerState.InProgress
        "ambiguous" -> CursorMigrationBannerState.Ambiguous
        else -> null
    }

/**
 * Mount level per the web truth (`SessionChat.tsx`): inside the content
 * column, above the thread, below the header — never blocking the composer,
 * gone the moment the flag clears.
 */
@Composable
fun CursorMigrationBanner(state: CursorMigrationBannerState) {
    Surface(
        color = MaterialTheme.colorScheme.surfaceContainerHigh,
        contentColor = MaterialTheme.colorScheme.onSurfaceVariant,
        border = BorderStroke(1.dp, MaterialTheme.colorScheme.outlineVariant),
        shape = MaterialTheme.shapes.medium,
        modifier = Modifier
            .fillMaxWidth()
            .padding(horizontal = 12.dp, vertical = 4.dp),
    ) {
        Row(
            verticalAlignment = Alignment.Top,
            modifier = Modifier.padding(12.dp),
        ) {
            if (state == CursorMigrationBannerState.InProgress) {
                CircularProgressIndicator(
                    strokeWidth = 2.dp,
                    modifier = Modifier.size(16.dp),
                )
            } else {
                Surface(
                    color = MaterialTheme.colorScheme.errorContainer,
                    contentColor = MaterialTheme.colorScheme.onErrorContainer,
                    shape = MaterialTheme.shapes.small,
                    modifier = Modifier.size(16.dp),
                ) {
                    Text(
                        text = "!",
                        style = MaterialTheme.typography.labelSmall,
                        maxLines = 1,
                        modifier = Modifier.padding(horizontal = 4.dp),
                    )
                }
            }
            Spacer(modifier = Modifier.size(12.dp))
            Column {
                Text(
                    text = stringResource(
                        if (state == CursorMigrationBannerState.InProgress) {
                            R.string.chat_cursor_migration_title
                        } else {
                            R.string.chat_cursor_migration_ambiguous_title
                        },
                    ),
                    style = MaterialTheme.typography.labelLarge,
                    color = MaterialTheme.colorScheme.onSurface,
                )
                Text(
                    text = stringResource(
                        if (state == CursorMigrationBannerState.InProgress) {
                            R.string.chat_cursor_migration_body
                        } else {
                            R.string.chat_cursor_migration_ambiguous_body
                        },
                    ),
                    style = MaterialTheme.typography.bodySmall,
                )
            }
        }
    }
}
