package app.switchboard.mobile.domain.remote

import app.switchboard.mobile.protocol.JsonNull
import app.switchboard.mobile.protocol.JsonObject
import app.switchboard.mobile.protocol.JsonString
import app.switchboard.mobile.protocol.JsonValue

/**
 * A chat row's `bridgeOrigin`, ported from `parseBridgeOriginMarker` and
 * `bridgeOriginLabel` in src/shared/bridge.ts: the chat was started or
 * messaged through the Instinct bridge, with its last stop state. Absent on
 * other chats and from an older backend; a value it cannot read is dropped.
 */
object BridgeOrigin {
    enum class Stop(val wire: String) {
        Pending("pending"),
        Stopped("stopped"),
        Unconfirmed("unconfirmed"),
    }

    /** [stop] is null when no stop came since the chat's last bridge call. */
    data class Marker(val stop: Stop?)

    fun of(value: JsonValue?): Marker? {
        val marker = value as? JsonObject ?: return null
        return when (val stop = marker.values["stop"]) {
            null, JsonNull -> Marker(null)
            is JsonString -> Stop.entries.firstOrNull { it.wire == stop.value }?.let(::Marker)
            else -> null
        }
    }

    fun label(marker: Marker): String = when (marker.stop) {
        Stop.Pending -> "Bridge stop pending"
        Stop.Stopped -> "Bridge stopped"
        Stop.Unconfirmed -> "Bridge stop not confirmed"
        null -> "From the bridge"
    }
}
