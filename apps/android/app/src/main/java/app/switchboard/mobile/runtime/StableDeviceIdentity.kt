package app.switchboard.mobile.runtime

import android.content.Context
import java.util.UUID

data class StableDeviceIdentity(
    val deviceId: String,
    val deviceLabel: String,
)

interface DeviceIdentityStorage {
    fun read(): String?

    fun write(deviceId: String)
}

class SharedPreferencesDeviceIdentityStorage(
    context: Context,
) : DeviceIdentityStorage {
    private val preferences = context.applicationContext.getSharedPreferences(
        PREFERENCES_NAME,
        Context.MODE_PRIVATE,
    )

    override fun read(): String? = preferences.getString(DEVICE_ID_KEY, null)

    override fun write(deviceId: String) {
        check(preferences.edit().putString(DEVICE_ID_KEY, deviceId).commit()) {
            "device identity could not be persisted"
        }
    }

    private companion object {
        const val PREFERENCES_NAME = "switchboard-install-identity"
        const val DEVICE_ID_KEY = "device-id"
    }
}

class StableDeviceIdentityProvider(
    private val storage: DeviceIdentityStorage,
    private val idSource: () -> String = { UUID.randomUUID().toString() },
    private val label: String = "Switchboard Android",
) {
    private var cached: StableDeviceIdentity? = null

    @Synchronized
    fun get(): StableDeviceIdentity {
        cached?.let { return it }
        val persisted = storage.read()?.takeIf(String::isNotBlank)
        val deviceId = persisted ?: idSource().takeIf(String::isNotBlank)?.also(storage::write)
            ?: error("device identity source returned a blank value")
        return StableDeviceIdentity(deviceId, label).also { cached = it }
    }
}
