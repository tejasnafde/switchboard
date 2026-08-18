package app.switchboard.mobile.platform.storage

import app.switchboard.mobile.platform.migration.CredentialWriteVerification
import app.switchboard.mobile.platform.migration.SelectedCredential
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class VerifiedNativeCredentialStoreTest {
    @Test
    fun writesThenDecryptsAndComparesBeforeReportingVerified() {
        val platform = FakeNativeCredentialPlatform()
        val store = VerifiedNativeCredentialStore(platform)

        val result = store.writeAndVerify("office/mac", SelectedCredential.DeviceSession("secret-session"))

        assertEquals(CredentialWriteVerification.Verified, result)
        assertEquals(
            listOf("encrypt", "write", "read", "decrypt"),
            platform.events,
        )
        assertEquals("switchboard.native.credentials.v1", platform.alias)
        assertEquals("SwitchboardNativeCredentials", platform.preferenceFile)
        assertEquals("credential_v1-office_mac", platform.preferenceKey)
        assertFalse(platform.preferenceFile == "SecureStore")
        assertEquals(NativeCredential.Kind.DEVICE_SESSION, store.read("office/mac")?.kind)
        assertEquals("secret-session", store.read("office/mac")?.value)
    }

    @Test
    fun failedCommitOrReadbackMismatchNeverClaimsVerification() {
        val refused = VerifiedNativeCredentialStore(FakeNativeCredentialPlatform(writeSucceeds = false))
        assertTrue(
            refused.writeAndVerify("c", SelectedCredential.PairingToken("pair")) is
                CredentialWriteVerification.Failed,
        )

        val mismatch = VerifiedNativeCredentialStore(FakeNativeCredentialPlatform(readbackOverride = "wrong"))
        assertTrue(
            mismatch.writeAndVerify("c", SelectedCredential.LegacyInlineToken("inline")) is
                CredentialWriteVerification.Failed,
        )
    }

    @Test
    fun credentialKindRoundTripsWithTheSecret() {
        val platform = FakeNativeCredentialPlatform()
        val store = VerifiedNativeCredentialStore(platform)

        assertEquals(
            CredentialWriteVerification.Verified,
            store.writeAndVerify("c", SelectedCredential.PairingToken("pair")),
        )
        assertEquals(NativeCredential(NativeCredential.Kind.PAIRING_TOKEN, "pair"), store.read("c"))
    }

    @Test
    fun deleteTouchesOnlyTheNativePreferenceKeyForThatConnection() {
        val platform = FakeNativeCredentialPlatform()
        val store = VerifiedNativeCredentialStore(platform)
        store.writeAndVerify("office/mac", SelectedCredential.DeviceSession("secret-session"))
        platform.events.clear()

        assertTrue(store.deleteNativeOwned("office/mac"))

        assertEquals(listOf("delete"), platform.events)
        assertEquals("SwitchboardNativeCredentials", platform.preferenceFile)
        assertEquals("credential_v1-office_mac", platform.preferenceKey)
        assertFalse(platform.preferenceFile == "SecureStore")
        assertEquals(null, store.read("office/mac"))
    }

    private class FakeNativeCredentialPlatform(
        private val writeSucceeds: Boolean = true,
        private val readbackOverride: String? = null,
    ) : NativeCredentialPlatform {
        val events = mutableListOf<String>()
        var alias: String? = null
        var preferenceFile: String? = null
        var preferenceKey: String? = null
        private var stored: String? = null

        override fun encrypt(keyAlias: String, plaintext: ByteArray): NativeEncryptedValue {
            events += "encrypt"
            alias = keyAlias
            return NativeEncryptedValue("iv", plaintext.decodeToString())
        }

        override fun decrypt(keyAlias: String, value: NativeEncryptedValue): NativeDecryption {
            events += "decrypt"
            alias = keyAlias
            return NativeDecryption.Plaintext((readbackOverride ?: value.ciphertext).encodeToByteArray())
        }

        override fun readPreference(file: String, key: String): String? {
            events += "read"
            preferenceFile = file
            preferenceKey = key
            return stored
        }

        override fun writePreference(file: String, key: String, value: String): Boolean {
            events += "write"
            preferenceFile = file
            preferenceKey = key
            if (writeSucceeds) stored = value
            return writeSucceeds
        }

        override fun deletePreference(file: String, key: String): Boolean {
            events += "delete"
            preferenceFile = file
            preferenceKey = key
            stored = null
            return true
        }
    }
}
