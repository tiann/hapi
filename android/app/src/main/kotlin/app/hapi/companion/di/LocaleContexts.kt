package app.hapi.companion.di

import android.content.Context
import android.content.res.Configuration
import android.os.LocaleList
import app.hapi.companion.feature.settings.AppLanguage
import java.util.Locale

/**
 * Wrap [this] so resource lookups honor the in-app language choice (B-M5a).
 *
 * Needed for surfaces that resolve strings from the **application** context —
 * FCM notifications, WorkManager result updates, notification-action
 * receivers: on API < 33 appcompat's per-app locales only retarget
 * AppCompatActivity contexts (on 33+ the framework covers everything, and
 * this wrap is a harmless no-op re-application). [AppLanguage.SYSTEM] returns
 * the context unchanged.
 */
fun Context.localizedForAppLanguage(language: AppLanguage): Context {
    if (language == AppLanguage.SYSTEM) return this
    val configuration = Configuration(resources.configuration)
    configuration.setLocales(LocaleList(Locale.forLanguageTag(language.localeTags)))
    return createConfigurationContext(configuration)
}
