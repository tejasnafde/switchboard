package app.switchboard.mobile.domain.thread

import app.switchboard.mobile.protocol.JsonCodec
import app.switchboard.mobile.protocol.JsonObject
import app.switchboard.mobile.protocol.JsonString
import app.switchboard.mobile.protocol.JsonValue

/**
 * Kotlin port of src/shared/subagent-steps.ts. A subagent's work belongs to
 * the Agent/Task call that started it: providers stamp each of its tool calls
 * with that call's id (`parentToolCallId`), and a background task notice
 * names the call that started the task (`toolUseId`). Both run
 * tests/fixtures/subagent-cases.json.
 */
data class SubagentToolCallFact(
    val id: String,
    val name: String,
    val parentToolCallId: String? = null,
)

/** What the grouping needs to know about one feed entry, whatever its shape. */
data class SubagentEntryFacts(
    val toolCalls: List<SubagentToolCallFact> = emptyList(),
    /** A subagent's own text: the call it belongs to. */
    val parentToolCallId: String? = null,
    /** A task notice: the tool call that started the task. */
    val noticeToolUseId: String? = null,
)

data class SubagentGrouping<T>(
    /** Everything that is not a subagent's, in feed order. */
    val topLevel: List<T>,
    /** Each top-level Agent/Task call's steps, in feed order; nested agents flatten into the top one. */
    val stepsByAgent: Map<String, List<T>>,
    /** A background subagent's own notices (it finished, failed or stopped). */
    val completionsByAgent: Map<String, List<T>>,
)

sealed interface SubagentStep {
    val key: String

    data class Tool(
        override val key: String,
        val toolName: String,
        val input: JsonValue?,
        val output: String? = null,
        val isError: Boolean = false,
    ) : SubagentStep

    data class Notice(override val key: String, val part: SyntheticPart.TaskNotification) : SubagentStep

    data class Text(override val key: String, val text: String) : SubagentStep
}

sealed interface SubagentDisplayItem {
    val key: String

    /** [failed] marks the step the agent failed on; its output is shown open. */
    data class Step(val step: SubagentStep, val failed: Boolean = false) : SubagentDisplayItem {
        override val key: String get() = step.key
    }

    /** A long middle run, folded: "N more steps". */
    data class More(override val key: String, val label: String, val steps: List<SubagentStep>) : SubagentDisplayItem

    /** Consecutive notices, folded: "N background tasks completed". */
    data class Notices(override val key: String, val label: String, val steps: List<SubagentStep.Notice>) : SubagentDisplayItem
}

data class SubagentCall(
    val input: JsonValue?,
    val output: String? = null,
    val isError: Boolean = false,
    /** When the call started, for a background agent's duration. */
    val startedAt: Long? = null,
)

data class SubagentCompletion(val part: SyntheticPart.TaskNotification, val at: Long? = null)

enum class SubagentStatus { RUNNING, DONE, FAILED }

data class SubagentView(
    val description: String,
    /** The model the call asked for ("haiku"), when it named one. */
    val model: String?,
    val status: SubagentStatus,
    val stepCount: Int,
    /** Running: what the latest step is doing. */
    val currentStep: String?,
    /** Failed: why, in one line. */
    val failureReason: String?,
    val durationMs: Long?,
    /** Done: the subagent's final report. */
    val result: String?,
    val items: List<SubagentDisplayItem>,
)

data class SubagentStatusParts(
    /** "Step 7", "Done" or "Failed". */
    val lead: String,
    /** The running step, or the failure reason. */
    val detail: String?,
    /** Step count and duration. */
    val meta: List<String>,
)

/** How a tool step reads in one line; the presenter's tool summary (`summarizeTool` in TS). */
typealias SubagentToolLabel = (toolName: String, input: JsonValue?) -> String

object SubagentSteps {
    /** Fewer middle steps than this stay visible; folding two saves nothing. */
    private const val MIN_FOLD = 3

    private val ASYNC_LAUNCH = Regex("^Async agent launched")
    private val AGENT_TRAILER =
        Regex("(?:^|\\n)agentId: \\S+[^\\n]*(?:\\n<usage>[\\s\\S]*?</usage>)?\\s*$")
    private val TOOL_ERROR_TAGS = Regex("</?tool_use_error>")
    private val USAGE = Regex("<usage>([\\s\\S]*?)</usage>")
    private val FAILED_AFTER = Regex("failed:?\\s*(.*)$", RegexOption.DOT_MATCHES_ALL)

    fun isSubagentToolName(name: String): Boolean {
        val key = name.lowercase()
        return key == "agent" || key == "task"
    }

