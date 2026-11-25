package app.hapi.protocol.pairing

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull

class PairingLinksTest {

    @Test
    fun `parse accepts the companion deeplink form`() {
        val link = PairingLinks.parse("hapicompanion://bind?hub=https://hub.example.com:8443&code=abc123")

        assertEquals(BindLink(hubUrl = "https://hub.example.com:8443", accessToken = "abc123"), link)
    }

    @Test
    fun `parse accepts the web direct-access form`() {
        // Exactly what the hub prints as the first QR (startHub.ts):
        // `${webUrl}/?${new URLSearchParams({hub, token})}`.
        val link = PairingLinks.parse(
            "https://app.hapi.run/?hub=https%3A%2F%2Fdemo.hapi.run&token=tok_9f8%3Adefault"
        )

        assertEquals("https://demo.hapi.run", link?.hubUrl)
        assertEquals("tok_9f8:default", link?.accessToken)
    }

    @Test
    fun `web form is not pinned to the hosted web origin`() {
        val link = PairingLinks.parseWebUrl(
            "https://selfhosted.example:8443/?hub=https%3A%2F%2Fhub.example%3A8443&token=x"
        )

        assertEquals("https://hub.example:8443", link?.hubUrl)
        assertEquals("x", link?.accessToken)
    }

    @Test
    fun `web form ignores extra params and keeps first duplicate`() {
        val link = PairingLinks.parseWebUrl(
            "https://app.hapi.run/?v=1&hub=https%3A%2F%2Fa.example.com&token=first&token=second"
        )

        assertEquals("https://a.example.com", link?.hubUrl)
        assertEquals("first", link?.accessToken)
    }

    @Test
    fun `web form requires both hub and token`() {
        assertNull(PairingLinks.parseWebUrl("https://app.hapi.run/?hub=https%3A%2F%2Fh.example.com"))
        assertNull(PairingLinks.parseWebUrl("https://app.hapi.run/?token=abc"))
        assertNull(PairingLinks.parseWebUrl("https://app.hapi.run/?hub=&token=abc"))
        assertNull(PairingLinks.parseWebUrl("https://app.hapi.run/?hub=https%3A%2F%2Fh.example.com&token="))
        assertNull(PairingLinks.parseWebUrl("https://app.hapi.run/"))
    }

    @Test
    fun `web form rejects a code param - that spelling belongs to the deeplink`() {
        assertNull(PairingLinks.parseWebUrl("https://app.hapi.run/?hub=https%3A%2F%2Fh.example.com&code=abc"))
    }

    @Test
    fun `web form requires both urls to use https`() {
        assertNull(PairingLinks.parseWebUrl("http://app.hapi.run/?hub=https%3A%2F%2Fh.example.com&token=x"))
        assertNull(PairingLinks.parseWebUrl("https://app.hapi.run/?hub=http%3A%2F%2Fh.example.com&token=x"))
        assertNull(PairingLinks.parseWebUrl("https://app.hapi.run/?hub=ftp%3A%2F%2Fh.example.com&token=x"))
        assertNull(PairingLinks.parseWebUrl("https://app.hapi.run/?hub=not-a-url&token=x"))
    }

    @Test
    fun `web form rejects non-https schemes and malformed input`() {
        assertNull(PairingLinks.parseWebUrl("hapicompanion://bind?hub=https%3A%2F%2Fh.example.com&code=x"))
        assertNull(PairingLinks.parseWebUrl("ftp://app.hapi.run/?hub=https%3A%2F%2Fh.example.com&token=x"))
        assertNull(PairingLinks.parseWebUrl(""))
        assertNull(PairingLinks.parseWebUrl("not a uri at all"))
        assertNull(PairingLinks.parseWebUrl("https://app.hapi.run/?hub=https%3A%2F%2Fh.example.com&token=%zz"))
    }

    @Test
    fun `parse returns null for arbitrary non-pairing content`() {
        assertNull(PairingLinks.parse("WIFI:T:WPA;S:mynetwork;P:pass;;"))
        assertNull(PairingLinks.parse("https://example.com/some/page"))
        assertNull(PairingLinks.parse("hello world"))
    }
}
