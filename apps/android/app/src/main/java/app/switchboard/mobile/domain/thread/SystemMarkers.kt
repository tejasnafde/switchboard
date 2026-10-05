package app.switchboard.mobile.domain.thread

import app.switchboard.mobile.protocol.JsonBoolean
import app.switchboard.mobile.protocol.JsonCodec
import app.switchboard.mobile.protocol.JsonObject
import app.switchboard.mobile.protocol.JsonString

/** A message a session link refused, kept in the sender's chat (`[[sb:peer-undelivered]]`). */
data class PeerUndelivered(
    val to: String,
    val toLabel: String,
    val reason: String,
    val text: String,
    val sent: Boolean,
)

sealed interface SystemRowView {
    data class Undelivered(val row: PeerUndelivered) : SystemRowView
    data class Error(val message: String) : SystemRowView
    data class Notice(val title: String, val body: String) : SystemRowView
}

/**
 * Port of src/shared/system-markers.ts: how a stored system row shows. Both
 * suites run tests/fixtures/system-marker-cases.json.
 */
object SystemMarkers {
    const val PREFIX = "[[sb:"
    /** A stored system row in the feed: a `FeedItem.RawNotice` of this type, from history or a live event. */
    const val ROW_EVENT_TYPE = "history.system"
    const val UNKNOWN_TITLE = "Switchboard notice"
    private const val UNDELIVERED_PREFIX = "[[sb:peer-undelivered]]"
    private const val APPROVAL_RESULT_PREFIX = "[[sb:approval-result]]"
    private const val HANDOFF_PREFIX = "[[sb:context-handoff]]"

    private val REASONS = setOf("link-budget", "link-expired", "link-removed")
    private val OUTCOME_LABELS = mapOf(
        "done" to "Done",
        "failed" to "Failed",
        "declined" to "Declined",
        "dismissed" to "Dismissed",
        "withdrawn" to "Withdrawn by the agent",
        "stopped" to "Closed with the session",
    )
    private val DELIVERY_LABELS = mapOf(
        "none" to "",
        "turn" to "Sent to the agent",
        "queue" to "Sent to the agent after its current turn",
        "hold" to "The agent hears about it when the chat runs again",
    )

    // No prefix may be a prefix of another; the two peer ones differ before "]]".
    private val ROTATION_PREFIXES = listOf(
        "[[sb:instance-rotated]]" to "instance",
        "[[sb:agent-switched]]" to "agent",
        HANDOFF_PREFIX to "handoff",
        "[[sb:peer-sent]]" to "peer",
        "[[sb:peer-sent-agent]]" to "peer-agent",
    )

    fun view(content: String): SystemRowView {
        undelivered(content)?.let { return SystemRowView.Undelivered(it) }
        approvalResult(content)?.let { return it }
        rotation(content)?.let { return SystemRowView.Notice(it, "") }
        if (content.startsWith(HANDOFF_PREFIX)) {
            return SystemRowView.Notice("Context handoff", content.removePrefix(HANDOFF_PREFIX).trim())
        }
        // A newer marker, or a known one whose payload did not parse: never its JSON.
        if (content.startsWith(PREFIX)) return SystemRowView.Notice(UNKNOWN_TITLE, "")
        if (content.startsWith("error:", ignoreCase = true)) return SystemRowView.Error(content)
        return SystemRowView.Notice(UNKNOWN_TITLE, content)
    }

    fun reasonText(reason: String): String = when (reason) {
        "link-expired" -> "The link's time ran out."
        "link-removed" -> "The link was removed before it was sent."
        else -> "The link's message budget was spent."
    }

    fun undeliveredHeading(row: PeerUndelivered): String =
        if (row.sent) "Sent by you to ${row.toLabel} after the link ran out" else "Not delivered to ${row.toLabel}"

    /** The stored row for a live `peer.undelivered` event, so it renders like the history row. */
    fun undeliveredMarker(row: PeerUndelivered): String = "$UNDELIVERED_PREFIX " + JsonCodec.encode(
        JsonObject(
            linkedMapOf(
                "to" to JsonString(row.to),
                "toLabel" to JsonString(row.toLabel),
                "reason" to JsonString(row.reason),
                "text" to JsonString(row.text),
                "sent" to JsonBoolean(row.sent),
            ),
        ),
    )

    fun undelivered(content: String): PeerUndelivered? {
        val raw = payload(content, UNDELIVERED_PREFIX) ?: return null
        val to = raw.str("to") ?: return null
        val toLabel = raw.str("toLabel") ?: return null
        val text = raw.str("text") ?: return null
        val reason = raw.str("reason")?.takeIf { it in REASONS } ?: return null
        return PeerUndelivered(to, toLabel, reason, text, (raw.values["sent"] as? JsonBoolean)?.value == true)
    }

    private fun approvalResult(content: String): SystemRowView.Notice? {
        val raw = payload(content, APPROVAL_RESULT_PREFIX) ?: return null
        if (raw.str("requestId") == null) return null
        val title = raw.str("title") ?: return null
        val text = raw.str("text") ?: return null
        val outcome = OUTCOME_LABELS[raw.str("outcome")] ?: return null
        val delivery = DELIVERY_LABELS[raw.str("delivery")] ?: return null
        return SystemRowView.Notice(listOf(title, outcome, delivery).filter(String::isNotEmpty).joinToString(" · "), text)
    }

    private fun rotation(content: String): String? {
        val (prefix, kind) = ROTATION_PREFIXES.firstOrNull { content.startsWith(it.first) } ?: return null
        val rest = content.removePrefix(prefix).trim()
        // Tolerate '->' for hand-edited rows, like the desktop.
        val arrow = if ("→" in rest) "→" else if ("->" in rest) "->" else return null
        val parts = rest.split(arrow).map(String::trim)
        val from = parts[0]
        val to = parts[1]
        if (from.isEmpty() || to.isEmpty()) return null
        return when (kind) {
            "agent" -> "Switched agent: $from → $to"
            "handoff" -> "Context handoff: $from → $to"
            "peer" -> "Sent to $to"
            "peer-agent" -> "The agent messaged $to"
            else -> "Switched profile: $from → $to"
        }
    }

    private fun payload(content: String, prefix: String): JsonObject? {
        if (!content.startsWith(prefix)) return null
        // A hand-edited or truncated row falls through to the neutral notice.
        return runCatching { JsonCodec.parse(content.removePrefix(prefix).trim()) as? JsonObject }.getOrNull()
    }

    private fun JsonObject.str(key: String): String? = (values[key] as? JsonString)?.value
}
