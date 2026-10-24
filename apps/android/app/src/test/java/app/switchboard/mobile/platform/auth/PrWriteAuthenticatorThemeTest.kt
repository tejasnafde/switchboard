package app.switchboard.mobile.platform.auth

import android.view.ContextThemeWrapper
import androidx.appcompat.app.AlertDialog
import androidx.test.core.app.ApplicationProvider
import app.switchboard.mobile.R
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class PrWriteAuthenticatorThemeTest {
    /**
     * BiometricPrompt builds this dialog for fingerprint on API 24 to 27. The
     * app theme is not AppCompat, so without `alertDialogTheme` it throws
     * "You need to use a Theme.AppCompat theme" and Post crashes the app.
     */
    @Test
    fun theAppThemeCanBuildTheFingerprintDialog() {
        val themed = ContextThemeWrapper(ApplicationProvider.getApplicationContext(), R.style.Theme_Switchboard)
        AlertDialog.Builder(themed).setTitle("Post reply").setMessage("Touch the sensor").create().create()
    }
}
