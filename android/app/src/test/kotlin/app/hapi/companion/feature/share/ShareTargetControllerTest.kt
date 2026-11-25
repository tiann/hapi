package app.hapi.companion.feature.share

import app.hapi.protocol.wire.Session
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.cancel
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.runTest

private class TestShareGateway : ShareSessionGateway {
    var active = true
    var fail = false
    var reopens = 0
    var gate: CompletableDeferred<Unit>? = null
    override suspend fun loadSession(sessionId: String): Session {
        gate?.await()
        if (fail) error("machine offline")
        return Session(
            id = sessionId, namespace = "test", seq = 0, createdAt = 0, updatedAt = 0, active = active,
            metadataVersion = 0, agentStateVersion = 0, thinking = false, thinkingAt = 0,
        )
    }
    override suspend fun reopen(sessionId: String, verified: Session): String {
        assertEquals(sessionId, verified.id)
        reopens++
        return "replacement-id"
    }
}

class ShareTargetControllerTest {
    @Test fun `active targets resolve without resuming or sending`() = runTest {
        val gateway = TestShareGateway()
        val controller = ShareTargetController(gateway, backgroundScope)
        controller.select("original-id")
        testScheduler.runCurrent()
        assertEquals("original-id", controller.state.value.resolvedSessionId)
        assertEquals(0, gateway.reopens)
    }

    @Test fun `inactive targets require confirmation and resolve to returned session id`() = runTest {
        val gateway = TestShareGateway().apply { active = false }
        val controller = ShareTargetController(gateway, backgroundScope)
        controller.select("original-id")
        testScheduler.runCurrent()
        assertEquals("original-id", controller.state.value.confirmSessionId)
        assertNull(controller.state.value.resolvedSessionId)
        assertEquals(0, gateway.reopens)
        controller.select("original-id", confirmReopen = true)
        testScheduler.runCurrent()
        assertEquals("replacement-id", controller.state.value.resolvedSessionId)
        assertEquals(1, gateway.reopens)
    }

    @Test fun `failed resolution retains the selected id for retry`() = runTest {
        val gateway = TestShareGateway().apply { fail = true }
        val controller = ShareTargetController(gateway, backgroundScope)
        controller.select("id")
        testScheduler.runCurrent()
        assertEquals("id", controller.state.value.failedSessionId)
        assertFalse(controller.state.value.busy)
        assertNull(controller.state.value.resolvedSessionId)
        gateway.fail = false
        controller.select("id")
        testScheduler.runCurrent()
        assertEquals("id", controller.state.value.resolvedSessionId)
    }

    @Test fun `duplicate taps coalesce and canceled hub operations never resolve a target`() = runTest {
        val gateway = TestShareGateway().apply { active = false; gate = CompletableDeferred() }
        val scope = CoroutineScope(Job() + StandardTestDispatcher(testScheduler))
        val controller = ShareTargetController(gateway, scope)
        controller.select("id", confirmReopen = true)
        controller.select("id", confirmReopen = true)
        testScheduler.runCurrent()
        assertTrue(controller.state.value.busy)
        scope.cancel()
        gateway.gate!!.complete(Unit)
        testScheduler.runCurrent()
        assertNull(controller.state.value.resolvedSessionId)
        assertEquals(0, gateway.reopens)
    }
}
