package app.hapi.companion.feature.share

import android.content.Intent
import androidx.test.core.app.ActivityScenario
import androidx.test.platform.app.InstrumentationRegistry
import app.hapi.companion.HapiApp
import app.hapi.companion.MainActivity
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import org.junit.After
import org.junit.Assert.*
import org.junit.Before
import org.junit.Test

/** Uses an unpaired test install; no credentials or network server needed. */
class ShareActivityTest {
    private val context = InstrumentationRegistry.getInstrumentation().targetContext
    private val graph get() = (context.applicationContext as HapiApp).appGraph

    @Before fun prepare() = runBlocking {
        withTimeout(45_000) { graph.awaitReady() }
        assertTrue("Run on an unpaired test install", graph.hubRegistry.state.value.hubs.isEmpty())
        graph.shareInbox.batches.value.forEach { graph.shareInbox.discard(it.id) }
    }

    @After fun cleanup() = runBlocking {
        graph.shareInbox.batches.value.forEach { graph.shareInbox.discard(it.id) }
    }

    @Test fun coldAndWarmSharesSurviveRecreationWithoutReplayingTheLaunchingIntent() {
        val initial = Intent(context, MainActivity::class.java).apply {
            action = Intent.ACTION_SEND
            type = "text/plain"
            putExtra(Intent.EXTRA_TEXT, "cold share")
            addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        }
        ActivityScenario.launch<MainActivity>(initial).use { scenario ->
            val first = runBlocking {
                withTimeout(45_000) { graph.shareInbox.batches.first { it.size == 1 }.single() }
            }
            assertEquals("cold share", first.text)
            scenario.recreate()
            assertEquals(listOf(first.id), graph.shareInbox.batches.value.map { it.id })
            scenario.onActivity { activity ->
                activity.startActivity(Intent(activity, MainActivity::class.java).apply {
                    action = Intent.ACTION_SEND
                    type = "text/plain"
                    putExtra(Intent.EXTRA_TEXT, "warm share")
                    addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP)
                })
            }
            runBlocking { withTimeout(45_000) { graph.shareInbox.batches.first { it.size == 2 } } }
            scenario.recreate()
            assertEquals(listOf("cold share", "warm share"), graph.shareInbox.batches.value.map { it.text })
            assertEquals(first.id, graph.shareInbox.batches.value.first().id)
            assertTrue(graph.shareInbox.batches.value.all { it.target == null })
        }
    }
}
