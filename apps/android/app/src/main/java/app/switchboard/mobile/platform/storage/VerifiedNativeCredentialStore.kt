package app.switchboard.mobile.platform.storage

import app.switchboard.mobile.data.connection.ConnectionCredentialStore
import app.switchboard.mobile.compat.LegacyJsonParser
import app.switchboard.mobile.compat.objectOrNull
import app.switchboard.mobile.compat.stringOrNull
import app.switchboard.mobile.platform.migration.CredentialWriteVerification
import app.switchboard.mobile.platform.migration.NativeCredentialStore
import app.switchboard.mobile.platform.migration.SelectedCredential
import java.nio.ByteBuffer
import java.nio.charset.CodingErrorAction
import java.nio.charset.StandardCharsets

data class NativeEncryptedValue(
    val iv: String,
    val ciphertext: String,
)

sealed interface NativeDecryption {
    data class Plaintext(val bytes: ByteArray) : NativeDecryption
    data object KeyUnavailable : NativeDecryption
    data class Failed(val detail: String) : NativeDecryption
}

interface NativeCredentialPlatform {
    fun encrypt(keyAlias: String, plaintext: ByteArray): NativeEncryptedValue
    fun decrypt(keyAlias: String, value: NativeEncryptedValue): NativeDecryption
    fun readPreference(file: String, key: String): String?
    fun writePreference(file: String, key: String, value: String): Boolean
    fun deletePreference(file: String, key: String): Boolean
}

data class NativeCredential(
    val kind: Kind,
    val value: String,
) {
    enum class Kind(val wireName: String) {
        DEVICE_SESSION("device_session"),
        PAIRING_TOKEN("pairing_token"),
        LEGACY_INLINE_TOKEN("legacy_inline_token"),
    }
}

class VerifiedNativeCredentialStore(
    private val platform: NativeCredentialPlatform,
) : NativeCredentialStore, ConnectionCredentialStore {
    override fun writeAndVerify(
        logicalKey: String,
        credential: SelectedCredential.Present,
    ): CredentialWriteVerification {
        val native = credential.toNative()
        return try {
            val encrypted = platform.encrypt(KEY_ALIAS, native.encode())
            val committed = platform.writePreference(
                PREFERENCE_FILE,
                preferenceKey(logicalKey),
                encrypted.encode(),
            )
            if (!committed) {
                CredentialWriteVerification.Failed("native credential preference commit failed")
            } else if (read(logicalKey) != native) {
                CredentialWriteVerification.Failed("native credential read-back mismatch")
            } else {
                CredentialWriteVerification.Verified
            }
        } catch (error: Exception) {
            CredentialWriteVerification.Failed(error.message ?: "native credential write failed")
        }
    }

    override fun read(logicalKey: String): NativeCredential? = try {
        val encoded = platform.readPreference(PREFERENCE_FILE, preferenceKey(logicalKey)) ?: return null
        val envelope = encoded.decodeEnvelope()
        when (val decrypted = platform.decrypt(KEY_ALIAS, envelope)) {
            is NativeDecryption.Plaintext -> decrypted.bytes.decodeCredential()
            NativeDecryption.KeyUnavailable,
            is NativeDecryption.Failed,
            -> null
        }
    } catch (_: Exception) {
        null
    }

    override fun deleteNativeOwned(logicalKey: String): Boolean = try {
        platform.deletePreference(PREFERENCE_FILE, preferenceKey(logicalKey))
    } catch (_: Exception) {
        false
    }

    private fun SelectedCredential.Present.toNative(): NativeCredential = when (this) {
        is SelectedCredential.DeviceSession -> NativeCredential(NativeCredential.Kind.DEVICE_SESSION, value)
        is SelectedCredential.PairingToken -> NativeCredential(NativeCredential.Kind.PAIRING_TOKEN, value)
        is SelectedCredential.LegacyInlineToken -> NativeCredential(NativeCredential.Kind.LEGACY_INLINE_TOKEN, value)
    }

    private fun NativeCredential.encode(): ByteArray =
        "${kind.wireName}\u0000$value".toByteArray(StandardCharsets.UTF_8)

    private fun ByteArray.decodeCredential(): NativeCredential {
        val decoder = StandardCharsets.UTF_8.newDecoder()
            .onMalformedInput(CodingErrorAction.REPORT)
            .onUnmappableCharacter(CodingErrorAction.REPORT)
        val source = decoder.decode(ByteBuffer.wrap(this)).toString()
        val separator = source.indexOf('\u0000')
        require(separator > 0) { "native credential payload is malformed" }
        val kind = NativeCredential.Kind.entries.firstOrNull { it.wireName == source.substring(0, separator) }
            ?: error("native credential kind is unsupported")
        return NativeCredential(kind, source.substring(separator + 1))
    }

    private fun NativeEncryptedValue.encode(): String =
        "{\"v\":1,\"iv\":${iv.jsonQuoted()},\"ct\":${ciphertext.jsonQuoted()}}"

    private fun String.decodeEnvelope(): NativeEncryptedValue {
        val root = LegacyJsonParser.parse(this).objectOrNull()
            ?: error("native credential envelope must be an object")
        val iv = root.values["iv"]?.stringOrNull() ?: error("native credential envelope is missing iv")
        val ciphertext = root.values["ct"]?.stringOrNull() ?: error("native credential envelope is missing ct")
        return NativeEncryptedValue(iv, ciphertext)
    }

    private fun preferenceKey(logicalKey: String): String =
        "$PREFERENCE_KEY_PREFIX${logicalKey.replace(UNSAFE_KEY_CHARS, "_")}"

    companion object {
        const val KEY_ALIAS = "switchboard.native.credentials.v1"
        const val PREFERENCE_FILE = "SwitchboardNativeCredentials"
        const val PREFERENCE_KEY_PREFIX = "credential_v1-"
        private val UNSAFE_KEY_CHARS = Regex("[^A-Za-z0-9._-]")
    }
}

private fun String.jsonQuoted(): String = buildString {
    append('"')
    for (char in this@jsonQuoted) {
        when (char) {
            '"' -> append("\\\"")
            '\\' -> append("\\\\")
            '\b' -> append("\\b")
            '\u000c' -> append("\\f")
            '\n' -> append("\\n")
            '\r' -> append("\\r")
            '\t' -> append("\\t")
            else -> if (char.code < 0x20) append("\\u%04x".format(char.code)) else append(char)
        }
    }
    append('"')
}
