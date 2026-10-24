package app.switchboard.mobile.platform.auth

import android.app.KeyguardManager
import android.content.Context
import android.content.ContextWrapper
import android.os.Build
import android.util.Log
import androidx.biometric.BiometricManager
import androidx.biometric.BiometricManager.Authenticators.BIOMETRIC_STRONG
import androidx.biometric.BiometricManager.Authenticators.BIOMETRIC_WEAK
import androidx.biometric.BiometricManager.Authenticators.DEVICE_CREDENTIAL
import androidx.biometric.BiometricPrompt
import androidx.core.content.ContextCompat
import androidx.fragment.app.FragmentActivity
import app.switchboard.mobile.data.remote.PrWriteAuthResult

/** The device check before every pull request write. No grace window: each Post asks again. */
fun interface PrWriteAuthenticator {
    fun authenticate(title: String, onResult: (PrWriteAuthResult) -> Unit)
}

/**
 * BiometricPrompt with the device PIN, pattern or password always allowed.
 * API 30 and later take a strong biometric or the credential. API 28 and 29
 * cannot pair a strong biometric with the credential, so they take any
 * enrolled biometric or the credential. A phone with neither answers
 * [PrWriteAuthResult.NoCredential] and nothing posts.
 */
class BiometricPrWriteAuthenticator(private val activity: FragmentActivity) : PrWriteAuthenticator {
    private val authenticators =
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) BIOMETRIC_STRONG or DEVICE_CREDENTIAL else BIOMETRIC_WEAK or DEVICE_CREDENTIAL

    override fun authenticate(title: String, onResult: (PrWriteAuthResult) -> Unit) {
        when (val status = BiometricManager.from(activity).canAuthenticate(authenticators)) {
            BiometricManager.BIOMETRIC_SUCCESS -> Unit
            BiometricManager.BIOMETRIC_ERROR_NONE_ENROLLED -> return onResult(PrWriteAuthResult.NoCredential)
            else -> {
                Log.w(TAG, "canAuthenticate returned $status")
                return onResult(if (deviceSecure()) PrWriteAuthResult.Failed(UNAVAILABLE) else PrWriteAuthResult.NoCredential)
            }
        }
        val prompt = BiometricPrompt(
            activity,
            ContextCompat.getMainExecutor(activity),
            object : BiometricPrompt.AuthenticationCallback() {
                override fun onAuthenticationSucceeded(result: BiometricPrompt.AuthenticationResult) =
                    onResult(PrWriteAuthResult.Success)

                override fun onAuthenticationError(errorCode: Int, errString: CharSequence) {
                    Log.i(TAG, "authentication ended with code $errorCode")
                    onResult(
                        when (errorCode) {
                            BiometricPrompt.ERROR_USER_CANCELED,
                            BiometricPrompt.ERROR_NEGATIVE_BUTTON,
                            BiometricPrompt.ERROR_CANCELED,
                            -> PrWriteAuthResult.Cancelled
                            BiometricPrompt.ERROR_NO_DEVICE_CREDENTIAL,
                            BiometricPrompt.ERROR_NO_BIOMETRICS,
                            -> PrWriteAuthResult.NoCredential
                            else -> PrWriteAuthResult.Failed(errString.toString().trimEnd('.') + ".")
                        },
                    )
                }
            },
        )
        prompt.authenticate(
            BiometricPrompt.PromptInfo.Builder()
                .setTitle(title)
                .setSubtitle("Confirm it is you before it posts.")
                .setAllowedAuthenticators(authenticators)
                .build(),
        )
    }

    private fun deviceSecure(): Boolean =
        activity.getSystemService(KeyguardManager::class.java)?.isDeviceSecure == true

    private companion object {
        const val TAG = "PrWriteAuth"
        const val UNAVAILABLE = "Device authentication is not available right now."
    }
}

/** The FragmentActivity behind a Compose context, or null (previews, tests). */
tailrec fun Context.findFragmentActivity(): FragmentActivity? = when (this) {
    is FragmentActivity -> this
    is ContextWrapper -> baseContext.findFragmentActivity()
    else -> null
}
