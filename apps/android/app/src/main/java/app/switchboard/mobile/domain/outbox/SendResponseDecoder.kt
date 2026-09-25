package app.switchboard.mobile.domain.outbox

import app.switchboard.mobile.protocol.JsonBoolean
import app.switchboard.mobile.protocol.JsonNull
import app.switchboard.mobile.protocol.JsonObject
import app.switchboard.mobile.protocol.JsonString
import app.switchboard.mobile.protocol.JsonValue

const val ORIGIN_CONFLICT_RECOVERY =
    "This turn's retry identity was already used with different text or images. Send the edit as a new message."

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
            // provider:submit-user-turn answers these as bodies; send-turn threw them.
            accepted == false && state == "conflict" -> SendOutcome.Permanent(ORIGIN_CONFLICT_RECOVERY)
            accepted == false && state == "rejected" -> {
                val message = reason ?: "Backend refused the message"
                if ((raw.values["retryable"] as? JsonBoolean)?.value == true) {
                    SendOutcome.Retryable(message)
                } else {
                    SendOutcome.Permanent(message)
                }
            }
            else -> SendOutcome.Ambiguous(
                "Contradictory or incomplete send response",
                raw,
            )
        }
    }
}
