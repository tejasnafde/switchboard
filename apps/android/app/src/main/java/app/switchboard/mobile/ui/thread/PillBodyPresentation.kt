package app.switchboard.mobile.ui.thread

import app.switchboard.mobile.domain.thread.MessagePill

sealed interface PillBodySegment {
    data class Text(val value: String) : PillBodySegment
    data class Pill(
        val id: String,
        val label: String,
        val kind: String,
    ) : PillBodySegment
}

object PillBodyPresenter {
    private val token = Regex("\\[\\[pill:([A-Za-z0-9_-]+)]]")

    fun parse(body: String, pills: Map<String, MessagePill>): List<PillBodySegment> {
        if (body.isEmpty()) return emptyList()

        val result = mutableListOf<PillBodySegment>()
        fun appendText(text: String) {
            if (text.isEmpty()) return
            val previous = result.lastOrNull() as? PillBodySegment.Text
            if (previous == null) {
                result += PillBodySegment.Text(text)
            } else {
                result[result.lastIndex] = PillBodySegment.Text(previous.value + text)
            }
        }
        var cursor = 0
        token.findAll(body).forEach { match ->
            if (match.range.first > cursor) {
                appendText(body.substring(cursor, match.range.first))
            }
            pills[match.groupValues[1]]?.let { pill ->
                result += PillBodySegment.Pill(
                    id = match.groupValues[1],
                    label = pill.label,
                    kind = pill.kind,
                )
            }
            cursor = match.range.last + 1
        }
        if (cursor < body.length) {
            appendText(body.substring(cursor))
        }
        return result
    }
}
