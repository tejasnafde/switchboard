package app.switchboard.mobile.runtime

import android.content.Context
import android.os.Build
import android.provider.Settings
import android.util.Log
import app.switchboard.mobile.BuildConfig
import app.switchboard.mobile.protocol.DeviceIdentityPayload

private const val TAG = "DeviceIdentity"

/**
 * What this phone tells the desktop about itself on every auth. [installId] is
 * the minted, stored install id ([StableDeviceIdentity.deviceId]), so a second
 * pairing of this install replaces the desktop's old row for it.
 */
fun androidDeviceIdentity(context: Context, installId: String): DeviceIdentityPayload {
    val deviceName = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N_MR1) {
        readDeviceName(context)
    } else {
        null
    }
    return DeviceIdentityPayload.from(
        installId = installId,
        deviceName = deviceName,
        manufacturer = Build.MANUFACTURER,
        model = Build.MODEL,
        osVersion = Build.VERSION.RELEASE,
        appVersion = BuildConfig.VERSION_NAME,
    )
}

/** Some OEM builds restrict this read; the model stands in. */
private fun readDeviceName(context: Context): String? = try {
    Settings.Global.getString(context.applicationContext.contentResolver, Settings.Global.DEVICE_NAME)
} catch (error: SecurityException) {
    Log.w(TAG, "could not read the device name", error)
    null
}
