package app.hapi.data.push

import java.io.IOException
import java.util.concurrent.Callable
import java.util.concurrent.Executors
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertNotEquals
import kotlin.test.assertNull

class PushIdentityTest {
    private class MemoryStore : PushIdentityStore {
        var value: PushIdentity? = null
        var writes = 0
        var fail = false
        var cacheBeforeFailure = false
        override fun read() = value
        override fun write(identity: PushIdentity) {
            if (fail) {
                if (cacheBeforeFailure) value = identity
                throw IOException("disk unavailable")
            }
            writes += 1
            value = identity
        }
    }

    @Test
    fun `concurrent registrations create one persisted identity which survives process recreation`() {
        val store = MemoryStore()
        val manager = PushIdentityManager(store)
        val pool = Executors.newFixedThreadPool(6)
        try {
            val identities = pool.invokeAll(List(20) { Callable { manager.getOrCreate() } }).map { it.get() }
            assertEquals(1, identities.toSet().size)
            assertEquals(1, store.writes)
            assertEquals(32, identities.first().keyBytes()!!.size)
            assertEquals(identities.first(), PushIdentityManager(store).getOrCreate())
        } finally {
            pool.shutdownNow()
        }
    }

    @Test
    fun `reading for notification delivery never creates an identity`() {
        val store = MemoryStore()
        assertNull(PushIdentityManager(store).existingKey())
        assertEquals(0, store.writes)
    }

    @Test
    fun `failed persistence never exposes a key for registration and can recover later`() {
        val store = MemoryStore().apply { fail = true }
        val manager = PushIdentityManager(store)
        assertFailsWith<IOException> { manager.getOrCreate() }
        assertNull(store.value)
        store.fail = false
        assertEquals(manager.getOrCreate(), store.value)
    }

    @Test
    fun `failed commit retries persistence even when preferences cache already contains the identity`() {
        val store = MemoryStore().apply {
            fail = true
            cacheBeforeFailure = true
        }
        val manager = PushIdentityManager(store)
        assertFailsWith<IOException> { manager.getOrCreate() }
        val cachedIdentity = store.value
        assertNull(manager.existingKey())
        assertFailsWith<IOException> { manager.getOrCreate() }
        assertEquals(0, store.writes)
        store.fail = false
        assertEquals(cachedIdentity, manager.getOrCreate())
        assertEquals(1, store.writes)
        assertEquals(32, manager.existingKey()!!.size)
        assertEquals(cachedIdentity, PushIdentityManager(store).getOrCreate())
    }

    @Test
    fun `missing or corrupt identity regenerates both device id and encryption key`() {
        val store = MemoryStore()
        val manager = PushIdentityManager(store)
        val old = manager.getOrCreate()
        store.value = old.copy(pushKey = "corrupt")
        val repaired = manager.getOrCreate()
        assertNotEquals(old.deviceId, repaired.deviceId)
        assertNotEquals(old.pushKey, repaired.pushKey)
        store.value = null
        assertNotEquals(repaired.deviceId, manager.getOrCreate().deviceId)
    }
}
