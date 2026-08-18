package app.switchboard.mobile.domain.outbox

import app.switchboard.mobile.protocol.JsonBoolean
import app.switchboard.mobile.protocol.JsonNull
import app.switchboard.mobile.protocol.JsonObject
import app.switchboard.mobile.protocol.JsonString
import app.switchboard.mobile.protocol.JsonValue

object SendResponseDecoder {
    fun decode(body: JsonValue?): SendOutcome {
        if (body == null || body === JsonNull) {
            return SendOutcome.Accepted(SendReceipt.legacy())
        }
        val raw = body as? JsonObject
            ?: return SendOutcome.Ambiguous("Malformed send response", null)
        val accepted = (raw.values["accepted"] as? JsonBoolean)?.value
        val duplicate = (raw.values["duplicate"] as? JsonBoolean)?.value
        val state = (raw.values["state"] as? JsonString)?.value
        val reason = (raw.values["reason"] as? JsonString)?.value
            ?: (raw.values["error"] as? JsonString)?.value

        return when {
            accepted == true && duplicate != null && state == "completed" ->
                SendOutcome.Accepted(SendReceipt(false, duplicate, raw))
            accepted == false && duplicate != null && state == "pending" ->
                SendOutcome.Pending(reason, raw)
            accepted == false && duplicate != null && state == "ambiguous" ->
                SendOutcome.Ambiguous(reason ?: "Backend could not confirm the turn", raw)
            else -> SendOutcome.Ambiguous(
                "Contradictory or incomplete send response",
                raw,
            )
        }
    }
}
