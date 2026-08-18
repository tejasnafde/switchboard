package app.switchboard.mobile.platform.google

import app.switchboard.mobile.domain.google.GoogleCredentialBundle
import app.switchboard.mobile.domain.google.GoogleCredentialRepository
import app.switchboard.mobile.platform.storage.NativeCredentialPlatform
import app.switchboard.mobile.platform.storage.NativeDecryption
import app.switchboard.mobile.platform.storage.NativeEncryptedValue
import app.switchboard.mobile.protocol.JsonCodec
import app.switchboard.mobile.protocol.JsonNull
import app.switchboard.mobile.protocol.JsonNumber
import app.switchboard.mobile.protocol.JsonObject
import app.switchboard.mobile.protocol.JsonString
import java.nio.ByteBuffer
import java.nio.charset.CodingErrorAction
import java.nio.charset.StandardCharsets

sealed interface GoogleCredentialWriteResult {
    data object Verified : GoogleCredentialWriteResult
    data class Failed(val reason: String) : GoogleCredentialWriteResult
}

sealed interface GoogleCredentialReadResult {
    data object Absent : GoogleCredentialReadResult
    data class Available(val credentials: GoogleCredentialBundle) : GoogleCredentialReadResult
    data class Blocked(val reason: String) : GoogleCredentialReadResult
}

interface GoogleNativeCredentialStore : GoogleCredentialRepository {
    fun readStatus(): GoogleCredentialReadResult

    fun writeAndVerify(credentials: GoogleCredentialBundle): GoogleCredentialWriteResult
}

