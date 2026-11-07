package app.switchboard.mobile.domain.remote

import app.switchboard.mobile.protocol.JsonNull
import app.switchboard.mobile.protocol.JsonNumber
import app.switchboard.mobile.protocol.JsonObject
import app.switchboard.mobile.protocol.JsonString
import app.switchboard.mobile.protocol.JsonValue

/**
 * A chat row's `bridgeOrigin`, ported from `parseBridgeOriginMarker`,
 * `parseBridgeCheckSummary`, `bridgeOriginLabel` and `bridgeChecksLabel` in
 * src/shared/bridge.ts: the chat was started or messaged through the Instinct
 * bridge, with its last stop state and the measured-check evidence the
 * desktop recorded for it. Absent on other chats and from an older backend;
 * a value it cannot read is dropped. Nothing here is an agent's claim: a
 * check summary comes from a run the desktop observed.
 */
object BridgeOrigin {
    enum class Stop(val wire: String) {
        Pending("pending"),
        Stopped("stopped"),
        Unconfirmed("unconfirmed"),
    }

    /** The four evidence statuses of the bridge contract. */
    enum class EvidenceStatus(val wire: String) {
        Measured("measured"),
        NotMeasured("not_measured"),
        Unavailable("unavailable"),
        Stale("stale"),
    }

    /** What the desktop measured for the chat's configured checks. */
    data class CheckSummary(val status: EvidenceStatus, val passed: Int, val failed: Int)

    /** [stop] is null when no stop came since the chat's last bridge call. */
    data class Marker(val stop: Stop?, val checks: CheckSummary? = null)

    fun of(value: JsonValue?): Marker? {
        val marker = value as? JsonObject ?: return null
        val checks = checksOf(marker.values["checks"])
        return when (val stop = marker.values["stop"]) {
            null, JsonNull -> Marker(null, checks)
            is JsonString -> Stop.entries.firstOrNull { it.wire == stop.value }?.let { Marker(it, checks) }
            else -> null
        }
    }

    private fun checksOf(value: JsonValue?): CheckSummary? {
        val summary = value as? JsonObject ?: return null
        val status = (summary.values["status"] as? JsonString)?.let { text ->
            EvidenceStatus.entries.firstOrNull { it.wire == text.value }
        } ?: return null
        val passed = count(summary.values["passed"]) ?: return null
        val failed = count(summary.values["failed"]) ?: return null
        return CheckSummary(status, passed, failed)
    }

    /** A whole count, never a fraction, a sign or a value an Int cannot hold. */
    private fun count(value: JsonValue?): Int? {
        val number = (value as? JsonNumber)?.source?.toLongOrNull() ?: return null
        return if (number < 0 || number > Int.MAX_VALUE) null else number.toInt()
    }

    fun label(marker: Marker): String = when (marker.stop) {
        Stop.Pending -> "Bridge stop pending"
        Stop.Stopped -> "Bridge stopped"
        Stop.Unconfirmed -> "Bridge stop not confirmed"
        null -> "From the bridge"
    }

    fun checksLabel(summary: CheckSummary): String = when (summary.status) {
        EvidenceStatus.Measured ->
            if (summary.failed > 0) "${plural(summary.failed)} failed" else "${plural(summary.passed)} passed"
        EvidenceStatus.Stale -> "Checks measured on older code"
        EvidenceStatus.Unavailable -> "Checks could not run"
        EvidenceStatus.NotMeasured -> "Checks not measured"
    }

    private fun plural(n: Int): String = "$n check" + if (n == 1) "" else "s"
}
