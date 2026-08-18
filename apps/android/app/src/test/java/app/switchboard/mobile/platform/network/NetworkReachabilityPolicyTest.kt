package app.switchboard.mobile.platform.network

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class NetworkReachabilityPolicyTest {
    @Test
    fun `unknown and transport present remain online without WAN validation`() {
        assertTrue(NetworkReachabilityPolicy.isReachable(snapshot = null))
        assertTrue(
            NetworkReachabilityPolicy.isReachable(
                NetworkSnapshot(hasTransport = true, validatedInternet = false),
            ),
        )
        assertTrue(
            NetworkReachabilityPolicy.isReachable(
                NetworkSnapshot(hasTransport = true, validatedInternet = true),
            ),
        )
    }

    @Test
    fun `explicit absence of every usable transport is offline`() {
        assertFalse(
            NetworkReachabilityPolicy.isReachable(
                NetworkSnapshot(hasTransport = false, validatedInternet = false),
            ),
        )
    }
}
