package app.switchboard.mobile.domain.connection

import app.switchboard.mobile.protocol.JsonCodec
import app.switchboard.mobile.protocol.JsonObject
import app.switchboard.mobile.protocol.JsonString
import java.nio.file.Files
import java.nio.file.Path
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The row-state rules mirror src/shared/connection-security.ts, and every copy
 * string matches tests/fixtures/connection-security-copy.json, which
 * tests/unit/connection-security.test.ts keeps equal to the shared copy.
 */
class ConnectionSecurityTest {
    private val fp = "7c0e51b2" + "a".repeat(56)

    @Test
    fun shortFingerprintIsTheFirstEightLowercaseHexOfAFingerprint() {
        assertEquals("7c0e51b2", ConnectionSecurityPolicy.shortFingerprint(fp))
        assertEquals("7c0e51b2", ConnectionSecurityPolicy.shortFingerprint(fp.uppercase()))
        assertNull(ConnectionSecurityPolicy.shortFingerprint(null))
        assertNull(ConnectionSecurityPolicy.shortFingerprint("7c0e51b2"))
    }

    @Test
    fun rowStateFollowsTheSharedOrder() {
        fun of(url: String?, iap: Boolean = false, release: Boolean = true, changed: Boolean = false) =
            ConnectionSecurityPolicy.of(url, iap, release, changed)

        assertEquals(ConnectionSecurity.PINNED, of("wss://192.168.1.24:8765?fp=$fp"))
        assertEquals(ConnectionSecurity.LOCAL, of("ws://127.0.0.1:8765"))
        assertEquals(ConnectionSecurity.LOCAL, of("ws://10.0.2.2:8765"))
        assertEquals(ConnectionSecurity.REFUSED, of("ws://10.0.4.17:8765"))
        assertEquals(ConnectionSecurity.PLAIN, of("ws://10.0.4.17:8765", release = false))
        assertEquals(ConnectionSecurity.CERTIFICATE_CHANGED, of("wss://192.168.1.40:8765?fp=$fp", changed = true))
        assertEquals(ConnectionSecurity.IAP, of(null, iap = true, changed = true))
    }

    @Test
    fun attentionFingerprintAndLockRules() {
        assertTrue(ConnectionSecurityPolicy.needsAttention(ConnectionSecurity.REFUSED, error = false))
        assertTrue(ConnectionSecurityPolicy.needsAttention(ConnectionSecurity.PINNED, error = true))
        assertFalse(ConnectionSecurityPolicy.needsAttention(ConnectionSecurity.LOCAL, error = false))
        assertTrue(ConnectionSecurityPolicy.showsFingerprint(ConnectionSecurity.CERTIFICATE_CHANGED))
        assertFalse(ConnectionSecurityPolicy.showsFingerprint(ConnectionSecurity.IAP))
        assertTrue(ConnectionSecurityPolicy.showsLock(ConnectionSecurity.IAP))
        assertFalse(ConnectionSecurityPolicy.showsLock(ConnectionSecurity.REFUSED))
    }

    @Test
    fun fillReplacesNamedPlaceholders() {
        assertEquals(
            "3 of 5",
            ConnectionSecurityCopy.fill(ConnectionSecurityCopy.LIVE_COUNT, "live" to 3, "total" to 5),
        )
    }

    @Test
    fun everyStringMatchesTheSharedCopy() {
        val fixture = loadFixture() as JsonObject
        ConnectionSecurityCopy.all.forEach { (key, value) ->
            val expected = (fixture.values[key] as? JsonString)?.value
            assertEquals(key, expected, value)
        }
    }

    private fun loadFixture() = JsonCodec.parse(
        String(
            Files.readAllBytes(
                generateSequence(Path.of("").toAbsolutePath()) { it.parent }
                    .map { it.resolve("tests/fixtures/connection-security-copy.json") }
                    .firstOrNull(Files::exists)
                    ?: error("Missing tests/fixtures/connection-security-copy.json"),
            ),
            Charsets.UTF_8,
        ),
    )
}
