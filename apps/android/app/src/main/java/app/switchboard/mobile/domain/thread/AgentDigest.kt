package app.switchboard.mobile.domain.thread

/**
 * Agent digest: a one-line status the agent reports mid-reply, wrapped in
 * `<agent_digest>...</agent_digest>`. Ported from `src/shared/agent-digest.ts`
 * - keep the two in sync. `extractDigest` drives the conversation-list
 * preview (see `BrowseModels.kt` / `BrowseRowPolicy`), `stripDigest` removes
 * the tag(s) from the text shown in the transcript itself (see
 * `ThreadScreen.kt`'s `TextRow`).
 *
 * The raw message text is stored unchanged - both functions only run at
 * render time.
 */
object AgentDigest {
    private const val OPEN_TAG = "<agent_digest>"
    private const val MAX_DIGEST_LENGTH = 120

    private val TAG_PATTERN = Regex("<agent_digest>([\\s\\S]*?)</agent_digest>")

    /**
     * Returns the LAST complete `<agent_digest>...</agent_digest>` in [text],
     * trimmed and capped at ~120 chars. `null` when no complete tag with
     * non-empty content is present (an in-progress, unclosed tag never
     * counts - its content is not final yet).
     */
    fun extractDigest(text: String): String? {
        if (text.isEmpty()) return null
        var last: String? = null
        for (match in TAG_PATTERN.findAll(text)) {
            val inner = match.groupValues[1].trim()
            if (inner.isNotEmpty()) last = inner
        }
        val found = last ?: return null
        return if (found.length > MAX_DIGEST_LENGTH) {
            found.substring(0, MAX_DIGEST_LENGTH - 1) + "…"
        } else {
            found
        }
    }

    /**
     * Longest suffix of [text] that is also a non-empty prefix of
     * [OPEN_TAG], e.g. "hello <agent_di" -> "<agent_di" (length 9). Used to
     * hide a tag while it is still streaming in, character by character.
     */
    private fun trailingPartialOpenTagLength(text: String): Int {
        val maxLen = minOf(text.length, OPEN_TAG.length - 1)
        for (len in maxLen downTo 1) {
            if (text.endsWith(OPEN_TAG.substring(0, len))) return len
        }
        return 0
    }

    /**
     * Removes every complete `<agent_digest>...</agent_digest>` tag from
     * [text]. Also hides a trailing PARTIAL tag so it never flashes on
     * screen mid-stream: an unclosed `<agent_digest>...` (with or without a
     * partial `</agent_dig` close in progress), or a bare prefix of the open
     * tag itself such as `<agent_di`.
     *
     * Known tradeoff: a message whose final character happens to be a lone
     * `<` (or another short prefix of the open tag) that is genuinely part
     * of the message, not a digest tag, is trimmed too. This only affects
     * the last few characters of a full message and is the standard cost of
     * streaming-safe tag hiding.
     */
    fun stripDigest(text: String): String {
        if (text.isEmpty()) return text
        val withoutComplete = TAG_PATTERN.replace(text, "")
        val openIdx = withoutComplete.indexOf(OPEN_TAG)
        if (openIdx != -1) {
            // An open tag with no matching close anywhere after it - the
            // rest of the text (body plus any partial close tag) is still
            // streaming in.
            return withoutComplete.substring(0, openIdx)
        }
        val partialLen = trailingPartialOpenTagLength(withoutComplete)
        return if (partialLen > 0) {
            withoutComplete.substring(0, withoutComplete.length - partialLen)
        } else {
            withoutComplete
        }
    }
}
