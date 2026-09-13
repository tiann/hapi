package app.hapi.companion.feature.chat

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import app.hapi.companion.R
import app.hapi.companion.ui.components.FullTextAction

/** One mounted text part, regardless of how many parts have been visited. */
@Composable
internal fun PagedTextContent(
    source: String,
    budget: TextBudget = MessagePageBudget,
    modifier: Modifier = Modifier,
    content: @Composable (String) -> Unit = { Text(it, modifier = Modifier.testTag("reader-text")) },
) {
    var starts by rememberSaveable { mutableStateOf(listOf(0)) }
    val start = starts.last().coerceAtMost(source.length)
    val page = remember(source, start, budget) { readTextPage(source, start, budget) }
    Column(modifier, verticalArrangement = Arrangement.spacedBy(8.dp)) {
        FullTextAction(source)
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
            TextButton(
                onClick = { starts = starts.dropLast(1) }, enabled = starts.size > 1,
                modifier = Modifier.weight(1f).heightIn(min = 48.dp).testTag("reader-previous"),
            ) { Text(stringResource(R.string.chat_previous_part)) }
            TextButton(onClick = {}, enabled = false, modifier = Modifier.weight(1f)) { Text(stringResource(R.string.chat_part_number, starts.size)) }
            TextButton(
                onClick = { starts = starts + page.end }, enabled = page.end < source.length,
                modifier = Modifier.weight(1f).heightIn(min = 48.dp).testTag("reader-next"),
            ) { Text(stringResource(R.string.chat_next_part)) }
        }
        SelectionContainer { content(page.text) }
    }
}
