package app.switchboard.mobile.platform.protocol

import app.switchboard.mobile.protocol.Credential
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class LegacySharedTokenUrlTest {
    @Test
    fun preservesPathAndUnrelatedQueryWhileReplacingAnExistingToken() {
        val result = legacyAuthenticatedUrl(
            "wss://machine.example/sessions%2Factive?workspace=one&token=stale#tail",
            "fresh token/+%",
        )

        assertEquals(
            "wss://machine.example/sessions%2Factive?workspace=one&token=fresh%20token%2F%2B%25#tail",
            result,
        )
    }

    @Test
    fun encodesRawTokenExactlyOnce() {
        val result = legacyAuthenticatedUrl("ws://machine:8765/ws", "already%2Fencoded")

        assertEquals("ws://machine:8765/ws?token=already%252Fencoded", result)
        assertFalse(result.contains("already%2Fencoded"))
    }

    @Test
    fun removesEmbeddedAuthWithoutDiscardingTheRestOfTheUrl() {
        val result = withoutEmbeddedAuth(
            "wss://machine.example/sessions%2Factive?workspace=one&token=secret&pair=code#tail",
        )

        assertEquals(
            "wss://machine.example/sessions%2Factive?workspace=one#tail",
            result,
        )
    }

    @Test
    fun targetPresentationDoesNotExposeUrlOrCredentialTokens() {
        val target = WebSocketTarget(
            deviceId = "phone",
            connectionId = "machine",
            url = "wss://machine.example/ws?token=url-secret&workspace=one",
            credential = Credential.LegacySharedToken("credential-secret"),
        )

        assertTrue(target.toString().contains("wss://machine.example/ws"))
        assertFalse(target.toString().contains("url-secret"))
        assertFalse(target.toString().contains("credential-secret"))
    }
}
