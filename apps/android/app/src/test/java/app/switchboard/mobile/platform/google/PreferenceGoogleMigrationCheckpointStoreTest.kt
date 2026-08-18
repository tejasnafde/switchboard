package app.switchboard.mobile.platform.google

import app.switchboard.mobile.platform.storage.NativeCredentialPlatform
import app.switchboard.mobile.platform.storage.NativeDecryption
import app.switchboard.mobile.platform.storage.NativeEncryptedValue
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class PreferenceGoogleMigrationCheckpointStoreTest {
    @Test
    fun `completion persists only in native-owned preferences`() {
        val platform = FakePlatform()
        val checkpoint = PreferenceGoogleMigrationCheckpointStore(platform)

        assertFalse(checkpoint.complete)
        assertTrue(checkpoint.markComplete())
        assertTrue(PreferenceGoogleMigrationCheckpointStore(platform).complete)
        assertTrue(platform.preferences.keys.all { it.first != "SecureStore" })
    }

    private class FakePlatform : NativeCredentialPlatform {
        val preferences = mutableMapOf<Pair<String, String>, String>()

        override fun encrypt(keyAlias: String, plaintext: ByteArray): NativeEncryptedValue =
            error("checkpoint is not a credential")

        override fun decrypt(keyAlias: String, value: NativeEncryptedValue): NativeDecryption =
            error("checkpoint is not a credential")

        override fun readPreference(file: String, key: String): String? = preferences[file to key]

        override fun writePreference(file: String, key: String, value: String): Boolean {
            preferences[file to key] = value
            return true
        }

        override fun deletePreference(file: String, key: String): Boolean =
            error("checkpoint is never deleted")
    }
}
