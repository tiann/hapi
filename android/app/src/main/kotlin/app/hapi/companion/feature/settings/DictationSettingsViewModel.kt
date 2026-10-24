package app.hapi.companion.feature.settings

import app.hapi.companion.feature.chat.composer.DictationApi
import app.hapi.companion.feature.chat.composer.DictationPrefs
import app.hapi.companion.feature.chat.composer.resolveStandardProvider
import app.hapi.protocol.wire.TranscriptionProviderInfo
import kotlin.coroutines.cancellation.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.launch

/** One language option (web `Language`, `web/src/lib/languages.ts`). */
data class DictationLanguage(
    /** BCP-47 tag sent as the transcription `language` part. */
    val code: String,
    val englishName: String,
    val nativeName: String,
    val region: String? = null,
) {
    /** Web `getLanguageDisplayName` twin: "Chinese (中文) - Simplified". */
    val label: String
        get() = buildString {
            if (englishName != nativeName) append("$englishName ($nativeName)") else append(nativeName)
            region?.let { append(" - $it") }
        }
}

/**
 * Language catalog mirroring the web selector's list
 * (`getElevenLabsSupportedLanguages()`, `web/src/lib/languages.ts`) — auto
 * detect is NOT an entry: the UI adds it as the localized first row. Native
 * names are literals by the app-language-picker convention.
 */
val DICTATION_LANGUAGES: List<DictationLanguage> = listOf(
    DictationLanguage("en-US", "English", "English", "United States"),
    DictationLanguage("en-GB", "English", "English", "United Kingdom"),
    DictationLanguage("en-AU", "English", "English", "Australia"),
    DictationLanguage("en-CA", "English", "English", "Canada"),
    DictationLanguage("es-ES", "Spanish", "Español", "Spain"),
    DictationLanguage("es-MX", "Spanish", "Español", "Mexico"),
    DictationLanguage("es-AR", "Spanish", "Español", "Argentina"),
    DictationLanguage("fr-FR", "French", "Français", "France"),
    DictationLanguage("fr-CA", "French", "Français", "Canada"),
    DictationLanguage("de-DE", "German", "Deutsch", "Germany"),
    DictationLanguage("de-AT", "German", "Deutsch", "Austria"),
    DictationLanguage("it-IT", "Italian", "Italiano"),
    DictationLanguage("pt-BR", "Portuguese", "Português", "Brazil"),
    DictationLanguage("pt-PT", "Portuguese", "Português", "Portugal"),
    DictationLanguage("ru-RU", "Russian", "Русский"),
    DictationLanguage("zh-CN", "Chinese", "中文", "Simplified"),
    DictationLanguage("zh-TW", "Chinese", "中文", "Traditional"),
    DictationLanguage("ja-JP", "Japanese", "日本語"),
    DictationLanguage("ko-KR", "Korean", "한국어"),
    DictationLanguage("ar-SA", "Arabic", "العربية"),
    DictationLanguage("hi-IN", "Hindi", "हिन्दी"),
    DictationLanguage("nl-NL", "Dutch", "Nederlands"),
    DictationLanguage("sv-SE", "Swedish", "Svenska"),
    DictationLanguage("no-NO", "Norwegian", "Norsk"),
    DictationLanguage("da-DK", "Danish", "Dansk"),
    DictationLanguage("fi-FI", "Finnish", "Suomi"),
    DictationLanguage("pl-PL", "Polish", "Polski"),
    DictationLanguage("tr-TR", "Turkish", "Türkçe"),
    DictationLanguage("vi-VN", "Vietnamese", "Tiếng Việt"),
    DictationLanguage("id-ID", "Indonesian", "Bahasa Indonesia"),
    DictationLanguage("ms-MY", "Malay", "Bahasa Melayu"),
    DictationLanguage("tl-PH", "Tagalog", "Tagalog"),
    DictationLanguage("uk-UA", "Ukrainian", "Українська"),
    DictationLanguage("cs-CZ", "Czech", "Čeština"),
    DictationLanguage("hu-HU", "Hungarian", "Magyar"),
    DictationLanguage("ro-RO", "Romanian", "Română"),
    DictationLanguage("bg-BG", "Bulgarian", "Български"),
    DictationLanguage("el-GR", "Greek", "Ελληνικά"),
    DictationLanguage("hr-HR", "Croatian", "Hrvatski"),
    DictationLanguage("sk-SK", "Slovak", "Slovenčina"),
)

/** Catalog lookup for a stored preference code (null-safe). */
fun findDictationLanguage(code: String?): DictationLanguage? =
    DICTATION_LANGUAGES.firstOrNull { it.code == code }

/** Rendered settings state: hub standard-capable providers + stored choices. */
data class DictationSettingsUiState(
    /** False until the provider fetch settles (also true after a failure). */
    val loaded: Boolean = false,
    /** Hub-configured providers that can transcribe an upload, hub order. */
    val providers: List<TranscriptionProviderInfo> = emptyList(),
    /** Stored provider id (null = the hub's preference order decides). */
    val storedProviderId: String? = null,
    /** What a take would actually use: stored choice or first standard provider. */
    val resolvedProviderId: String? = null,
    /** Stored BCP-47 language code, null = auto-detect. */
    val language: String? = null,
)

/**
 * Dictation rows on the settings home (web `/settings/voice` provider +
 * language rows, standard-mode slice): fetches the hub's configured providers
 * once per screen, mirrors the stored prefs, and resolves the effective
 * provider the way a take would (web `resolveProvider`).
 */
class DictationSettingsViewModel(
    private val prefs: DictationPrefs,
    private val api: DictationApi,
    private val scope: CoroutineScope,
) {

    private val mutableState = MutableStateFlow(DictationSettingsUiState())

    val state: StateFlow<DictationSettingsUiState> = mutableState.asStateFlow()

    private var started = false

    /** Idempotent entry-point call from the screen (`UsageViewModel.start` twin). */
    fun start() {
        if (started) return
        started = true
        scope.launch {
            combine(prefs.providerId, prefs.language) { provider, language -> provider to language }
                .collect { (provider, language) ->
                    mutableState.value = mutableState.value.copy(
                        storedProviderId = provider,
                        language = language,
                        resolvedProviderId = resolveStandardProvider(provider, mutableState.value.providers)?.id,
                    )
                }
        }
        scope.launch {
            val providers = try {
                api.transcriptionProviders().providers.filter { it.modes.contains("standard") }
            } catch (cancellation: CancellationException) {
                throw cancellation
            } catch (_: Exception) {
                // Hub unreachable / not configured: dictation is unavailable;
                // the section stays hidden. Retried on the next settings visit.
                emptyList()
            }
            mutableState.value = mutableState.value.copy(
                loaded = true,
                providers = providers,
                resolvedProviderId = resolveStandardProvider(mutableState.value.storedProviderId, providers)?.id,
            )
        }
    }

    fun setProvider(providerId: String) {
        scope.launch { prefs.setProviderId(providerId) }
    }

    fun setLanguage(code: String?) {
        scope.launch { prefs.setLanguage(code) }
    }
}
