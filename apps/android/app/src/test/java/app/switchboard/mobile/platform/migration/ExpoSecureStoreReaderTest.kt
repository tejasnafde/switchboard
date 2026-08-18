package app.switchboard.mobile.platform.migration

import java.nio.charset.StandardCharsets
import java.util.Base64
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class ExpoSecureStoreReaderTest {
    @Test
    fun decryptsCurrentExpoAesEnvelopeWithCanonicalPreferenceAndKeystoreAlias() {
        val crypto = FakeSecureStorePlatform(
            envelope = envelope(tlen = 128),
            plaintext = "device-session".toByteArray(StandardCharsets.UTF_8),
        )

        val result = ExpoSecureStoreReader(crypto).read("sb-session-lan-main")

        assertEquals(LegacySecureValue.Found("device-session"), result)
        assertEquals("SecureStore", crypto.preferenceFile)
        assertEquals("key_v1-sb-session-lan-main", crypto.preferenceKey)
        assertEquals("AES/GCM/NoPadding:key_v1:keystoreUnauthenticated", crypto.alias)
        assertEquals(128, crypto.tagLength)
        assertFalse(crypto.deleteWasCalled)
    }

    @Test
    fun rejectsWrongSchemeMalformedBase64AndUnsafeTagLengthsWithoutDeletingAnything() {
        val cases = listOf(
            envelope(scheme = "hybrid") to LegacySecureValue.Failure.Kind.UNSUPPORTED_SCHEME,
            envelope(ciphertext = "%%%") to LegacySecureValue.Failure.Kind.CORRUPT_ENVELOPE,
            envelope(tlen = 64) to LegacySecureValue.Failure.Kind.INVALID_TAG_LENGTH,
        )
        for ((encoded, expectedKind) in cases) {
            val platform = FakeSecureStorePlatform(encoded, byteArrayOf())
            val result = ExpoSecureStoreReader(platform).read("logical")

            assertTrue(result is LegacySecureValue.Failure)
            assertEquals(expectedKind, (result as LegacySecureValue.Failure).kind)
            assertFalse(platform.deleteWasCalled)
        }
    }

    @Test
    fun missingKeyAndCipherFailureAreDistinctFromAMissingPreference() {
        assertEquals(LegacySecureValue.Missing, ExpoSecureStoreReader(FakeSecureStorePlatform(null, byteArrayOf())).read("k"))

        val noKey = FakeSecureStorePlatform(envelope(), byteArrayOf(), keyAvailable = false)
        assertEquals(LegacySecureValue.Failure.Kind.KEY_UNAVAILABLE, (ExpoSecureStoreReader(noKey).read("k") as LegacySecureValue.Failure).kind)

        val decryptFailure = FakeSecureStorePlatform(envelope(), byteArrayOf(), decryptFailure = true)
        assertEquals(LegacySecureValue.Failure.Kind.DECRYPTION_FAILED, (ExpoSecureStoreReader(decryptFailure).read("k") as LegacySecureValue.Failure).kind)
    }

    @Test
    fun fallsBackToTheRawLegacyPreferenceOnlyWhenTheCurrentPreferenceIsAbsent() {
        val legacyOnly = FakeSecureStorePlatform(
            envelope = null,
            plaintext = "legacy-secret".toByteArray(StandardCharsets.UTF_8),
            preferences = mapOf("logical" to envelope()),
        )
        assertEquals(LegacySecureValue.Found("legacy-secret"), ExpoSecureStoreReader(legacyOnly).read("logical"))
        assertEquals(listOf("key_v1-logical", "logical"), legacyOnly.preferenceKeys)

        val corruptCurrent = FakeSecureStorePlatform(
            envelope = "not-json",
            plaintext = byteArrayOf(),
            preferences = mapOf("logical" to envelope()),
        )
        val result = ExpoSecureStoreReader(corruptCurrent).read("logical")
        assertEquals(LegacySecureValue.Failure.Kind.CORRUPT_ENVELOPE, (result as LegacySecureValue.Failure).kind)
        assertEquals(listOf("key_v1-logical"), corruptCurrent.preferenceKeys)
        assertFalse(corruptCurrent.deleteWasCalled)
    }

    @Test
    fun credentialPrecedenceNeverFallsBackPastAnUnreadableHigherPrioritySecret() {
        assertEquals(
            SelectedCredential.DeviceSession("session"),
            CredentialPrecedence.select(LegacySecureValue.Found("session"), LegacySecureValue.Found("pairing"), "inline"),
        )
        assertEquals(
            SelectedCredential.PairingToken("pairing"),
            CredentialPrecedence.select(LegacySecureValue.Missing, LegacySecureValue.Found("pairing"), "inline"),
        )
        assertEquals(
            SelectedCredential.LegacyInlineToken("inline"),
            CredentialPrecedence.select(LegacySecureValue.Missing, LegacySecureValue.Missing, "inline"),
        )
        assertTrue(
            CredentialPrecedence.select(
                LegacySecureValue.Failure(LegacySecureValue.Failure.Kind.KEY_UNAVAILABLE, "unavailable"),
                LegacySecureValue.Found("pairing"),
                "inline",
            ) is SelectedCredential.Blocked,
        )
    }

    private fun envelope(
        scheme: String = "aes",
        ciphertext: String = Base64.getEncoder().encodeToString(byteArrayOf(1, 2, 3)),
        tlen: Int = 128,
    ): String =
        """{"scheme":"$scheme","ct":"$ciphertext","iv":"${Base64.getEncoder().encodeToString(byteArrayOf(4, 5, 6))}","tlen":$tlen}"""

    private class FakeSecureStorePlatform(
        private val envelope: String?,
        private val plaintext: ByteArray,
        private val keyAvailable: Boolean = true,
        private val decryptFailure: Boolean = false,
        private val preferences: Map<String, String> = emptyMap(),
    ) : SecureStorePlatform {
        var preferenceFile: String? = null
        var preferenceKey: String? = null
        var alias: String? = null
        var tagLength: Int? = null
        var deleteWasCalled = false
        val preferenceKeys = mutableListOf<String>()

        override fun preference(file: String, key: String): String? {
            preferenceFile = file
            preferenceKey = key
            preferenceKeys += key
            return if (key.startsWith("key_v1-")) envelope else preferences[key]
        }

        override fun decodeBase64(value: String): ByteArray = Base64.getDecoder().decode(value)

        override fun decryptAesGcm(
            keyAlias: String,
            ciphertext: ByteArray,
            iv: ByteArray,
            authenticationTagLength: Int,
        ): SecureStoreDecryption {
            alias = keyAlias
            tagLength = authenticationTagLength
            if (!keyAvailable) return SecureStoreDecryption.KeyUnavailable
            if (decryptFailure) return SecureStoreDecryption.Failed("fixture")
            return SecureStoreDecryption.Plaintext(plaintext)
        }
    }
}