    /**
     * Split a feed into its top level and each agent's steps. An entry whose
     * agent is not in the feed (a history window that starts after the Agent
     * call) stays at the top level, as it was before grouping existed.
     */
    fun <T> group(entries: List<T>, facts: (T) -> SubagentEntryFacts): SubagentGrouping<T> {
        val known = entries.map(facts)
        val callName = mutableMapOf<String, String>()
        val callParent = mutableMapOf<String, String?>()
        for (fact in known) {
            for (call in fact.toolCalls) {
                callName[call.id] = call.name
                callParent[call.id] = call.parentToolCallId ?: fact.parentToolCallId
            }
        }
        // The topmost agent at or above `start` among the calls in the feed.
        fun rootAgent(start: String?): String? {
            var root: String? = null
            val seen = mutableSetOf<String>()
            var id = start
            while (id != null && id in callName && seen.add(id)) {
                if (isSubagentToolName(callName.getValue(id))) root = id
                id = callParent[id]
            }
            return root
        }

        val topLevel = mutableListOf<T>()
        val steps = linkedMapOf<String, MutableList<T>>()
        val completions = linkedMapOf<String, MutableList<T>>()
        entries.forEachIndexed { index, entry ->
            val fact = known[index]
            val notice = fact.noticeToolUseId
            if (notice != null) {
                val root = rootAgent(notice)
                when {
                    root == notice -> completions.getOrPut(root) { mutableListOf() } += entry
                    root != null -> steps.getOrPut(root) { mutableListOf() } += entry
                    else -> topLevel += entry
                }
                return@forEachIndexed
            }
            val parent = fact.parentToolCallId
                ?: fact.toolCalls.firstOrNull { it.parentToolCallId != null }?.parentToolCallId
            val root = rootAgent(parent)
            if (root != null) steps.getOrPut(root) { mutableListOf() } += entry else topLevel += entry
        }
        return SubagentGrouping(topLevel, steps, completions)
    }

    /** The report a finished call returned, without the agent id and usage the CLI appends. */
    fun resultText(output: String): String = output.replaceFirst(AGENT_TRAILER, "").trim()

    fun stepLabel(step: SubagentStep, toolLabel: SubagentToolLabel): String = when (step) {
        is SubagentStep.Tool -> toolLabel(step.toolName, step.input)
        is SubagentStep.Notice -> SyntheticUserMessage.backgroundTaskLabel(step.part.summary)
        is SubagentStep.Text -> SyntheticUserMessage.cutLabel(firstLine(step.text))
    }

    /**
     * The rows under an expanded agent: consecutive notices fold into one, the
     * first and last steps stay, and a middle run of [MIN_FOLD] or more plain
     * steps folds into "N more steps". The failed step is never folded.
     */
    fun displayItems(steps: List<SubagentStep>, failedKey: String? = null): List<SubagentDisplayItem> {
        val units = mutableListOf<SubagentDisplayItem>()
        for (step in steps) {
            val previous = units.lastOrNull()
            if (step is SubagentStep.Notice) {
                if (previous is SubagentDisplayItem.Notices) {
                    val group = previous.steps + step
                    units[units.lastIndex] = previous.copy(label = noticeGroupLabel(group), steps = group)
                    continue
                }
                if (previous is SubagentDisplayItem.Step && previous.step is SubagentStep.Notice) {
                    val group = listOf(previous.step, step)
                    units[units.lastIndex] = SubagentDisplayItem.Notices(previous.step.key, noticeGroupLabel(group), group)
                    continue
                }
            }
            units += SubagentDisplayItem.Step(step, failed = step.key == failedKey)
        }

        val items = mutableListOf<SubagentDisplayItem>()
        var run = mutableListOf<SubagentStep>()
        fun flush() {
            if (run.size >= MIN_FOLD) {
                items += SubagentDisplayItem.More("more:${run.first().key}", "${run.size} more steps", run)
            } else {
                run.forEach { items += SubagentDisplayItem.Step(it) }
            }
            run = mutableListOf()
        }
        units.forEachIndexed { index, unit ->
            val middle = index > 0 && index < units.lastIndex
            if (middle && unit is SubagentDisplayItem.Step && !unit.failed && unit.step !is SubagentStep.Notice) {
                run += unit.step
                return@forEachIndexed
            }
            flush()
            items += unit
        }
        flush()
        return items
    }

