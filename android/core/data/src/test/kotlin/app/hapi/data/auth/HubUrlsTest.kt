package app.hapi.data.auth

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull

class HubUrlsTest {

    @Test
    fun `origin only - drops path query fragment and trailing slash`() {
        assertEquals("https://hub.example", HubUrls.normalize("https://hub.example/"))
        assertEquals("https://hub.example", HubUrls.normalize("https://hub.example/foo/bar?x=1#frag"))
    }

    @Test
    fun `lowercases scheme and host`() {
        assertEquals("https://hub.example", HubUrls.normalize("HTTPS://Hub.Example/"))
    }

    @Test
    fun `default ports are dropped and custom ports kept`() {
        assertEquals("https://hub.example", HubUrls.normalize("https://hub.example:443/"))
        assertEquals("https://hub.example:8443", HubUrls.normalize("https://hub.example:8443/x"))
    }

    @Test
    fun `trims surrounding whitespace`() {
        assertEquals("https://hub.example", HubUrls.normalize("  https://hub.example/  "))
    }

    @Test
    fun `ipv6 hosts keep brackets`() {
        assertEquals("https://[::1]:3006", HubUrls.normalize("https://[::1]:3006/"))
    }

    @Test
    fun `rejects cleartext non-https schemes and garbage`() {
        assertNull(HubUrls.normalize("http://hub.example"))
        assertNull(HubUrls.normalize("http://192.168.1.10:3006"))
        assertNull(HubUrls.normalize("ftp://hub.example"))
        assertNull(HubUrls.normalize("hapicompanion://bind?hub=x"))
        assertNull(HubUrls.normalize("not a url"))
        assertNull(HubUrls.normalize("hub.example"))
        assertNull(HubUrls.normalize(""))
    }
}
