package app.switchboard.mobile.platform.voice

import android.Manifest
import android.app.Activity
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.provider.Settings
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat
import app.switchboard.mobile.domain.voice.VoicePermissionDecision
import app.switchboard.mobile.domain.voice.VoicePermissionGateway

object AndroidVoicePermissionPolicy {
    fun result(granted: Boolean, canAskAgain: Boolean): VoicePermissionDecision =
        if (granted) {
            VoicePermissionDecision.Granted
        } else {
            VoicePermissionDecision.Denied(canAskAgain)
        }
}

class AndroidVoicePermissionGateway(
    private val activity: Activity,
    private val requestPermission: (String, (Boolean) -> Unit) -> Unit,
) : VoicePermissionGateway {
    override fun request(callback: (VoicePermissionDecision) -> Unit) {
        if (
            ContextCompat.checkSelfPermission(activity, Manifest.permission.RECORD_AUDIO) ==
            PackageManager.PERMISSION_GRANTED
        ) {
            callback(VoicePermissionDecision.Granted)
            return
        }
        requestPermission(Manifest.permission.RECORD_AUDIO) { granted ->
            callback(
                AndroidVoicePermissionPolicy.result(
                    granted = granted,
                    canAskAgain = !granted && ActivityCompat.shouldShowRequestPermissionRationale(
                        activity,
                        Manifest.permission.RECORD_AUDIO,
                    ),
                ),
            )
        }
    }

    override fun openSettings(): Boolean = runCatching {
        activity.startActivity(
            Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS).apply {
                data = Uri.fromParts("package", activity.packageName, null)
            },
        )
        true
    }.getOrDefault(false)
}
