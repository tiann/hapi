package app.hapi.companion.feature.terminal

import android.view.KeyEvent as AndroidKeyEvent
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.input.key.onPreviewKeyEvent
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

/**
 * The IME/hardware-key typing target shared by the terminal screen's Direct
 * mode and the chat-embedded agent PTY panel: everything typed here goes
 * straight to the PTY through [dispatch] — the field never holds text (the
 * terminal echoes), and hardware keys (arrows, Backspace→DEL, Tab, Enter,
 * Ctrl/Alt+letter…) are intercepted via preview-key events and mapped to
 * terminal bytes by [hardwareKeySequence]. [dispatch] is the caller's quick-key
 * dispatch, so the sticky Ctrl/Alt modifiers apply to typed keys too and are
 * consumed by the first send.
 */
@Composable
internal fun TerminalTypeField(
    dispatch: (String) -> Unit,
    enabled: Boolean,
    label: String,
    placeholder: String,
    modifier: Modifier = Modifier,
) {
    var draft by rememberSaveable { mutableStateOf("") }
    OutlinedTextField(
        value = draft,
        onValueChange = { fresh ->
            val inserted = directTypeInserted(draft, fresh)
            draft = ""
            if (inserted != null) dispatch(inserted)
        },
        placeholder = { Text(placeholder) },
        modifier = modifier
            .fillMaxWidth()
            .heightIn(min = 52.dp)
            .semantics { contentDescription = label }
            .onPreviewKeyEvent { keyEvent ->
                val native = keyEvent.nativeKeyEvent
                // Consume on DOWN only — the matching UP is a no-op.
                if (native.action != AndroidKeyEvent.ACTION_DOWN) return@onPreviewKeyEvent false
                val sequence = hardwareKeySequence(
                    TerminalKeyEvent(
                        keyCode = native.keyCode,
                        ctrl = native.isCtrlPressed,
                        alt = native.isAltPressed,
                        shift = native.isShiftPressed,
                    ),
                )
                if (sequence == null) {
                    false
                } else {
                    dispatch(sequence)
                    true
                }
            },
        enabled = enabled,
        singleLine = true,
        textStyle = TextStyle(fontFamily = FontFamily.Monospace, fontSize = 13.sp),
        keyboardOptions = KeyboardOptions(imeAction = ImeAction.Send),
        keyboardActions = KeyboardActions(onSend = { dispatch("\r") }),
    )
}
