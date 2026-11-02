package app.switchboard.mobile.domain.remote

import app.switchboard.mobile.protocol.JsonArray
import app.switchboard.mobile.protocol.JsonBoolean
import app.switchboard.mobile.protocol.JsonNull
import app.switchboard.mobile.protocol.JsonNumber
import app.switchboard.mobile.protocol.JsonObject
import app.switchboard.mobile.protocol.JsonString
import app.switchboard.mobile.protocol.JsonValue

/**
 * Settle's rules, ported from src/shared/chat-settle.ts: a Done or idle chat
 * leaves Recents without archiving, with Undo for [UNDO_MS]. Both run
 * tests/fixtures/chat-settle-cases.json.
 */
object ChatSettle {
    const val CAPABILITY = "chat_settle_v1"

    /** How long Undo is offered, as on the desktop. */
    const val UNDO_MS = 8_000L

    /** The snooze a settle ended; its Undo snoozes again with these values and `expectRev`. */
    data class EndedSnooze(val until: Long?, val pr: String?, val rev: Long)

    /** One `app:conversation-settled` broadcast; [prNumber] when a merged PR settled the chat. */
    data class Event(
        val conversationId: String,
        val settledAt: Long?,
        val title: String? = null,
        val prNumber: Int? = null,
        val endedSnooze: EndedSnooze? = null,
    )

    /** A settle Home offers to undo: this phone's own, or a merged PR's from a broadcast. */
    data class Undo(
        val connectionId: String,
        val threadId: String,
        val settledAt: Long,
        val text: String,
        val endedSnooze: EndedSnooze? = null,
    )

    fun noticeText(title: String, prNumber: Int? = null): String =
        if (prNumber == null) "Settled $title" else "Settled $title: PR #$prNumber merged"

    /** Only a merged PR's settle gets a notice here: a client that settles by hand shows its own. */
    fun broadcastNotice(settledAt: Long?, title: String?, prNumber: Int?): String? =
        if (settledAt == null || prNumber == null) null else noticeText(title ?: "Untitled chat", prNumber)

    /** The Undo a broadcast offers, or null. */
    fun undoOf(connectionId: String, event: Event): Undo? {
        val text = broadcastNotice(event.settledAt, event.title, event.prNumber) ?: return null
        return Undo(connectionId, event.conversationId, event.settledAt ?: return null, text, event.endedSnooze)
    }

    /** A Recents row takes Settle when it is Done or idle (the status label, or null). */
    fun canSettleStatus(status: String?): Boolean = status == null || status == "Done"

    /** A broadcast's arguments: the event object first. */
    fun eventOf(args: JsonArray): Event? {
        val raw = args.values.firstOrNull() as? JsonObject ?: return null
        val id = (raw.values["conversationId"] as? JsonString)?.value ?: return null
        val ended = (raw.values["endedSnooze"] as? JsonObject)?.let { snooze ->
            snooze.long("rev")?.let { EndedSnooze(snooze.long("until"), snooze.string("pr"), it) }
        }
        return Event(id, raw.long("settledAt"), raw.string("title"), raw.long("prNumber")?.toInt(), ended)
    }

    /** `app:settle-conversation` and `app:unsettle-conversation` answer `{ ok }`. */
    fun okAnswer(value: JsonValue?): Boolean = ((value as? JsonObject)?.values?.get("ok") as? JsonBoolean)?.value == true

    /** The Undo's snooze: the ended values and the revision, no preset or surface (analytics skip an Undo). */
    fun restoreRequest(ended: EndedSnooze): JsonObject = JsonObject(
        linkedMapOf(
            "until" to (ended.until?.let { JsonNumber(it.toString()) } ?: JsonNull),
            "pr" to (ended.pr?.let(::JsonString) ?: JsonNull),
            "expectRev" to JsonNumber(ended.rev.toString()),
        ),
    )

    private fun JsonObject.long(key: String): Long? =
        (values[key] as? JsonNumber)?.source?.let { it.toLongOrNull() ?: it.toDoubleOrNull()?.toLong() }

    private fun JsonObject.string(key: String): String? = (values[key] as? JsonString)?.value
}
