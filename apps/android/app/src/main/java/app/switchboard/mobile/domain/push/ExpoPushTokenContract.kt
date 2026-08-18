package app.switchboard.mobile.domain.push

import app.switchboard.mobile.protocol.JsonBoolean
import app.switchboard.mobile.protocol.JsonCodec
import app.switchboard.mobile.protocol.JsonObject
import app.switchboard.mobile.protocol.JsonString

data class ExpoPushProjectIdentity(
    val projectId: String,
    val applicationId: String,
)

sealed interface ExpoTokenDecode {
    data class Success(val token: String) : ExpoTokenDecode

    data class Failure(val reason: String) : ExpoTokenDecode
}

object ExpoPushTokenContract {
    const val ENDPOINT = "https://exp.host/--/api/v2/push/getExpoPushToken"

    fun requestBody(
        identity: ExpoPushProjectIdentity,
        installationId: String,
        fcmToken: String,
    ): String = JsonCodec.encode(
        JsonObject(
            linkedMapOf(
                "type" to JsonString("fcm"),
                "deviceId" to JsonString(installationId.lowercase()),
                "development" to JsonBoolean(false),
                "appId" to JsonString(identity.applicationId),
                "deviceToken" to JsonString(fcmToken),
                "projectId" to JsonString(identity.projectId),
            ),
        ),
    )

    fun decodeResponse(body: String): ExpoTokenDecode {
        val token = runCatching {
            val root = JsonCodec.parse(body) as? JsonObject ?: return@runCatching null
            val data = root.values["data"] as? JsonObject ?: return@runCatching null
            (data.values["expoPushToken"] as? JsonString)?.value
        }.getOrNull()
        return if (isExpoPushToken(token)) {
            ExpoTokenDecode.Success(requireNotNull(token))
        } else {
            ExpoTokenDecode.Failure("Expo token response was malformed or rejected")
        }
    }

    fun isExpoPushToken(value: String?): Boolean =
        value?.matches(Regex("^Expo(nent)?PushToken\\[[^]]+]$")) == true
}
