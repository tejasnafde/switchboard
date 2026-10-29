package app.switchboard.mobile.domain.thread

import app.switchboard.mobile.protocol.JsonObject
import app.switchboard.mobile.protocol.JsonString
import app.switchboard.mobile.protocol.JsonValue

/**
 * An agent asks the user for a secret (`secretRequest` on `request.opened`).
 * The phone only shows it and can decline it; the value is typed on the
 * computer. Port of the phone rules in `src/shared/agent-secret-request.ts`.
 */
data class SecretRequestCard(
    val name: String,
    val title: String,
    val instructions: String,
    /** The payload as it arrived, so the thread snapshot keeps it whole. */
    val raw: JsonObject,
)

sealed interface SecretInstructionPart {
    data class Text(val text: String) : SecretInstructionPart
    data class Host(val host: String, val rest: String) : SecretInstructionPart
}

object SecretRequestCards {
    /** Port of `SECRET_CARD_HEADER`. The agent asked, never Switchboard. */
    const val HEADER = "Asked by the agent in this chat"

    /** Port of `SECRET_PHONE_ANSWER_TEXT`. */
    const val ANSWER_ON_COMPUTER = "Answer this on your computer."

    /** Port of `isSecretCardId`. */
    fun isSecretCard(requestId: String): Boolean = requestId.startsWith("sbsec_")

    /** Null when the value is absent or lacks a field the card shows. */
    fun decode(value: JsonValue?): SecretRequestCard? {
        val raw = value as? JsonObject ?: return null
        fun str(key: String) = (raw.values[key] as? JsonString)?.value
        return SecretRequestCard(
            name = str("name") ?: return null,
            title = str("title") ?: return null,
            instructions = str("instructions") ?: return null,
            raw = raw,
        )
    }

    private val URL = Regex("https?://[^\\s<>\"'`]+")
    private val TRAILING_PUNCTUATION = Regex("[.,;:!?)\\]}]+$")
    private val HOST = Regex("^(?:[A-Za-z0-9-]+\\.)*[A-Za-z0-9-]+(?::\\d{1,5})?$")

    /** Port of `secretInstructionParts`: plain text with each URL's host split out to show bold. */
    fun instructionParts(text: String): List<SecretInstructionPart> {
        val parts = mutableListOf<SecretInstructionPart>()
        fun push(t: String) {
            if (t.isEmpty()) return
            val prev = parts.lastOrNull()
            if (prev is SecretInstructionPart.Text) parts[parts.lastIndex] = SecretInstructionPart.Text(prev.text + t)
            else parts += SecretInstructionPart.Text(t)
        }
        var last = 0
        for (match in URL.findAll(text)) {
            val start = match.range.first
            val raw = match.value.replace(TRAILING_PUNCTUATION, "")
            push(text.substring(last, start))
            last = start + raw.length
            val afterScheme = raw.substring(raw.indexOf("//") + 2)
            val end = afterScheme.indexOfFirst { it == '/' || it == '?' || it == '#' }
            val authority = if (end < 0) afterScheme else afterScheme.substring(0, end)
            val host = authority.substring(authority.lastIndexOf('@') + 1).lowercase()
            if (!HOST.matches(host)) {
                push(raw)
                continue
            }
            parts += SecretInstructionPart.Host(host, if (end < 0) "" else afterScheme.substring(end))
        }
        push(text.substring(last))
        return parts
    }

    /** Port of `secretResultLine`: the one line of a closed card, from its result row. */
    fun resultLine(title: String, outcome: String): String {
        val name = title.removePrefix("Secret ")
        return when (outcome) {
            "done" -> "Saved $name"
            "declined", "dismissed" -> "Declined $name"
            else -> "$name expired"
        }
    }
}
