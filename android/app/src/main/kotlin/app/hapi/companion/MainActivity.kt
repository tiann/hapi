package app.hapi.companion

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import android.view.WindowManager
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.appcompat.app.AppCompatActivity
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.lifecycle.lifecycleScope
import app.hapi.companion.di.AppGraph
import app.hapi.companion.di.LocalAppGraph
import app.hapi.companion.fcm.PushNotifications
import app.hapi.companion.feature.settings.ThemeMode
import app.hapi.companion.feature.settings.ThemeSettings
import app.hapi.companion.push.PushBinding
import app.hapi.companion.ui.theme.HapiTheme
import app.hapi.protocol.pairing.BindLink
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch

/**
 * Single-activity entry point (`launchMode="singleTask"`). Hosts the
 * Navigation Compose graph under the persisted theme choice
 * ([AppGraph.themePrefs], B-M4e) and feeds two intent routes — cold start and
 * [onNewIntent] — into [AppGraph] flows the navigation layer consumes:
 *
 *  - `hapicompanion://bind?hub=…&code=…` pairing deep links (parsing stays in
 *    [BindLink]) → [AppGraph.pendingBindLink];
 *  - the **internal** notification-tap route ([PushNotifications.ACTION_OPEN_SESSION]
 *    + session-id extra, B-M4a — explicit intent, deliberately no public URI)
 *    → [AppGraph.pendingOpenSessionId].
 */
// AppCompatActivity (not ComponentActivity) since B-M5a: the appcompat base
// class is what applies AppCompatDelegate.setApplicationLocales on API < 33
// (per-app language switching); on API 33+ the framework handles it.
class MainActivity : AppCompatActivity() {

    private val appGraph: AppGraph get() = (application as HapiApp).appGraph

    private val notificationPermissionRequest =
        registerForActivityResult(ActivityResultContracts.RequestPermission()) {
            // Denial is respected silently: pushes still arrive and update in-app
            // state via SSE; only the OS notification surface stays quiet.
        }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        if (Build.VERSION.SDK_INT >= 30) {
            // Compose's imePadding is the single keyboard-inset owner. With the
            // default adjust mode, the AppCompat subdecor ALSO resizes the
            // window for the IME (device-observed: a keyboard-sized gap above
            // the keyboard). ADJUST_NOTHING kills the legacy resize; IME
            // insets are always delivered on 30+ regardless of soft-input
            // mode. On 26–29 the ime() backport requires adjustResize, so
            // those keep the default (and tolerate the legacy behavior).
            @Suppress("DEPRECATION")
            window.setSoftInputMode(WindowManager.LayoutParams.SOFT_INPUT_ADJUST_NOTHING)
        }
        if (savedInstanceState == null) {
            // Only a fresh launch consumes the launching intent — after a
            // config change / process restore the same (already-consumed)
            // intent is redelivered and must not resurrect the confirm card
            // (or re-trigger a notification navigation).
            handleBindIntent(intent)
            handleOpenSessionIntent(intent)
        }
        setContent {
            // Follow-system default renders for the first frames while the
            // DataStore read completes; the persisted choice then applies.
            val theme by appGraph.themePrefs.settings.collectAsState(initial = ThemeSettings())
            HapiTheme(
                darkTheme = when (theme.mode) {
                    ThemeMode.SYSTEM -> isSystemInDarkTheme()
                    ThemeMode.LIGHT -> false
                    ThemeMode.DARK, ThemeMode.OLED -> true
                },
                dynamicColor = theme.dynamicColor,
                oled = theme.mode == ThemeMode.OLED,
            ) {
                CompositionLocalProvider(LocalAppGraph provides appGraph) {
                    HapiNavigation()
                }
            }
        }
        maybeRequestNotificationPermission()
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        handleBindIntent(intent)
        handleOpenSessionIntent(intent)
    }

    private fun handleBindIntent(intent: Intent?) {
        if (intent?.action != Intent.ACTION_VIEW) return
        val data = intent.data ?: return
        val link = BindLink.parse(data.toString())
        if (link != null) {
            appGraph.pendingBindLink.value = link
        } else if (BindLink.SCHEME.equals(data.scheme, ignoreCase = true)) {
            // Ours but malformed (truncated QR, mangled copy/paste).
            appGraph.pairingNotice.value = getString(R.string.pairing_invalid_link)
        }
    }

    /** Notification tap: stash the target session for `HapiNavigation`. */
    private fun handleOpenSessionIntent(intent: Intent?) {
        if (intent?.action != PushNotifications.ACTION_OPEN_SESSION) return
        val sessionId = intent.getStringExtra(PushNotifications.EXTRA_SESSION_ID) ?: return
        appGraph.pendingOpenSessionId.value = sessionId
    }

    /**
     * POST_NOTIFICATIONS (API 33+) — asked only once a hub is actually
     * paired (never on the pristine first open) and only when push can work
     * at all ([PushBinding.isAvailable]). Waiting on the roster flow means a
     * fresh pairing in this very session triggers the prompt right away.
     */
    private fun maybeRequestNotificationPermission() {
        if (Build.VERSION.SDK_INT < 33) return
        if (!PushBinding.isAvailable(this)) return
        lifecycleScope.launch {
            appGraph.hubRegistry.state.first { it.hubs.isNotEmpty() }
            val granted = checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) ==
                PackageManager.PERMISSION_GRANTED
            if (!granted) {
                notificationPermissionRequest.launch(Manifest.permission.POST_NOTIFICATIONS)
            }
        }
    }
}
