package app.switchboard.mobile.runtime

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Test

class StableDeviceIdentityTest {
    @Test
    fun `creates and persists one non-secret install identity`() {
        val storage = FakeIdentityStorage()
        var generated = 0
        val identities = StableDeviceIdentityProvider(
            storage = storage,
            idSource = { "install-${++generated}" },
            label = "Switchboard Android",
        )

        val first = identities.get()
        val second = identities.get()

        assertEquals(StableDeviceIdentity("install-1", "Switchboard Android"), first)
        assertEquals(first, second)
        assertEquals("install-1", storage.value)
        assertEquals(1, generated)
        assertFalse(first.toString().contains("token", ignoreCase = true))
    }

    @Test
    fun `reuses a persisted identity across provider instances`() {
        val storage = FakeIdentityStorage("existing-install")

        val identity = StableDeviceIdentityProvider(
            storage = storage,
            idSource = { error("must not mint a replacement") },
            label = "Switchboard Android",
        ).get()

        assertEquals("existing-install", identity.deviceId)
    }

    @Test
    fun `rejects blank generated identities without persisting them`() {
        val storage = FakeIdentityStorage()

        val failure = runCatching {
            StableDeviceIdentityProvider(storage, idSource = { "  " }, label = "Switchboard Android").get()
        }.exceptionOrNull()

        assertEquals("device identity source returned a blank value", failure?.message)
        assertEquals(null, storage.value)
    }

    private class FakeIdentityStorage(
        var value: String? = null,
    ) : DeviceIdentityStorage {
        override fun read(): String? = value

        override fun write(deviceId: String) {
            value = deviceId
        }
    }
}
