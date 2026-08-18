package app.switchboard.mobile.platform.google

import app.switchboard.mobile.domain.google.GoogleCredentialBundle
import app.switchboard.mobile.platform.storage.NativeCredentialPlatform
import app.switchboard.mobile.platform.storage.NativeDecryption
import app.switchboard.mobile.platform.storage.NativeEncryptedValue
import app.switchboard.mobile.platform.storage.VerifiedNativeCredentialStore
import java.util.Base64
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class VerifiedGoogleCredentialStoreTest {
    @Test
    fun `verified bundle round trips in a namespace separate from connection credentials`() {
        val platform = FakePlatform()
        val store = VerifiedGoogleCredentialStore(platform)
        val credentials = bundle()

        assertEquals(GoogleCredentialWriteResult.Verified, store.writeAndVerify(credentials))
        assertEquals(credentials, store.bundle)
        assertNotEquals(VerifiedNativeCredentialStore.KEY_ALIAS, VerifiedGoogleCredentialStore.KEY_ALIAS)
        assertNotEquals(VerifiedNativeCredentialStore.PREFERENCE_FILE, VerifiedGoogleCredentialStore.PREFERENCE_FILE)
        assertFalse(platform.preferences.values.single().contains(credentials.refreshToken))
    }

    @Test
    fun `failed promotion leaves the previously verified bundle active`() {
        val platform = FakePlatform()
        val store = VerifiedGoogleCredentialStore(platform)
        val original = bundle()
        assertEquals(GoogleCredentialWriteResult.Verified, store.writeAndVerify(original))
        platform.failedKey = VerifiedGoogleCredentialStore.ACTIVE_KEY

        val result = store.writeAndVerify(original.copy(refreshToken = "1//replacement"))

        assertTrue(result is GoogleCredentialWriteResult.Failed)
        assertEquals(original, store.bundle)
    }

    @Test
    fun `compare-and-replace and native-only clear reject a stale expected bundle`() {
        val platform = FakePlatform()
        val store = VerifiedGoogleCredentialStore(platform)
        val active = bundle()
        store.writeAndVerify(active)

        assertFalse(store.replace(active.copy(refreshToken = "stale"), active.copy(accessToken = "wrong")))
        assertFalse(store.clearNativeOwned(active.copy(refreshToken = "stale")))
        assertEquals(active, store.bundle)

        assertTrue(store.clearNativeOwned(active))
        assertNull(store.bundle)
    }

    @Test
    fun `corrupt or undecryptable native envelopes are treated as unavailable`() {
        val platform = FakePlatform()
        val store = VerifiedGoogleCredentialStore(platform)
        platform.preferences[VerifiedGoogleCredentialStore.PREFERENCE_FILE to VerifiedGoogleCredentialStore.ACTIVE_KEY] =
            "not-an-envelope"
        assertTrue(store.readStatus() is GoogleCredentialReadResult.Blocked)
        assertNull(store.bundle)

        store.writeAndVerify(bundle())
        platform.decryption = NativeDecryption.KeyUnavailable
        assertTrue(store.readStatus() is GoogleCredentialReadResult.Blocked)
        assertNull(store.bundle)

        platform.decryption = NativeDecryption.Failed("authentication tag mismatch")
        assertTrue(store.readStatus() is GoogleCredentialReadResult.Blocked)
        assertNull(store.bundle)
    }

    @Test
    fun `missing active key is distinct from an unreadable active key`() {
        val store = VerifiedGoogleCredentialStore(FakePlatform())

        assertEquals(GoogleCredentialReadResult.Absent, store.readStatus())
        assertNull(store.bundle)
    }

    private fun bundle() = GoogleCredentialBundle(
        clientId = "client.apps.googleusercontent.com",
        clientSecret = "desktop-secret",
        refreshToken = "1//refresh",
        accessToken = "access",
        expiresAtEpochMs = 123_456,
        email = "person@example.com",
    )

    private class FakePlatform : NativeCredentialPlatform {
        val preferences = mutableMapOf<Pair<String, String>, String>()
        var failedKey: String? = null
        var decryption: NativeDecryption? = null

        override fun encrypt(keyAlias: String, plaintext: ByteArray): NativeEncryptedValue =
            NativeEncryptedValue("iv", Base64.getEncoder().encodeToString(plaintext))

        override fun decrypt(keyAlias: String, value: NativeEncryptedValue): NativeDecryption =
            decryption ?: NativeDecryption.Plaintext(Base64.getDecoder().decode(value.ciphertext))

        override fun readPreference(file: String, key: String): String? = preferences[file to key]

        override fun writePreference(file: String, key: String, value: String): Boolean {
            if (key == failedKey) return false
            preferences[file to key] = value
            return true
        }

        override fun deletePreference(file: String, key: String): Boolean {
            preferences.remove(file to key)
            return true
        }
    }
}
