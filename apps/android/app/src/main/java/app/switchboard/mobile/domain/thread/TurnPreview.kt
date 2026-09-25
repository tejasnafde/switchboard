package app.switchboard.mobile.domain.thread

/**
 * The conversation list's preview line for a thread's CURRENT TURN. Ported
 * from `src/shared/turn-preview.ts`; keep the two in sync (TurnPreviewTest
 * runs the same cases as tests/unit/turn-preview.test.ts).
 *
 * Claude splits one turn into several assistant messages at tool calls, so
 * every assistant message after the last user message is searched for a
 * digest before falling back to a truncated raw preview of the newest one.
 */
data class PreviewMessage(
    val text: String,
    val isAssistant: Boolean,
    val isUser: Boolean,
)

object TurnPreview {
    private const val RAW_PREVIEW_MAX_LENGTH = 70

    // A fence opens with 3+ backticks or tildes at the start of a line. It closes
    // only at a line holding the same character, at least as many times, and
    // nothing else; an unclosed fence (still streaming) runs to the end.
    private val FENCED_BLOCK = Regex(
        "^[ \\t]{0,3}(`{3,}|~{3,})[^\\n]*\\n[\\s\\S]*?(?:^[ \\t]{0,3}\\1[`~]*[ \\t]*$|(?![\\s\\S]))",
        RegexOption.MULTILINE,
    )
    private val IMAGE = Regex("!\\[([^\\]]*)\\]\\([^)]*\\)")
    private val LINK = Regex("\\[([^\\]]+)\\]\\([^)]*\\)")
    private val INLINE_CODE = Regex("`([^`]*)`")
    private val BOLD = Regex("(\\*\\*|__)(.+?)\\1")
    private val ITALIC = Regex("(^|[^\\w*])[*_]([^*_\\n]+)[*_](?=[^\\w*]|$)")
    private val LINE_MARKER = Regex("^\\s{0,3}(#{1,6}|>|[-*+]|\\d+\\.)\\s+", RegexOption.MULTILINE)
    private val WHITESPACE = Regex("\\s+")

    /**
     * One line of plain text: keeps the words, drops the markup.
     * ponytail: regex pass, not a markdown parser; nested or unusual syntax may
     * leave a stray marker, which is harmless in a truncated one-liner.
     */
    fun plainPreviewText(text: String): String = text
        .replace(FENCED_BLOCK, " ")
        .replace(IMAGE, "$1")
        .replace(LINK, "$1")
        .replace(INLINE_CODE, "$1")
        .replace(BOLD, "$2")
        .replace(ITALIC, "$1$2")
        .replace(LINE_MARKER, "")
        .replace(WHITESPACE, " ")
        .trim()

    fun turnPreviewLine(messages: List<PreviewMessage>): String? {
        val turnStart = messages.indexOfLast(PreviewMessage::isUser) + 1
        val turn = messages.subList(turnStart, messages.size).asReversed()
            .filter { it.isAssistant && it.text.isNotEmpty() }

        // Digest first, newest to oldest: an earlier message may carry it
        // even when the latest one (e.g. mid-tool-call) does not.
        turn.firstNotNullOfOrNull { message ->
            AgentDigest.extractDigest(message.text)?.let(::plainPreviewText)?.takeIf(String::isNotEmpty)
        }?.let { return it }

        // No digest in the turn: a truncated raw preview of the newest message.
        // `streaming = true` always - a preview is approximate anyway, so hiding
        // a still-forming tag at its tail is the safer default.
        return turn.firstNotNullOfOrNull { message ->
            val raw = plainPreviewText(AgentDigest.stripDigest(message.text, streaming = true))
            when {
                raw.isEmpty() -> null
                raw.length > RAW_PREVIEW_MAX_LENGTH -> raw.substring(0, RAW_PREVIEW_MAX_LENGTH - 1) + "…"
                else -> raw
            }
        }
    }
}
