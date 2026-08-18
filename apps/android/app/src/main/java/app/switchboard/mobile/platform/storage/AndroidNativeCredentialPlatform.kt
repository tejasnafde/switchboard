package app.switchboard.mobile.platform.storage

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

class AndroidNativeCredentialPlatform(
    private val context: Context,
) : NativeCredentialPlatform {
    override fun encrypt(keyAlias: String, plaintext: ByteArray): NativeEncryptedValue {
        val cipher = Cipher.getInstance(TRANSFORMATION)
        cipher.init(Cipher.ENCRYPT_MODE, loadOrCreateKey(keyAlias))
        return NativeEncryptedValue(
            iv = Base64.encodeToString(cipher.iv, Base64.NO_WRAP),
            ciphertext = Base64.encodeToString(cipher.doFinal(plaintext), Base64.NO_WRAP),
        )
    }

    override fun decrypt(keyAlias: String, value: NativeEncryptedValue): NativeDecryption {
        val key = try {
            loadKey(keyAlias) ?: return NativeDecryption.KeyUnavailable
        } catch (error: Exception) {
            return NativeDecryption.Failed(error.message ?: error.javaClass.simpleName)
        }
        return try {
            val cipher = Cipher.getInstance(TRANSFORMATION)
            val iv = Base64.decode(value.iv, Base64.DEFAULT)
            val ciphertext = Base64.decode(value.ciphertext, Base64.DEFAULT)
            cipher.init(Cipher.DECRYPT_MODE, key, GCMParameterSpec(TAG_LENGTH_BITS, iv))
            NativeDecryption.Plaintext(cipher.doFinal(ciphertext))
        } catch (error: Exception) {
            NativeDecryption.Failed(error.message ?: error.javaClass.simpleName)
        }
    }

    override fun readPreference(file: String, key: String): String? =
        context.getSharedPreferences(file, Context.MODE_PRIVATE).getString(key, null)

    override fun writePreference(file: String, key: String, value: String): Boolean =
        context.getSharedPreferences(file, Context.MODE_PRIVATE).edit().putString(key, value).commit()

    override fun deletePreference(file: String, key: String): Boolean =
        context.getSharedPreferences(file, Context.MODE_PRIVATE).edit().remove(key).commit()

    private fun loadOrCreateKey(alias: String): SecretKey = loadKey(alias) ?: run {
        val generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, ANDROID_KEYSTORE)
        generator.init(
            KeyGenParameterSpec.Builder(
                alias,
                KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT,
            ).setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setRandomizedEncryptionRequired(true)
                .setUserAuthenticationRequired(false)
                .build(),
        )
        generator.generateKey()
    }

    private fun loadKey(alias: String): SecretKey? {
        val keyStore = KeyStore.getInstance(ANDROID_KEYSTORE).apply { load(null) }
        return keyStore.getKey(alias, null) as? SecretKey
    }

    private companion object {
        const val ANDROID_KEYSTORE = "AndroidKeyStore"
        const val TRANSFORMATION = "AES/GCM/NoPadding"
        const val TAG_LENGTH_BITS = 128
    }
}
