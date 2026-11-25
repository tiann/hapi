package app.hapi.data.auth

import app.cash.turbine.test
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue
import kotlinx.coroutines.test.runTest

class HubRegistryTest {

    @Test
    fun `add normalizes activates and preserves order`() = runTest {
        val registry = HubRegistry(InMemoryHubRegistryStorage())

        registry.state.test {
            assertEquals(HubRegistryState(), awaitItem())

            assertEquals("https://hub.one", registry.addHub("HTTPS://Hub.One/some/path?x=1"))
            assertEquals(
                HubRegistryState(hubs = listOf("https://hub.one"), activeHubUrl = "https://hub.one"),
                awaitItem(),
            )

            assertEquals("https://hub.two:8443", registry.addHub("https://hub.two:8443/", makeActive = false))
            with(awaitItem()) {
                assertEquals(listOf("https://hub.one", "https://hub.two:8443"), hubs)
                assertEquals("https://hub.one", activeHubUrl)
            }

            // Re-adding an existing hub with makeActive just re-activates it.
            assertEquals("https://hub.two:8443", registry.addHub("https://hub.two:8443"))
            with(awaitItem()) {
                assertEquals(listOf("https://hub.one", "https://hub.two:8443"), hubs)
                assertEquals("https://hub.two:8443", activeHubUrl)
            }
        }
    }

    @Test
    fun `invalid urls are rejected`() = runTest {
        val registry = HubRegistry(InMemoryHubRegistryStorage())
        assertNull(registry.addHub("not a url"))
        assertNull(registry.addHub("http://x"))
        assertNull(registry.addHub("ftp://x"))
        assertEquals(HubRegistryState(), registry.state.value)
    }

    @Test
    fun `removing the active hub falls back to the first remaining`() = runTest {
        val registry = HubRegistry(InMemoryHubRegistryStorage())
        registry.addHub("https://a.example")
        registry.addHub("https://b.example")
        assertEquals("https://b.example", registry.activeHubUrl)

        assertTrue(registry.removeHub("https://b.example/ignored/path"))
        assertEquals(listOf("https://a.example"), registry.state.value.hubs)
        assertEquals("https://a.example", registry.activeHubUrl)

        assertTrue(registry.removeHub("https://a.example"))
        assertEquals(HubRegistryState(), registry.state.value)
        assertFalse(registry.removeHub("https://a.example"))
    }

    @Test
    fun `setActiveHub only accepts known hubs`() = runTest {
        val registry = HubRegistry(InMemoryHubRegistryStorage())
        registry.addHub("https://a.example")
        registry.addHub("https://b.example")

        assertTrue(registry.setActiveHub("https://a.example"))
        assertEquals("https://a.example", registry.activeHubUrl)
        assertFalse(registry.setActiveHub("https://unknown.example"))
        assertEquals("https://a.example", registry.activeHubUrl)
    }

    @Test
    fun `state round-trips through storage`() = runTest {
        val storage = InMemoryHubRegistryStorage()
        val first = HubRegistry(storage)
        first.addHub("https://a.example")
        first.addHub("https://b.example", makeActive = false)

        val second = HubRegistry(storage)
        second.load()
        assertEquals(first.state.value, second.state.value)
        assertEquals(listOf("https://a.example", "https://b.example"), second.state.value.hubs)
        assertEquals("https://a.example", second.activeHubUrl)
    }

    @Test
    fun `corrupt or inconsistent snapshots are sanitized`() = runTest {
        val corrupt = HubRegistry(InMemoryHubRegistryStorage("not json"))
        corrupt.load()
        assertEquals(HubRegistryState(), corrupt.state.value)

        // Active hub missing from the roster: falls back to the first entry.
        val inconsistent = HubRegistry(
            InMemoryHubRegistryStorage("""{"hubs":["https://a.example"],"activeHubUrl":"https://gone.example"}""")
        )
        inconsistent.load()
        assertEquals("https://a.example", inconsistent.activeHubUrl)

        // Upgrades drop legacy cleartext hubs and normalize the remaining HTTPS origins.
        val legacy = HubRegistry(
            InMemoryHubRegistryStorage(
                """{"hubs":["http://old.example","HTTPS://Keep.Example/path"],"activeHubUrl":"http://old.example"}"""
            )
        )
        legacy.load()
        assertEquals(
            HubRegistryState(hubs = listOf("https://keep.example"), activeHubUrl = "https://keep.example"),
            legacy.state.value,
        )
    }
}
