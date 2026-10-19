package app.switchboard.mobile.protocol

/**
 * The `device` object on every `auth` frame (src/shared/device-identity.ts),
 * so the desktop can tell paired phones apart and replace the session an
 * earlier pairing of this phone left behind. An older backend drops it.
 */
data class DeviceIdentityPayload(
    val installId: String,
    val name: String?,
    val manufacturer: String?,
    val model: String?,
    val osVersion: String?,
    val appVersion: String?,
) {
    val platform: String = "android"

    fun toJson(): JsonObject {
        val map = linkedMapOf<String, JsonValue>("installId" to JsonString(installId))
        name?.let { map["name"] = JsonString(it) }
        manufacturer?.let { map["manufacturer"] = JsonString(it) }
        model?.let { map["model"] = JsonString(it) }
        map["platform"] = JsonString(platform)
        osVersion?.let { map["osVersion"] = JsonString(it) }
        appVersion?.let { map["appVersion"] = JsonString(it) }
        return JsonObject(map)
    }

    companion object {
        /** The backend keeps at most this many characters of a display field. */
        const val MAX_FIELD_LENGTH = 128

        /** [deviceName] is the user-visible name where Settings exposes it; the
         *  model stands in when it does not. */
        fun from(
            installId: String,
            deviceName: String?,
            manufacturer: String?,
            model: String?,
            osVersion: String?,
            appVersion: String?,
        ): DeviceIdentityPayload {
            val cleanModel = clean(model)
            return DeviceIdentityPayload(
                installId = installId,
                name = clean(deviceName) ?: cleanModel,
                manufacturer = clean(manufacturer),
                model = cleanModel,
                osVersion = clean(osVersion),
                appVersion = clean(appVersion),
            )
        }

        /** Null without an installId. */
        fun fromJson(json: JsonObject): DeviceIdentityPayload? {
            val installId = json.stringOrNull("installId") ?: return null
            return DeviceIdentityPayload(
                installId = installId,
                name = json.stringOrNull("name"),
                manufacturer = json.stringOrNull("manufacturer"),
                model = json.stringOrNull("model"),
                osVersion = json.stringOrNull("osVersion"),
                appVersion = json.stringOrNull("appVersion"),
            )
        }

        private fun clean(value: String?): String? =
            value?.trim()?.takeIf(String::isNotEmpty)?.take(MAX_FIELD_LENGTH)
    }
}