class VerifiedGoogleCredentialStore(
    private val platform: NativeCredentialPlatform,
) : GoogleNativeCredentialStore {
    override val bundle: GoogleCredentialBundle?
        @Synchronized get() = (readStatus() as? GoogleCredentialReadResult.Available)?.credentials

    @Synchronized
    override fun readStatus(): GoogleCredentialReadResult = read(ACTIVE_KEY)

    @Synchronized
    override fun writeAndVerify(credentials: GoogleCredentialBundle): GoogleCredentialWriteResult {
        val normalized = credentials.normalized()
            ?: return GoogleCredentialWriteResult.Failed("Google credential bundle is incomplete")
        val priorEnvelope = platform.readPreference(PREFERENCE_FILE, ACTIVE_KEY)
        val envelope = try {
            platform.encrypt(KEY_ALIAS, normalized.encode()).encode()
        } catch (_: Exception) {
            return GoogleCredentialWriteResult.Failed("Google credential encryption failed")
        }

        if (!safeWrite(STAGING_KEY, envelope)) {
            return GoogleCredentialWriteResult.Failed("Google credential staging commit failed")
        }
        if (read(STAGING_KEY) != GoogleCredentialReadResult.Available(normalized)) {
            safeDelete(STAGING_KEY)
            return GoogleCredentialWriteResult.Failed("Google credential staging verification failed")
        }
        if (!safeWrite(ACTIVE_KEY, envelope)) {
            safeDelete(STAGING_KEY)
            return GoogleCredentialWriteResult.Failed("Google credential promotion commit failed")
        }
        if (read(ACTIVE_KEY) != GoogleCredentialReadResult.Available(normalized)) {
            restore(priorEnvelope)
            safeDelete(STAGING_KEY)
            return GoogleCredentialWriteResult.Failed("Google credential promotion verification failed")
        }
        safeDelete(STAGING_KEY)
        return GoogleCredentialWriteResult.Verified
    }

    @Synchronized
    override fun replace(
        expected: GoogleCredentialBundle,
        replacement: GoogleCredentialBundle,
    ): Boolean {
        if (readStatus() != GoogleCredentialReadResult.Available(expected)) return false
        return writeAndVerify(replacement) == GoogleCredentialWriteResult.Verified
    }

    @Synchronized
    override fun clearNativeOwned(expected: GoogleCredentialBundle?): Boolean {
        if (expected != null && readStatus() != GoogleCredentialReadResult.Available(expected)) return false
        safeDelete(STAGING_KEY)
        if (!safeDelete(ACTIVE_KEY)) return false
        return readStatus() == GoogleCredentialReadResult.Absent
    }

    private fun read(key: String): GoogleCredentialReadResult = try {
        val encoded = platform.readPreference(PREFERENCE_FILE, key)
            ?: return GoogleCredentialReadResult.Absent
        val encrypted = encoded.decodeEnvelope()
        when (val decrypted = platform.decrypt(KEY_ALIAS, encrypted)) {
            is NativeDecryption.Plaintext -> decrypted.bytes.decodeBundle()?.let(GoogleCredentialReadResult::Available)
                ?: GoogleCredentialReadResult.Blocked("Native Google credential payload is invalid")
            NativeDecryption.KeyUnavailable ->
                GoogleCredentialReadResult.Blocked("Native Google credential key is unavailable")
            is NativeDecryption.Failed ->
                GoogleCredentialReadResult.Blocked("Native Google credential decryption failed")
        }
    } catch (_: Exception) {
        GoogleCredentialReadResult.Blocked("Native Google credential envelope is invalid")
    }

    private fun restore(priorEnvelope: String?) {
        if (priorEnvelope == null) {
            safeDelete(ACTIVE_KEY)
        } else {
            safeWrite(ACTIVE_KEY, priorEnvelope)
        }
    }

    private fun safeWrite(key: String, value: String): Boolean = try {
        platform.writePreference(PREFERENCE_FILE, key, value)
    } catch (_: Exception) {
        false
    }

    private fun safeDelete(key: String): Boolean = try {
        platform.deletePreference(PREFERENCE_FILE, key)
    } catch (_: Exception) {
        false
    }

    private fun GoogleCredentialBundle.normalized(): GoogleCredentialBundle? {
        val normalizedClientId = clientId.trim()
        val normalizedRefreshToken = refreshToken.trim()
        if (normalizedClientId.isEmpty() || normalizedRefreshToken.isEmpty()) return null
        return copy(
            clientId = normalizedClientId,
            clientSecret = clientSecret.normalizedOptional(),
            refreshToken = normalizedRefreshToken,
            accessToken = accessToken.normalizedOptional(),
            expiresAtEpochMs = expiresAtEpochMs?.takeIf { it > 0 },
            email = email.normalizedOptional(),
        )
    }

    private fun String?.normalizedOptional(): String? = this?.trim()?.takeIf(String::isNotEmpty)

    private fun GoogleCredentialBundle.encode(): ByteArray = JsonCodec.encode(
        JsonObject(
            linkedMapOf(
                "v" to JsonNumber("1"),
                "clientId" to JsonString(clientId),
                "clientSecret" to clientSecret.jsonValue(),
                "refreshToken" to JsonString(refreshToken),
                "accessToken" to accessToken.jsonValue(),
                "expiresAt" to (expiresAtEpochMs?.let { JsonNumber(it.toString()) } ?: JsonNull),
                "email" to email.jsonValue(),
            ),
        ),
    ).toByteArray(StandardCharsets.UTF_8)

    private fun ByteArray.decodeBundle(): GoogleCredentialBundle? {
        val decoder = StandardCharsets.UTF_8.newDecoder()
            .onMalformedInput(CodingErrorAction.REPORT)
            .onUnmappableCharacter(CodingErrorAction.REPORT)
        val source = decoder.decode(ByteBuffer.wrap(this)).toString()
        val root = JsonCodec.parse(source) as? JsonObject ?: return null
        if (root.number("v") != 1L) return null
        return GoogleCredentialBundle(
            clientId = root.string("clientId") ?: return null,
            clientSecret = root.string("clientSecret"),
            refreshToken = root.string("refreshToken") ?: return null,
            accessToken = root.string("accessToken"),
            expiresAtEpochMs = root.number("expiresAt"),
            email = root.string("email"),
        ).normalized()
    }

    private fun NativeEncryptedValue.encode(): String = JsonCodec.encode(
        JsonObject(
            linkedMapOf(
                "v" to JsonNumber("1"),
                "iv" to JsonString(iv),
                "ct" to JsonString(ciphertext),
            ),
        ),
    )

    private fun String.decodeEnvelope(): NativeEncryptedValue {
        val root = JsonCodec.parse(this) as? JsonObject ?: error("Google credential envelope is invalid")
        require(root.number("v") == 1L) { "Google credential envelope version is unsupported" }
        return NativeEncryptedValue(
            iv = root.string("iv") ?: error("Google credential envelope is missing iv"),
            ciphertext = root.string("ct") ?: error("Google credential envelope is missing ciphertext"),
        )
    }

    private fun JsonObject.string(key: String): String? = (values[key] as? JsonString)?.value

    private fun JsonObject.number(key: String): Long? = (values[key] as? JsonNumber)?.source?.toLongOrNull()

    private fun String?.jsonValue() = this?.let(::JsonString) ?: JsonNull

    companion object {
        const val KEY_ALIAS = "switchboard.native.google.credentials.v1"
        const val PREFERENCE_FILE = "SwitchboardNativeGoogleCredentials"
        const val ACTIVE_KEY = "google_credentials_v1"
        const val STAGING_KEY = "google_credentials_staging_v1"
    }
}
