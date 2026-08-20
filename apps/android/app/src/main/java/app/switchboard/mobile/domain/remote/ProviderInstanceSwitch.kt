package app.switchboard.mobile.domain.remote

import app.switchboard.mobile.protocol.JsonBoolean
import app.switchboard.mobile.protocol.JsonNull
import app.switchboard.mobile.protocol.JsonObject
import app.switchboard.mobile.protocol.JsonString
import app.switchboard.mobile.protocol.JsonValue

data class ProviderInstanceSwitchRequest(
    val targetInstanceId: String,
    val expectedCurrentInstanceId: String?,
)

sealed interface ProviderInstanceSwitchResult {
    data class Success(
        val threadId: String,
        val provider: String,
        val previousInstanceId: String?,
        val instanceId: String,
        val instanceName: String,
        val continuity: String,
    ) : ProviderInstanceSwitchResult

    data class Failure(
        val code: String,
        val message: String,
        val currentInstanceId: String?,
        val rolledBack: Boolean?,
    ) : ProviderInstanceSwitchResult
}

fun decodeProviderInstanceSwitch(value: JsonValue?): ProviderInstanceSwitchResult {
    val body = value as? JsonObject ?: error("Expected profile switch response object")
    return if (body.requiredBoolean("ok")) {
        ProviderInstanceSwitchResult.Success(
            threadId = body.requiredString("threadId"),
            provider = body.requiredString("provider"),
            previousInstanceId = body.optionalString("previousInstanceId"),
            instanceId = body.requiredString("instanceId"),
            instanceName = body.requiredString("instanceName"),
            continuity = body.requiredString("continuity"),
        )
    } else {
        ProviderInstanceSwitchResult.Failure(
            code = body.requiredString("code"),
            message = body.requiredString("message"),
            currentInstanceId = body.optionalString("currentInstanceId"),
            rolledBack = (body.values["rolledBack"] as? JsonBoolean)?.value,
        )
    }
}

private fun JsonObject.requiredString(key: String): String =
    (values[key] as? JsonString)?.value ?: error("Expected profile switch string field: $key")

private fun JsonObject.requiredBoolean(key: String): Boolean =
    (values[key] as? JsonBoolean)?.value ?: error("Expected profile switch boolean field: $key")

private fun JsonObject.optionalString(key: String): String? = when (val value = values[key]) {
    null, JsonNull -> null
    is JsonString -> value.value
    else -> error("Expected nullable profile switch string field: $key")
}
