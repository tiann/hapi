@file:OptIn(kotlinx.coroutines.ExperimentalCoroutinesApi::class)

package app.hapi.companion.feature.settings

import app.hapi.companion.feature.chat.composer.DictationApi
import app.hapi.companion.feature.chat.composer.DictationPrefs
import app.hapi.protocol.wire.TranscriptionProviderInfo
import app.hapi.protocol.wire.TranscriptionProvidersResponse
import app.hapi.protocol.wire.TranscriptionResponse
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.runTest

// ------------------------------------------------------------------ fakes --

private class FakeDictationPrefs : DictationPrefs {
    val providerValue = MutableStateFlow<String?>(null)
    val languageValue = MutableStateFlow<String?>(null)

    override val providerId: Flow<String?> = providerValue
    override val language: Flow<String?> = languageValue

    override suspend fun setProviderId(id: String?) {
        providerValue.value = id
    }

    override suspend fun setLanguage(code: String?) {
        languageValue.value = code
    }
}

private class FakeDictationApi(providers: List<TranscriptionProviderInfo>) : DictationApi {
    val response = TranscriptionProvidersResponse(providers)
    var calls = 0
    var failure: Exception? = null

    override suspend fun transcriptionProviders(): TranscriptionProvidersResponse {
        calls += 1
        failure?.let { throw it }
        return response
    }

    override suspend fun transcribe(
        audio: ByteArray,
        filename: String,
        mimeType: String,
        provider: String,
        language: String?,
    ): TranscriptionResponse = throw UnsupportedOperationException("unused")
}

private fun provider(id: String, vararg modes: String) =
    TranscriptionProviderInfo(id = id, label = id.replaceFirstChar { it.uppercase() }, modes = modes.toList())

private class DictationHarness(testScope: TestScope) {
    val prefs = FakeDictationPrefs()
    val api = FakeDictationApi(
        listOf(
            provider("openai", "standard", "realtime"),
            provider("browser-local", "standard"),
            provider("deepgram"), // realtime-only: must not surface
        ),
    )
    val viewModel = DictationSettingsViewModel(
        prefs = prefs,
        api = api,
        scope = CoroutineScope(SupervisorJob() + StandardTestDispatcher(testScope.testScheduler)),
    )
}

// ----------------------------------------------------------------- tests --

class DictationSettingsViewModelTest {

    @Test
    fun `state starts unloaded and start loads the standard-capable providers`() = runTest {
        val harness = DictationHarness(this)
        assertEquals(DictationSettingsUiState(), harness.viewModel.state.value)

        harness.viewModel.start()
        advanceUntilIdle()

        val state = harness.viewModel.state.value
        assertTrue(state.loaded)
        assertEquals(listOf("openai", "browser-local"), state.providers.map { it.id })
        // No stored preference: a take would use the hub's first standard.
        assertEquals("openai", state.resolvedProviderId)
        assertEquals(1, harness.api.calls)
    }

    @Test
    fun `stored provider is used while the hub still offers it`() = runTest {
        val harness = DictationHarness(this)
        harness.prefs.providerValue.value = "browser-local"

        harness.viewModel.start()
        advanceUntilIdle()

        assertEquals("browser-local", harness.viewModel.state.value.resolvedProviderId)
    }

    @Test
    fun `stale stored provider falls back to the first standard provider`() = runTest {
        val harness = DictationHarness(this)
        harness.prefs.providerValue.value = "groq" // hub never offered it

        harness.viewModel.start()
        advanceUntilIdle()

        val state = harness.viewModel.state.value
        assertEquals("groq", state.storedProviderId)
        assertEquals("openai", state.resolvedProviderId)
    }

    @Test
    fun `setProvider and setLanguage write through the prefs`() = runTest {
        val harness = DictationHarness(this)
        harness.viewModel.start()
        advanceUntilIdle()

        harness.viewModel.setProvider("browser-local")
        harness.viewModel.setLanguage("zh-CN")
        advanceUntilIdle()

        val state = harness.viewModel.state.value
        assertEquals("browser-local", state.resolvedProviderId)
        assertEquals("zh-CN", state.language)
    }

    @Test
    fun `setLanguage with null returns to auto-detect`() = runTest {
        val harness = DictationHarness(this)
        harness.prefs.languageValue.value = "ja-JP"
        harness.viewModel.start()
        advanceUntilIdle()

        harness.viewModel.setLanguage(null)
        advanceUntilIdle()

        assertEquals(null, harness.viewModel.state.value.language)
    }

    @Test
    fun `provider fetch failure loads empty and hides the section`() = runTest {
        val harness = DictationHarness(this)
        harness.api.failure = RuntimeException("hub unreachable")

        harness.viewModel.start()
        advanceUntilIdle()

        val state = harness.viewModel.state.value
        assertTrue(state.loaded)
        assertTrue(state.providers.isEmpty())
        assertEquals(null, state.resolvedProviderId)
    }

    @Test
    fun `start is idempotent so revisits do not refetch`() = runTest {
        val harness = DictationHarness(this)
        harness.viewModel.start()
        harness.viewModel.start()
        advanceUntilIdle()

        assertEquals(1, harness.api.calls)
    }