    /**
     * The row for one Agent/Task call. Its status comes from the call's result
     * (an error result is a failure), else, for a background agent whose result
     * is only the launch notice, from its last completion notice.
     */
    fun view(
        call: SubagentCall,
        steps: List<SubagentStep>,
        completions: List<SubagentCompletion> = emptyList(),
        toolLabel: SubagentToolLabel,
    ): SubagentView {
        val input = inputValues(call.input)
        val prompt = str(input["prompt"])
        val description = str(input["description"])
            ?: prompt?.let { SyntheticUserMessage.cutLabel(firstLine(it)) }
            ?: "Subagent"
        val output = call.output
        val launched = output != null && ASYNC_LAUNCH.containsMatchIn(output)
        val completion = completions.lastOrNull()

        var status = SubagentStatus.RUNNING
        var failureReason: String? = null
        var result: String? = null
        if (call.isError) {
            status = SubagentStatus.FAILED
            failureReason = SyntheticUserMessage.cutLabel(
                firstLine(output.orEmpty().replace(TOOL_ERROR_TAGS, "")).ifEmpty { "Failed" },
            )
        } else if (output != null && !launched) {
            status = SubagentStatus.DONE
            result = resultText(output).ifEmpty { null }
        } else if (completion != null) {
            status = if (completion.part.status == "completed") SubagentStatus.DONE else SubagentStatus.FAILED
            if (status == SubagentStatus.FAILED) failureReason = completionReason(completion.part)
            else result = completion.part.result
        }

        val failedKey = if (status == SubagentStatus.FAILED) {
            steps.lastOrNull { it is SubagentStep.Tool && it.isError }?.key
        } else {
            null
        }
        val usageSource = if (output != null && !launched) output else null
        val usageDuration = usageSource?.let { usageNumber(it, "duration_ms") }
        val completedAt = if (status != SubagentStatus.RUNNING && usageSource.isNullOrEmpty()) completion?.at else null
        val startedAt = call.startedAt
        val durationMs = usageDuration
            ?: if (completedAt != null && startedAt != null && completedAt > startedAt) completedAt - startedAt else null
        val last = steps.lastOrNull()
        val stepCount = steps.size.takeIf { it > 0 }
            ?: usageSource?.let { usageNumber(it, "tool_uses") }?.toInt()?.takeIf { it > 0 }
            ?: 0
        return SubagentView(
            description = description,
            model = str(input["model"]),
            status = status,
            stepCount = stepCount,
            currentStep = if (status == SubagentStatus.RUNNING && last != null) stepLabel(last, toolLabel) else null,
            failureReason = failureReason?.ifEmpty { null },
            durationMs = durationMs,
            result = result?.ifEmpty { null },
            items = displayItems(steps, failedKey),
        )
    }

    /** "42s", "6m 02s", "1h 05m". */
    fun formatDuration(ms: Long): String {
        val seconds = Math.round(ms / 1000.0).coerceAtLeast(0)
        if (seconds < 60) return "${seconds}s"
        fun pad(n: Long) = n.toString().padStart(2, '0')
        if (seconds < 3600) return "${seconds / 60}m ${pad(seconds % 60)}s"
        return "${seconds / 3600}h ${pad((seconds % 3600) / 60)}m"
    }

    fun statusParts(view: SubagentView): SubagentStatusParts {
        val steps = "${view.stepCount} ${if (view.stepCount == 1) "step" else "steps"}"
        if (view.status == SubagentStatus.RUNNING) {
            return SubagentStatusParts(
                lead = if (view.stepCount > 0) "Step ${view.stepCount}" else "Starting",
                detail = view.currentStep,
                meta = emptyList(),
            )
        }
        val meta = if (view.stepCount > 0) listOf(steps) else emptyList()
        if (view.status == SubagentStatus.FAILED) return SubagentStatusParts("Failed", view.failureReason, meta)
        return SubagentStatusParts(
            lead = "Done",
            detail = null,
            meta = view.durationMs?.let { meta + formatDuration(it) } ?: meta,
        )
    }

    /** The status as one line: "Step 7 · npx vitest", "Done · 14 steps · 6m 02s". */
    fun statusText(view: SubagentView): String {
        val parts = statusParts(view)
        return (listOf(parts.lead, parts.detail) + parts.meta).filterNot { it.isNullOrEmpty() }.joinToString(" · ")
    }

    private fun noticeGroupLabel(steps: List<SubagentStep.Notice>): String {
        val failed = steps.count { it.part.status == "failed" }
        if (failed > 0) return "${steps.size} background tasks, $failed failed"
        val allCompleted = steps.all { it.part.status == "completed" }
        return "${steps.size} background tasks ${if (allCompleted) "completed" else "finished"}"
    }

    private fun completionReason(part: SyntheticPart.TaskNotification): String {
        if (part.status != "failed") return "Stopped"
        val after = FAILED_AFTER.find(part.summary)?.groupValues?.get(1)
        return SyntheticUserMessage.cutLabel(firstLine(after?.ifEmpty { null } ?: part.summary).ifEmpty { "Failed" })
    }

    private fun usageNumber(output: String, field: String): Long? {
        val usage = USAGE.find(output)?.groupValues?.get(1) ?: return null
        return Regex("$field:\\s*(\\d+)").find(usage)?.groupValues?.get(1)?.toLongOrNull()
    }

    private fun firstLine(text: String): String = text.split('\n').firstOrNull { it.isNotBlank() }?.trim().orEmpty()

    private fun str(value: JsonValue?): String? = (value as? JsonString)?.value?.trim()?.ifEmpty { null }

    /** History tool input can arrive as JSON text; a non-object input has no fields. */
    private fun inputValues(input: JsonValue?): Map<String, JsonValue> = when (input) {
        is JsonObject -> input.values
        is JsonString -> (runCatching { JsonCodec.parse(input.value) }.getOrNull() as? JsonObject)?.values.orEmpty()
        else -> emptyMap()
    }
}
