package app.hapi.companion.feature.chat.attachments

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.tooling.preview.Preview
import androidx.compose.ui.unit.dp
import app.hapi.companion.R
import app.hapi.companion.ui.components.HapiCameraGlyph
import app.hapi.companion.ui.components.HapiDocGlyph
import app.hapi.companion.ui.components.HapiImageGlyph
import app.hapi.companion.ui.theme.HapiTheme
import app.hapi.companion.ui.theme.hapi

/**
 * The composer "+" sheet (B-M3f): three attachment sources. The launchers
 * (photo picker / TakePicture / OpenDocument) live in the screen — this is
 * pure chrome.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun AttachmentPickerSheet(
    onDismiss: () -> Unit,
    onPickPhotos: () -> Unit,
    onTakePhoto: () -> Unit,
    onPickFiles: () -> Unit,
) {
    ModalBottomSheet(onDismissRequest = onDismiss) {
        Column(modifier = Modifier.padding(bottom = 20.dp)) {
            Text(
                text = stringResource(R.string.chat_picker_title),
                style = MaterialTheme.typography.titleSmall,
                color = MaterialTheme.hapi.hint,
                modifier = Modifier.padding(horizontal = 20.dp, vertical = 6.dp),
            )
            PickerRow(icon = HapiImageGlyph, label = stringResource(R.string.chat_picker_photos), onClick = { onDismiss(); onPickPhotos() })
            PickerRow(icon = HapiCameraGlyph, label = stringResource(R.string.chat_picker_camera), onClick = { onDismiss(); onTakePhoto() })
            PickerRow(icon = HapiDocGlyph, label = stringResource(R.string.chat_picker_files), onClick = { onDismiss(); onPickFiles() })
        }
    }
}

@Composable
private fun PickerRow(icon: ImageVector, label: String, onClick: () -> Unit) {
    Row(
        verticalAlignment = Alignment.CenterVertically,
        modifier = Modifier
            .fillMaxWidth()
            .clickable(onClick = onClick)
            .padding(horizontal = 20.dp, vertical = 14.dp),
    ) {
        Icon(
            imageVector = icon,
            contentDescription = null,
            tint = MaterialTheme.colorScheme.onSurfaceVariant,
            modifier = Modifier.size(22.dp),
        )
        Spacer(modifier = Modifier.width(16.dp))
        Text(text = label, style = MaterialTheme.typography.bodyLarge)
    }
}

@Preview(showBackground = true)
@Composable
private fun AttachmentPickerRowsPreview() {
    HapiTheme {
        Surface {
            Column {
                PickerRow(icon = HapiImageGlyph, label = "Photo library", onClick = {})
                PickerRow(icon = HapiCameraGlyph, label = "Camera", onClick = {})
                PickerRow(icon = HapiDocGlyph, label = "Files", onClick = {})
            }
        }
    }
}