    @Test
    fun `preference load racing the provider load keeps both updates`() = runTest {
        // Regression for the read-copy-write races in start(): the prefs
        // collector and the provider fetch both wrote
        // `state.value = state.value.copy(...)` from the holder's
        // multithreaded scope, so a fetch result could be clobbered by a
        // stale snapshot (or vice versa) with no re-emission to repair it.
        // Real threads (not the test scheduler) + a wide resolve window
        // (stored pick dead last in a big catalog) + a hammered language
        // pref maximise the interleavings; update{} must keep every round's
        // terminal state fully consistent.
        val catalog = buildList {
            repeat(1_500) { i -> add(provider("bulk-$i", "standard")) }
            add(provider("browser-local", "standard")) // stored pick: last → full scan
        }

        repeat(200) {
            val prefs = FakeDictationPrefs().apply { providerValue.value = "browser-local" }
            val api = FakeDictationApi(catalog)
            val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
            try {
                val viewModel = DictationSettingsViewModel(prefs, api, scope)
                viewModel.start()
                // Race pref emissions through the in-flight fetch. The final
                // "zh-CN" never occurs mid-hammer, so the predicate below can
                // only match once both loads' writes have landed.
                repeat(24) { i -> prefs.languageValue.value = if (i % 2 == 0) "en-US" else "en-GB" }
                prefs.languageValue.value = "zh-CN"

                viewModel.state.first {
                    it.loaded && it.storedProviderId == "browser-local" && it.language == "zh-CN"
                }

                val state = viewModel.state.value
                assertTrue(state.loaded)
                assertEquals(catalog.size, state.providers.size)
                assertEquals("browser-local", state.storedProviderId)
                assertEquals("zh-CN", state.language)
                assertEquals("browser-local", state.resolvedProviderId)
            } finally {
                scope.coroutineContext[Job]?.cancelAndJoin()
            }
        }
    }

    @Test
    fun `hub switch keeps discovery retry and scoping keys usable after a failure`() = runTest {
        val prefs = FakeDictationPrefs().apply {
            providerValue.value = "browser-local"
            languageValue.value = "zh-CN"
        }

        // Hub A: fetch fails → section hides, but the app-wide (cross-hub)
        // scoping keys stay visible in the state.
        val hubA = FakeDictationApi(emptyList()).apply { failure = RuntimeException("hub A unreachable") }
        val onA = DictationSettingsViewModel(
            prefs = prefs,
            api = hubA,
            scope = CoroutineScope(SupervisorJob() + StandardTestDispatcher(testScheduler)),
        )
        onA.start()
        advanceUntilIdle()
        assertTrue(onA.state.value.loaded)
        assertTrue(onA.state.value.providers.isEmpty())
        assertEquals(null, onA.state.value.resolvedProviderId)
        assertEquals("browser-local", onA.state.value.storedProviderId)
        assertEquals("zh-CN", onA.state.value.language)

        // Hub switch (fresh per-hub holder, same app-wide prefs, hub B's
        // api): hub B's first visit also fails — that error state must not
        // wedge anything either.
        val hubB = FakeDictationApi(
            listOf(provider("openai", "standard"), provider("browser-local", "standard")),
        ).apply { failure = RuntimeException("hub B unreachable") }
        val firstVisit = DictationSettingsViewModel(
            prefs = prefs,
            api = hubB,
            scope = CoroutineScope(SupervisorJob() + StandardTestDispatcher(testScheduler)),
        )
        firstVisit.start()
        advanceUntilIdle()
        assertTrue(firstVisit.state.value.loaded)
        assertTrue(firstVisit.state.value.providers.isEmpty())

        // Retry on the next settings visit (hub B reachable now): discovery
        // works, hub B's providers replace — not blend with — any earlier
        // state, and the app-wide keys survived every hub transition.
        hubB.failure = null
        val retry = DictationSettingsViewModel(
            prefs = prefs,
            api = hubB,
            scope = CoroutineScope(SupervisorJob() + StandardTestDispatcher(testScheduler)),
        )
        retry.start()
        advanceUntilIdle()

        val state = retry.state.value
        assertTrue(state.loaded)
        assertEquals(listOf("openai", "browser-local"), state.providers.map { it.id })
        assertEquals("browser-local", state.storedProviderId)
        assertEquals("zh-CN", state.language)
        assertEquals("browser-local", state.resolvedProviderId)
        assertEquals(1, hubA.calls)
        assertEquals(2, hubB.calls)
    }
}

class DictationLanguageCatalogTest {

    @Test
    fun `codes are unique and non-blank`() {
        val codes = DICTATION_LANGUAGES.map { it.code }
        assertEquals(codes.size, codes.toSet().size)
        assertTrue(codes.all { it.isNotBlank() && !it.startsWith("auto") })
    }

    @Test
    fun `catalog carries the web selector's key languages`() {
        assertEquals("zh-CN", findDictationLanguage("zh-CN")?.code)
        assertEquals("ru-RU", findDictationLanguage("ru-RU")?.code)
        assertEquals("en-US", DICTATION_LANGUAGES.first().code)
        assertEquals(null, findDictationLanguage("xx-XX"))
        assertEquals(null, findDictationLanguage(null))
    }

    @Test
    fun `label mirrors the web getLanguageDisplayName format`() {
        // english != native → "English (native)"; region appended after " - ".
        assertEquals("Chinese (中文) - Simplified", findDictationLanguage("zh-CN")?.label)
        // english == native → bare name (no "(English)" parenthetical).
        assertEquals("English - United States", findDictationLanguage("en-US")?.label)
        assertEquals("Russian (Русский)", findDictationLanguage("ru-RU")?.label)
        assertEquals("Japanese (日本語)", findDictationLanguage("ja-JP")?.label)
    }
}
