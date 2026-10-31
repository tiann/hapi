package app.hapi.companion.ui.components

import android.content.ActivityNotFoundException
import android.content.Intent
import android.net.Uri
import android.widget.Toast
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import app.hapi.companion.R

@Composable
fun PrivacyPolicyLink() {
    val context = LocalContext.current
    TextButton(modifier = Modifier.testTag("privacy-policy"), onClick = {
        try {
            context.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse("https://hapi.run/docs/privacy")))
        } catch (_: ActivityNotFoundException) {
            Toast.makeText(context, R.string.privacy_open_failed, Toast.LENGTH_SHORT).show()
        }
    }) { Text(stringResource(R.string.privacy_policy)) }
}
