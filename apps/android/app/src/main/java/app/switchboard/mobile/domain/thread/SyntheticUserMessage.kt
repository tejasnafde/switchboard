package app.switchboard.mobile.domain.thread

/**
 * Kotlin port of src/shared/synthetic-message.ts. Provider CLIs write
 * background-task notifications, interrupt markers and bootstrap context into
 * the transcript with the USER role; only blocks at the FRONT of a user text
 * count, so a prompt that mentions a marker stays a normal message. Keep the
 * block list in step with the TypeScript one.
 */
sealed interface SyntheticPart {
    data class TaskNotification(
        val status: String,
        val summary: String,
        val taskId: String?,
        val outputFile: String?,
    ) : SyntheticPart
    data class Interrupted(val duringToolUse: Boolean) : SyntheticPart
    data class CommandOutput(val text: String, val isError: Boolean) : SyntheticPart
}

enum class SyntheticTone { OK, ERROR, WARN, MUTED }

data class SyntheticSplit(val parts: List<SyntheticPart>, val userText: String)

object SyntheticUserMessage {
    private class Block(
        val start: String,
        val end: String,
        val keepEnd: Boolean = false,
        val part: ((String) -> SyntheticPart?)? = null,
    )

    private fun tag(inner: String, name: String): String? {
        val from = inner.indexOf("<$name>")
        if (from < 0) return null
        val to = inner.indexOf("</$name>", from)
        if (to < 0) return null
        return inner.substring(from + name.length + 2, to).trim().ifEmpty { null }
    }

    private fun commandOutput(isError: Boolean): (String) -> SyntheticPart? = { inner ->
        inner.trim().takeIf { it.isNotEmpty() }?.let { SyntheticPart.CommandOutput(it, isError) }
    }

    private val blocks = listOf(
        Block("<task-notification>", "</task-notification>") { inner ->
            SyntheticPart.TaskNotification(
                status = tag(inner, "status") ?: "completed",
                summary = tag(inner, "summary").orEmpty(),
                taskId = tag(inner, "task-id"),
                outputFile = tag(inner, "output-file"),
            )
        },
        Block("[Request interrupted by user", "]") { inner -> SyntheticPart.Interrupted(inner.contains("tool use")) },
        Block("<turn_aborted>", "</turn_aborted>") { SyntheticPart.Interrupted(false) },
        Block("<local-command-stdout>", "</local-command-stdout>", part = commandOutput(false)),
        Block("<local-command-stderr>", "</local-command-stderr>", part = commandOutput(true)),
        Block("[SYSTEM NOTIFICATION - NOT USER INPUT]", "<task-notification>", keepEnd = true),
        Block("[Your previous response had no visible output", "]"),
        Block("<local-command-caveat>", "</local-command-caveat>"),
        Block("<system-reminder>", "</system-reminder>"),
        Block("<user-prompt-submit-hook>", "</user-prompt-submit-hook>"),
        Block("<recommended_plugins>", "</recommended_plugins>"),
        Block("# AGENTS.md instructions for ", "</INSTRUCTIONS>"),
        Block("<environment_context>", "</environment_context>"),
        Block("<codex_internal_context", "</codex_internal_context>"),
        Block("<skill>", "</skill>"),
    )

    /** Port of `taskNotificationText`: the transcript form of a live task notification. */
    fun taskNotificationText(taskId: String, status: String, summary: String, outputFile: String?): String =
        listOfNotNull(
            "<task-id>$taskId</task-id>",
            outputFile?.let { "<output-file>$it</output-file>" },
            "<status>$status</status>",
            "<summary>$summary</summary>",
        ).joinToString("\n", prefix = "<task-notification>\n", postfix = "\n</task-notification>")

    /** Null when [text] does not start with a generated block, i.e. a real user message. */
    fun split(text: String): SyntheticSplit? {
        var remaining = text.trim()
        val parts = mutableListOf<SyntheticPart>()
        var matched = false
        while (true) {
            val block = blocks.firstOrNull { remaining.startsWith(it.start) } ?: break
            val end = remaining.indexOf(block.end, block.start.length)
            if (end < 0) break
            matched = true
            block.part?.invoke(remaining.substring(block.start.length, end))?.let(parts::add)
            remaining = remaining.substring(if (block.keepEnd) end else end + block.end.length).trimStart()
        }
        return if (matched) SyntheticSplit(parts, remaining) else null
    }

    fun label(part: SyntheticPart): String = when (part) {
        is SyntheticPart.TaskNotification -> {
            val quoted = Regex("\"([^\"]+)\"").find(part.summary)?.groupValues?.get(1)
            val exit = Regex("exit code (\\d+)").find(part.summary)?.groupValues?.get(1)
            val what = quoted ?: part.summary
            val exitSuffix = if (exit != null && exit != "0") " (exit $exit)" else ""
            "Background task ${part.status}${if (what.isNotEmpty()) ": $what" else ""}$exitSuffix"
        }
        is SyntheticPart.Interrupted -> if (part.duringToolUse) "Interrupted during tool use" else "Interrupted"
        is SyntheticPart.CommandOutput -> part.text
    }

    fun detail(part: SyntheticPart): String? {
        if (part !is SyntheticPart.TaskNotification) return null
        return listOfNotNull(
            part.summary.ifEmpty { null },
            part.taskId?.let { "Task: $it" },
            part.outputFile?.let { "Output: $it" },
        ).joinToString("\n").ifEmpty { null }
    }

    fun tone(part: SyntheticPart): SyntheticTone = when (part) {
        is SyntheticPart.TaskNotification -> when (part.status) {
            "completed" -> SyntheticTone.OK
            "failed" -> SyntheticTone.ERROR
            "stopped" -> SyntheticTone.WARN
            else -> SyntheticTone.MUTED
        }
        is SyntheticPart.CommandOutput -> if (part.isError) SyntheticTone.ERROR else SyntheticTone.MUTED
        is SyntheticPart.Interrupted -> SyntheticTone.MUTED
    }
}
