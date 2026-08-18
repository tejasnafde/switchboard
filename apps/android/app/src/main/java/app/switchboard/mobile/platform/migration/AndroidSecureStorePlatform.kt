package app.switchboard.mobile.platform.migration

import android.content.Context
import android.util.Base64
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

class AndroidSecureStorePlatform(
    private val context: Context,
) : SecureStorePlatform {
    override fun preference(file: String, key: String): String? =
        context.getSharedPreferences(file, Context.MODE_PRIVATE).getString(key, null)

    override fun decodeBase64(value: String): ByteArray = Base64.decode(value, Base64.DEFAULT)

    override fun decryptAesGcm(
        keyAlias: String,
        ciphertext: ByteArray,
        iv: ByteArray,
        authenticationTagLength: Int,
    ): SecureStoreDecryption {
        val secretKey = try {
            val keyStore = KeyStore.getInstance(ANDROID_KEYSTORE).apply { load(null) }
            keyStore.getKey(keyAlias, null) as? SecretKey
                ?: return SecureStoreDecryption.KeyUnavailable
        } catch (error: Exception) {
            return SecureStoreDecryption.Failed(error.message ?: error.javaClass.simpleName)
        }

        return try {
            val cipher = Cipher.getInstance(AES_GCM_TRANSFORMATION)
            cipher.init(Cipher.DECRYPT_MODE, secretKey, GCMParameterSpec(authenticationTagLength, iv))
            SecureStoreDecryption.Plaintext(cipher.doFinal(ciphertext))
        } catch (error: Exception) {
            SecureStoreDecryption.Failed(error.message ?: error.javaClass.simpleName)
        }
    }

    private companion object {
        const val ANDROID_KEYSTORE = "AndroidKeyStore"
        const val AES_GCM_TRANSFORMATION = "AES/GCM/NoPadding"
    }
}
