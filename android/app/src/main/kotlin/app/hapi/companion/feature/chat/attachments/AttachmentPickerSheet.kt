package app.hapi.companion.feature.chat.attachments

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.tooling.preview.Preview
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import app.hapi.companion.R
import app.hapi.companion.ui.theme.HapiTheme
import app.hapi.companion.ui.theme.hapi

/**
 * The composer "+" sheet (B-M3f): attachment sources. The launchers (photo
 * picker / TakePicture / OpenDocument) live in the screen — this is pure
 * chrome. A fourth "paste from clipboard" row (paste-to-attach) renders only
 * when the caller passes both [clipboardLabel] and [onPasteFromClipboard].
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun AttachmentPickerSheet(
    onDismiss: () -> Unit,
    onPickPhotos: () -> Unit,
    onTakePhoto: () -> Unit,
    onPickFiles: () -> Unit,
    /** Clip label/mime for the clipboard row; non-null (with the callback) shows it. */
    clipboardLabel: String? = null,
    onPasteFromClipboard: (() -> Unit)? = null,
) {
    ModalBottomSheet(onDismissRequest = onDismiss) {
        Column(modifier = Modifier.padding(bottom = 20.dp)) {
            Text(
                text = stringResource(R.string.chat_picker_title),
                style = MaterialTheme.typography.titleSmall,
                color = MaterialTheme.hapi.hint,
                modifier = Modifier.padding(horizontal = 20.dp, vertical = 6.dp),
            )
            PickerRow(glyph = "🖼", label = stringResource(R.string.chat_picker_photos), onClick = { onDismiss(); onPickPhotos() })
            PickerRow(glyph = "📷", label = stringResource(R.string.chat_picker_camera), onClick = { onDismiss(); onTakePhoto() })
            PickerRow(glyph = "📄", label = stringResource(R.string.chat_picker_files), onClick = { onDismiss(); onPickFiles() })
            if (clipboardLabel != null && onPasteFromClipboard != null) {
                PickerRow(
                    glyph = "📋",
                    label = stringResource(R.string.chat_picker_clipboard),
                    detail = clipboardLabel,
                    onClick = { onDismiss(); onPasteFromClipboard() },
                )
            }
        }
    }
}

@Composable
private fun PickerRow(glyph: String, label: String, onClick: () -> Unit, detail: String? = null) {
    Row(
        verticalAlignment = Alignment.CenterVertically,
        modifier = Modifier
            .fillMaxWidth()
            .clickable(onClick = onClick)
            .padding(horizontal = 20.dp, vertical = 14.dp),
    ) {
        Text(text = glyph, fontSize = 20.sp)
        Spacer(modifier = Modifier.width(16.dp))
        Column(modifier = Modifier.weight(1f)) {
            Text(text = label, style = MaterialTheme.typography.bodyLarge)
            // Secondary line for the clipboard row (clip label / mime).
            detail?.let {
                Text(
                    text = it,
                    style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.hapi.hint,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
            }
        }
    }
}

@Preview(showBackground = true)
@Composable
private fun AttachmentPickerRowsPreview() {
    HapiTheme {
        Surface {
            Column {
                PickerRow(glyph = "🖼", label = "Photo library", onClick = {})
                PickerRow(glyph = "📷", label = "Camera", onClick = {})
                PickerRow(glyph = "📄", label = "Files", onClick = {})
                PickerRow(glyph = "📋", label = "Paste from clipboard", detail = "image/png", onClick = {})
            }
        }
    }
}
