package app.hapi.data.auth

import app.hapi.data.base64Url
import app.hapi.data.fakeJwt
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull

class JwtPeekTest {

    @Test
    fun `decodes uid ns and exp (seconds to ms)`() {
        val claims = JwtPeek.peek(fakeJwt(expSeconds = 1_700_000_000, uid = 42, ns = "team"))!!
        assertEquals(42L, claims.uid)
        assertEquals("team", claims.ns)
        assertEquals(1_700_000_000_000L, claims.expiresAtMs)
        assertEquals(1_700_000_000_000L, JwtPeek.expiresAtMs(fakeJwt(expSeconds = 1_700_000_000)))
    }

    @Test
    fun `missing exp yields null expiry but keeps other claims`() {
        val claims = JwtPeek.peek(fakeJwt(expSeconds = null, uid = 7, ns = "default"))!!
        assertEquals(7L, claims.uid)
        assertEquals("default", claims.ns)
        assertNull(claims.expiresAtMs)
    }

    @Test
    fun `payload with unknown extra fields still decodes`() {
        val jwt = "${base64Url("{}")}.${base64Url("""{"uid":1,"ns":"default","exp":10,"iat":5,"future":true}""")}.sig"
        assertEquals(10_000L, JwtPeek.peek(jwt)!!.expiresAtMs)
    }

    @Test
    fun `wrong segment count is rejected`() {
        assertNull(JwtPeek.peek(""))
        assertNull(JwtPeek.peek("onlyone"))
        assertNull(JwtPeek.peek("two.parts"))
        assertNull(JwtPeek.peek("a.b.c.d"))
    }

    @Test
    fun `invalid base64url payload is rejected`() {
        // '+' and '/' belong to the standard alphabet, not base64url.
        assertNull(JwtPeek.peek("h.++//.s"))
        assertNull(JwtPeek.peek("h.%%%.s"))
    }

    @Test
    fun `non-JSON and non-object payloads are rejected`() {
        assertNull(JwtPeek.peek("h.${base64Url("not json")}.s"))
        assertNull(JwtPeek.peek("h.${base64Url("[1,2,3]")}.s"))
        assertNull(JwtPeek.peek("h.${base64Url("\"str\"")}.s"))
    }

    @Test
    fun `mistyped claims degrade to null instead of failing`() {
        val jwt = "h.${base64Url("""{"uid":"not-a-number","ns":5,"exp":"soon"}""")}.s"
        val claims = JwtPeek.peek(jwt)!!
        assertNull(claims.uid)
        assertNull(claims.ns)
        assertNull(claims.expiresAtMs)
    }
}
