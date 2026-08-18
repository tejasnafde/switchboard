package app.switchboard.mobile.platform.migration

import app.switchboard.mobile.compat.LegacyJsonParser
import app.switchboard.mobile.compat.LegacySecureStoreKeys
import app.switchboard.mobile.compat.intOrNull
import app.switchboard.mobile.compat.objectOrNull
import app.switchboard.mobile.compat.stringOrNull
import java.nio.ByteBuffer
import java.nio.charset.CodingErrorAction
import java.nio.charset.StandardCharsets

sealed interface SecureStoreDecryption {
    data class Plaintext(val value: ByteArray) : SecureStoreDecryption
    data object KeyUnavailable : SecureStoreDecryption
    data class Failed(val detail: String) : SecureStoreDecryption
}

interface SecureStorePlatform {
    fun preference(file: String, key: String): String?
    fun decodeBase64(value: String): ByteArray
    fun decryptAesGcm(
        keyAlias: String,
        ciphertext: ByteArray,
        iv: ByteArray,
        authenticationTagLength: Int,
    ): SecureStoreDecryption
}

sealed interface LegacySecureValue {
    data class Found(val value: String) : LegacySecureValue
    data object Missing : LegacySecureValue
    data class Failure(val kind: Kind, val detail: String) : LegacySecureValue {
        enum class Kind {
            UNSUPPORTED_SCHEME,
            CORRUPT_ENVELOPE,
            INVALID_TAG_LENGTH,
            KEY_UNAVAILABLE,
            DECRYPTION_FAILED,
            INVALID_PLAINTEXT,
        }
    }
}

fun interface LegacySecretReader {
    fun read(logicalKey: String): LegacySecureValue
}

class ExpoSecureStoreReader(
    private val platform: SecureStorePlatform,
) : LegacySecretReader {
    override fun read(logicalKey: String): LegacySecureValue {
        val encoded = platform.preference(
            LegacySecureStoreKeys.SHARED_PREFERENCES,
            LegacySecureStoreKeys.preferenceKey(logicalKey),
        ) ?: platform.preference(
            LegacySecureStoreKeys.SHARED_PREFERENCES,
            logicalKey,
        ) ?: return LegacySecureValue.Missing

        val envelope = try {
            LegacyJsonParser.parse(encoded).objectOrNull()
                ?: return corrupt("SecureStore value must be a JSON object")
        } catch (error: IllegalArgumentException) {
            return corrupt(error.message ?: "SecureStore value is invalid JSON")
        }

        val scheme = envelope.values["scheme"]?.stringOrNull()
            ?: return corrupt("SecureStore envelope is missing scheme")
        if (scheme != AES_SCHEME) {
            return LegacySecureValue.Failure(
                LegacySecureValue.Failure.Kind.UNSUPPORTED_SCHEME,
                "SecureStore scheme $scheme is unsupported",
            )
        }
        val ciphertext = envelope.values["ct"]?.stringOrNull()
            ?: return corrupt("SecureStore envelope is missing ct")
        val iv = envelope.values["iv"]?.stringOrNull()
            ?: return corrupt("SecureStore envelope is missing iv")
        val tagLength = envelope.values["tlen"]?.intOrNull()
            ?: return corrupt("SecureStore envelope is missing tlen")
        if (tagLength !in MIN_TAG_LENGTH..MAX_TAG_LENGTH || tagLength % 8 != 0) {
            return LegacySecureValue.Failure(
                LegacySecureValue.Failure.Kind.INVALID_TAG_LENGTH,
                "SecureStore AES-GCM tag length is invalid",
            )
        }

        val ciphertextBytes: ByteArray
        val ivBytes: ByteArray
        try {
            ciphertextBytes = platform.decodeBase64(ciphertext)
            ivBytes = platform.decodeBase64(iv)
        } catch (error: IllegalArgumentException) {
            return corrupt(error.message ?: "SecureStore envelope contains invalid base64")
        }
        if (ivBytes.isEmpty() || ciphertextBytes.isEmpty()) {
            return corrupt("SecureStore AES-GCM payload must not be empty")
        }

        return when (val decrypted = platform.decryptAesGcm(KEYSTORE_ALIAS, ciphertextBytes, ivBytes, tagLength)) {
            SecureStoreDecryption.KeyUnavailable -> LegacySecureValue.Failure(
                LegacySecureValue.Failure.Kind.KEY_UNAVAILABLE,
                "SecureStore key is unavailable",
            )
            is SecureStoreDecryption.Failed -> LegacySecureValue.Failure(
                LegacySecureValue.Failure.Kind.DECRYPTION_FAILED,
                decrypted.detail,
            )
            is SecureStoreDecryption.Plaintext -> decodePlaintext(decrypted.value)
        }
    }

    private fun decodePlaintext(bytes: ByteArray): LegacySecureValue = try {
        val decoder = StandardCharsets.UTF_8.newDecoder()
            .onMalformedInput(CodingErrorAction.REPORT)
            .onUnmappableCharacter(CodingErrorAction.REPORT)
        LegacySecureValue.Found(decoder.decode(ByteBuffer.wrap(bytes)).toString())
    } catch (error: Exception) {
        LegacySecureValue.Failure(
            LegacySecureValue.Failure.Kind.INVALID_PLAINTEXT,
            error.message ?: "SecureStore plaintext is not UTF-8",
        )
    }

    private fun corrupt(detail: String) = LegacySecureValue.Failure(
        LegacySecureValue.Failure.Kind.CORRUPT_ENVELOPE,
        detail,
    )

    private companion object {
        const val AES_SCHEME = "aes"
        const val KEYSTORE_ALIAS = "AES/GCM/NoPadding:key_v1:keystoreUnauthenticated"
        const val MIN_TAG_LENGTH = 96
        const val MAX_TAG_LENGTH = 128
    }
}
