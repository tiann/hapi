package app.hapi.protocol.pairing

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull

class BindLinkTest {

    @Test
    fun `parses a plain valid link`() {
        val link = BindLink.parse("hapicompanion://bind?hub=https://hub.example.com:8443&code=abc123")

        assertEquals(BindLink(hubUrl = "https://hub.example.com:8443", accessToken = "abc123"), link)
    }

    @Test
    fun `parses url-encoded values as the hub emits them`() {
        // Exactly what `new URLSearchParams({hub, code}).toString()` produces for
        // hub=https://demo.hapi.run and code=tok_9f8:default (form encoding).
        val link = BindLink.parse(
            "hapicompanion://bind?hub=https%3A%2F%2Fdemo.hapi.run&code=tok_9f8%3Adefault"
        )

        assertEquals("https://demo.hapi.run", link?.hubUrl)
        assertEquals("tok_9f8:default", link?.accessToken)
    }

    @Test
    fun `decodes plus as space in form-encoded values`() {
        val link = BindLink.parse("hapicompanion://bind?hub=https%3A%2F%2Fh.example.com&code=a+b")

        assertEquals("a b", link?.accessToken)
    }

    @Test
    fun `accepts scheme and host case-insensitively`() {
        val link = BindLink.parse("HAPICOMPANION://BIND?hub=https%3A%2F%2Fh.example.com&code=x")

        assertEquals("https://h.example.com", link?.hubUrl)
    }

    @Test
    fun `ignores extra params and keeps first occurrence of duplicates`() {
        val link = BindLink.parse(
            "hapicompanion://bind?v=1&hub=https%3A%2F%2Fa.example.com&code=first&code=second"
        )

        assertEquals("https://a.example.com", link?.hubUrl)
        assertEquals("first", link?.accessToken)
    }

    @Test
    fun `returns null when hub param is missing`() {
        assertNull(BindLink.parse("hapicompanion://bind?code=abc123"))
    }

    @Test
    fun `returns null when code param is missing`() {
        assertNull(BindLink.parse("hapicompanion://bind?hub=https%3A%2F%2Fh.example.com"))
    }

    @Test
    fun `returns null when query is absent`() {
        assertNull(BindLink.parse("hapicompanion://bind"))
    }

    @Test
    fun `returns null when params are blank`() {
        assertNull(BindLink.parse("hapicompanion://bind?hub=&code=x"))
        assertNull(BindLink.parse("hapicompanion://bind?hub=https%3A%2F%2Fh.example.com&code="))
    }

    @Test
    fun `returns null for a wrong scheme`() {
        assertNull(BindLink.parse("https://bind?hub=https%3A%2F%2Fh.example.com&code=x"))
        assertNull(BindLink.parse("hapicompanionx://bind?hub=https%3A%2F%2Fh.example.com&code=x"))
    }

    @Test
    fun `returns null for a wrong host`() {
        assertNull(BindLink.parse("hapicompanion://pair?hub=https%3A%2F%2Fh.example.com&code=x"))
    }

    @Test
    fun `returns null when hub is not an https url`() {
        assertNull(BindLink.parse("hapicompanion://bind?hub=http%3A%2F%2Fh.example.com&code=x"))
        assertNull(BindLink.parse("hapicompanion://bind?hub=ftp%3A%2F%2Fh.example.com&code=x"))
        assertNull(BindLink.parse("hapicompanion://bind?hub=not-a-url&code=x"))
    }

    @Test
    fun `returns null for malformed input`() {
        assertNull(BindLink.parse(""))
        assertNull(BindLink.parse("   "))
        assertNull(BindLink.parse("not a uri at all"))
        assertNull(BindLink.parse("hapicompanion:bind?hub=https%3A%2F%2Fh.example.com&code=x"))
    }

    @Test
    fun `returns null on invalid percent escapes`() {
        assertNull(BindLink.parse("hapicompanion://bind?hub=https%3A%2F%2Fh.example.com&code=%zz"))
    }
}
