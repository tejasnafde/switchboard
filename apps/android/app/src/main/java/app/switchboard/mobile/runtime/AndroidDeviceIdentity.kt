package app.switchboard.mobile.runtime

import android.content.Context
import android.os.Build
import android.provider.Settings
import android.util.Log
import androidx.annotation.RequiresApi
import app.switchboard.mobile.BuildConfig
import app.switchboard.mobile.protocol.DeviceIdentityPayload
import java.io.File

private const val TAG = "DeviceIdentity"

/**
 * The install id the desktop uses to recognise this install pairing again.
 * Minted once and kept in `noBackupFilesDir`, so Auto Backup and device
 * transfer never copy it to another phone, whose pairing would then replace
 * this one's. [StableDeviceIdentity] is backed up and stays the transport id.
 */
class NoBackupInstallIdStorage(directory: File) : DeviceIdentityStorage {
    private val file = File(directory, FILE_NAME)

    override fun read(): String? = if (file.isFile) file.readText().trim() else null

    /** Through a temporary file and a rename, so a crash mid-write never
     *  leaves a truncated id behind. */
    override fun write(deviceId: String) {
        val temporary = File(file.parentFile, "$FILE_NAME.tmp")
        temporary.writeText(deviceId)
        check(temporary.renameTo(file)) { "install id could not be persisted" }
    }

    private companion object {
        const val FILE_NAME = "switchboard-install-id"
    }
}

/**
 * What this phone tells the desktop about itself on every auth, or null when
 * the install id cannot be stored: the phone then pairs as before, without an
 * identity, rather than failing to start.
 */
fun androidDeviceIdentity(context: Context): DeviceIdentityPayload? {
    val installId = try {
        StableDeviceIdentityProvider(NoBackupInstallIdStorage(context.applicationContext.noBackupFilesDir)).get().deviceId
    } catch (error: Exception) {
        Log.w(TAG, "could not read or store the install id, sending no device identity", error)
        return null
    }
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
@RequiresApi(Build.VERSION_CODES.N_MR1)
private fun readDeviceName(context: Context): String? = try {
    Settings.Global.getString(context.applicationContext.contentResolver, Settings.Global.DEVICE_NAME)
} catch (error: SecurityException) {
    Log.w(TAG, "could not read the device name", error)
    null
}
