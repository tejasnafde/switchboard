package app.switchboard.mobile.ui.thread

import app.switchboard.mobile.data.thread.ThreadState
import app.switchboard.mobile.domain.thread.FeedItem
import app.switchboard.mobile.domain.thread.EXPIRED_EVENT_TYPE
import app.switchboard.mobile.domain.thread.HostWriteButton
import app.switchboard.mobile.domain.thread.HostWriteCard
import app.switchboard.mobile.domain.thread.HostWriteCards
import app.switchboard.mobile.domain.thread.HostWritePreview
import app.switchboard.mobile.domain.thread.HostWriteResponse
import app.switchboard.mobile.domain.thread.MergeBackRow
import app.switchboard.mobile.domain.thread.PeerUndelivered
import app.switchboard.mobile.domain.thread.SyntheticPart
import app.switchboard.mobile.domain.thread.SyntheticTone
import app.switchboard.mobile.domain.thread.SyntheticUserMessage
import app.switchboard.mobile.domain.thread.SystemMarkers
import app.switchboard.mobile.domain.thread.SystemRowView
import app.switchboard.mobile.protocol.JsonArray
import app.switchboard.mobile.protocol.JsonCodec
import app.switchboard.mobile.protocol.JsonNumber
import app.switchboard.mobile.protocol.JsonObject
import app.switchboard.mobile.protocol.JsonString
import app.switchboard.mobile.protocol.JsonValue
import java.io.Serializable
import java.text.NumberFormat
import java.util.Locale

private const val RAW_NOTICE_DIAGNOSTIC_MAX_CHARS = 8_000
private const val RAW_NOTICE_TRUNCATION_MARKER = "… <diagnostic truncated>"
private const val TOOL_DETAIL_MAX_CHARS = 140

/** Claude `mcp__switchboard__x`, OpenCode `switchboard_x`, Codex `switchboard:x`. */
private val SWITCHBOARD_TOOL = Regex("""(?:mcp__switchboard__|switchboard[_:])(\w+)""")
private val PR_NUMBER = Regex("""#?(\d+)""")
private val PR_URL_NUMBER = Regex("""/(?:pull|pull-requests)/(\d+)""")
private val TOOL_CAMEL_CASE = Regex("([a-z0-9])([A-Z])")
private val TOOL_NAME_SEPARATORS = Regex("[^a-z0-9]+")
private val TOOL_KEY_SEPARATORS = Regex("[^A-Za-z0-9]+")
private val TOOL_WHITESPACE = Regex("\\s+")
private val APPLY_PATCH_FILE = Regex("(?m)^\\*\\*\\* (?:Add|Update|Delete) File: (.+)$")
private val WEB_FETCH_HOST = Regex("^https?://([^/]+)")
private val SHELL_TOOL_NAMES = setOf(
    "bash", "shell", "terminal", "exec", "exec_command", "execute", "execute_command",
    "run_command", "shell_command", "command",
)
private val READ_TOOL_NAMES = setOf("read", "read_file", "readfile", "file_read")
private val WRITE_TOOL_NAMES = setOf("write", "write_file", "writefile", "file_write")
private val EDIT_TOOL_NAMES = setOf("edit", "edit_file", "multiedit", "multi_edit", "apply_patch", "patch")
private val NOTEBOOK_READ_TOOL_NAMES = setOf("notebookread", "notebook_read", "read_notebook")
private val NOTEBOOK_EDIT_TOOL_NAMES = setOf("notebookedit", "notebook_edit", "edit_notebook")
private val GREP_TOOL_NAMES = setOf("grep", "rg", "ripgrep", "search", "search_files", "searchfiles", "file_search")
private val GLOB_TOOL_NAMES = setOf("glob", "file_glob", "find_files")
private val LIST_TOOL_NAMES = setOf("list_files", "listfiles", "ls", "directory_list")
private val WEB_FETCH_TOOL_NAMES = setOf("webfetch", "web_fetch", "fetch", "fetch_url")
private val WEB_SEARCH_TOOL_NAMES = setOf("websearch", "web_search", "search_web")
private val TASK_TOOL_NAMES = setOf("task", "agent", "subagent", "spawn_agent", "delegate")
private val TODO_TOOL_NAMES = setOf("todowrite", "todo_write", "update_plan", "write_todos")
private val FILE_PATH_KEYS = listOf("file_path", "path", "filePath", "notebook_path", "notebookPath")
private val UNKNOWN_TOOL_DETAIL_KEYS = listOf(
    "command" to true,
    "cmd" to true,
    "file_path" to true,
    "path" to true,
    "filePath" to true,
    "pattern" to true,
    "query" to false,
    "url" to true,
    "uri" to true,
    "description" to false,
    "prompt" to false,
)

sealed interface ThreadLoadState {
    data class Loading(val cached: ThreadState? = null) : ThreadLoadState

    data class Ready(
        val thread: ThreadState,
        val cached: Boolean = false,
        val refreshing: Boolean = false,
        val recoveryMessage: String? = null,
    ) : ThreadLoadState

    data class Failed(
        val message: String,
        val cached: ThreadState? = null,
    ) : ThreadLoadState
}

enum class ThreadContentStatusKind {
    NORMAL,
    CACHED,
    ERROR,
}

data class ThreadContentStatus(
    val label: String,
    val kind: ThreadContentStatusKind,
    val detail: String? = null,
    val showProgress: Boolean = false,
    val canRetry: Boolean = false,
)

data class ThreadMetadataPresentation(
    val status: String,
    val runtimeMode: String,
    val provider: String?,
    val instanceName: String?,
    val model: String?,
    val contextLabel: String?,
    val contextFraction: Float?,
    val costLabel: String?,
    val durationLabel: String?,
    val unread: Int,
    /** Raw fields the formatted labels above are built from, needed
     *  unformatted by CompactionOfferPolicy (see ThreadScreen). */
    val usedTokens: Long? = null,
    val lastTurnAt: Long? = null,
)

enum class ThreadRowKind {
    USER,
    ASSISTANT,
    REASONING,
    PLAN_STREAM,
    TOOL,
    DENIAL,
    APPROVAL,
    RETRY,
    ERROR,
    PLAN,
    QUESTION,
    FILE_EDIT,
    FILE_GROUP,
    DRIFT,
    SPEND_BLOCKED,
    PEER,
    PEER_UNDELIVERED,
    TODO,
    RAW_NOTICE,
    SYNTHETIC,
    MERGE_BACK,
}

enum class ToolIconKind {
    SHELL,
    READ,
    WRITE,
    EDIT,
    SEARCH,
    FILES,
    WEB,
    TASK,
    NOTEBOOK,
    TODO,
    OTHER,
}

enum class ToolActivityState {
    RUNNING,
    COMPLETED,
}

sealed interface ThreadRowPresentation {
    val key: String
    val kind: ThreadRowKind

    data class User(val source: FeedItem.User) : ThreadRowPresentation {
        override val key = source.id
        override val kind = ThreadRowKind.USER
    }

    data class Text(
        val source: FeedItem.Text,
        override val kind: ThreadRowKind,
        val durationLabel: String?,
    ) : ThreadRowPresentation {
        override val key = source.id
    }

    data class Tool(
        override val key: String,
        val label: String,
        val detail: String,
        val iconKind: ToolIconKind,
        val monospaceDetail: Boolean,
        val activityState: ToolActivityState,
        val output: String?,
    ) : ThreadRowPresentation {
        override val kind = ThreadRowKind.TOOL
        val hasOutput: Boolean
            get() = activityState == ToolActivityState.COMPLETED && !output.isNullOrBlank()
    }

    data class Denial(val source: FeedItem.Denial) : ThreadRowPresentation {
        override val key = source.id
        override val kind = ThreadRowKind.DENIAL
    }

    data class Approval(val source: FeedItem.Approval) : ThreadRowPresentation {
        override val key = source.id
        override val kind = ThreadRowKind.APPROVAL
    }

    data class Retry(val source: FeedItem.Retry) : ThreadRowPresentation {
        override val key = source.id
        override val kind = ThreadRowKind.RETRY
    }

    data class Error(val source: FeedItem.Error) : ThreadRowPresentation {
        override val key = source.id
        override val kind = ThreadRowKind.ERROR
    }

    data class Plan(val source: FeedItem.Plan) : ThreadRowPresentation {
        override val key = source.id
        override val kind = ThreadRowKind.PLAN
    }

    data class Question(val source: FeedItem.Question) : ThreadRowPresentation {
        override val key = source.id
        override val kind = ThreadRowKind.QUESTION
    }

    data class FileEdit(
        val source: FeedItem.FileEdit,
        val relPath: String,
        val addedLines: Int,
        val removedLines: Int,
        val diff: CompactFileDiff,
    ) : ThreadRowPresentation {
        override val key = source.id
        override val kind = ThreadRowKind.FILE_EDIT
    }

    /** One turn's changed files, folded (see [ThreadFileGroups]). */
    data class FileGroup(
        override val key: String,
        val label: String,
        val addedLines: Int,
        val removedLines: Int,
        val expanded: Boolean,
    ) : ThreadRowPresentation {
        override val kind = ThreadRowKind.FILE_GROUP
    }

    data class Drift(val source: FeedItem.Drift) : ThreadRowPresentation {
        override val key = source.id
        override val kind = ThreadRowKind.DRIFT
    }

    data class SpendBlocked(val source: FeedItem.SpendBlocked) : ThreadRowPresentation {
        override val key = source.id
        override val kind = ThreadRowKind.SPEND_BLOCKED
    }

    data class Peer(val source: FeedItem.Peer) : ThreadRowPresentation {
        override val key = source.id
        override val kind = ThreadRowKind.PEER
    }

    /** A message a session link refused; `messageId` is its stored row, which Send names. */
    data class Undelivered(
        override val key: String,
        val messageId: String,
        val row: PeerUndelivered,
    ) : ThreadRowPresentation {
        override val kind = ThreadRowKind.PEER_UNDELIVERED
    }

    /** A fork's merge-back card in this (parent) chat; `messageId` is its stored row, which Edit/Discard name. */
    data class MergeBack(
        override val key: String,
        val messageId: String,
        val row: MergeBackRow,
    ) : ThreadRowPresentation {
        override val kind = ThreadRowKind.MERGE_BACK
    }

    data class Todo(val source: FeedItem.Todo) : ThreadRowPresentation {
        override val key = source.id
        override val kind = ThreadRowKind.TODO
    }

    data class RawNotice(
        val source: FeedItem.RawNotice,
        val eventType: String,
        val raw: String,
    ) : ThreadRowPresentation {
        override val key = source.id
        override val kind = ThreadRowKind.RAW_NOTICE
    }

    /** A provider-generated user-role block, e.g. a background-task notification. */
    data class Synthetic(
        override val key: String,
        val label: String,
        val detail: String?,
        val tone: SyntheticTone,
        val monospace: Boolean,
    ) : ThreadRowPresentation {
        override val kind = ThreadRowKind.SYNTHETIC
    }

    data class Notice(
        override val key: String,
        val title: String,
        val body: String,
    ) : ThreadRowPresentation {
        override val kind = ThreadRowKind.RAW_NOTICE
    }
}

sealed interface ThreadPresentation {
    data object Loading : ThreadPresentation

    data class Failure(val message: String) : ThreadPresentation

    data class Empty(
        val metadata: ThreadMetadataPresentation,
        val contentStatus: ThreadContentStatus,
    ) : ThreadPresentation

    data class Content(
        val metadata: ThreadMetadataPresentation,
        val contentStatus: ThreadContentStatus,
        val rows: List<ThreadRowPresentation>,
    ) : ThreadPresentation
}

object ThreadPresenter {
    fun present(state: ThreadLoadState): ThreadPresentation {
        val thread = when (state) {
            is ThreadLoadState.Loading -> state.cached
            is ThreadLoadState.Ready -> state.thread
            is ThreadLoadState.Failed -> state.cached
        }
        if (thread == null || thread.feed.isEmpty()) {
            return when (state) {
                is ThreadLoadState.Loading -> ThreadPresentation.Loading
                is ThreadLoadState.Failed -> ThreadPresentation.Failure(state.message)
                is ThreadLoadState.Ready -> ThreadPresentation.Empty(
                    metadata = metadata(state.thread),
                    contentStatus = contentStatus(state),
                )
            }
        }
        return ThreadPresentation.Content(
            metadata = metadata(thread),
            contentStatus = contentStatus(state),
            rows = thread.feed.flatMap(::rows),
        )
    }

    fun metadata(thread: ThreadState): ThreadMetadataPresentation {
        val validMaximum = thread.maxTokens?.takeIf { it > 0 }
        val contextFraction = validMaximum?.let { maximum ->
            ((thread.usedTokens ?: 0).toDouble() / maximum.toDouble())
                .coerceIn(0.0, 1.0)
                .toFloat()
        }
        val contextLabel = when {
            thread.usedTokens != null && validMaximum != null -> {
                "${formatInteger(thread.usedTokens)} / ${formatInteger(validMaximum)} tokens"
            }

            thread.usedTokens != null -> "${formatInteger(thread.usedTokens)} tokens"
            else -> null
        }
        return ThreadMetadataPresentation(
            status = thread.status,
            runtimeMode = thread.runtimeMode,
            provider = thread.provider,
            instanceName = thread.instanceName,
            model = thread.resolvedModel,
            contextLabel = contextLabel,
            contextFraction = contextFraction,
            costLabel = thread.costUsd?.let { String.format(Locale.US, "$%.2f", it) },
            durationLabel = thread.lastTurnDurationMs?.let(::formatDuration),
            unread = thread.unread,
            usedTokens = thread.usedTokens,
            lastTurnAt = thread.lastTurnAt,
        )
    }

    /** Like [row], but splits provider-generated blocks off transcript user text into their own rows. */
    fun rows(item: FeedItem): List<ThreadRowPresentation> {
        if (item !is FeedItem.User || !item.fromTranscript) return listOf(row(item))
        val split = SyntheticUserMessage.split(item.text) ?: return listOf(row(item))
        return buildList {
            split.parts.forEachIndexed { index, part ->
                add(
                    ThreadRowPresentation.Synthetic(
                        key = "${item.id}-s$index",
                        label = SyntheticUserMessage.label(part),
                        detail = SyntheticUserMessage.detail(part),
                        tone = SyntheticUserMessage.tone(part),
                        monospace = part is SyntheticPart.CommandOutput,
                    ),
                )
            }
            if (split.userText.isNotEmpty() || item.images.isNotEmpty()) {
                add(row(item.copy(text = split.userText)))
            }
        }
    }

    fun row(item: FeedItem): ThreadRowPresentation = when (item) {
        is FeedItem.User -> ThreadRowPresentation.User(item)
        is FeedItem.Text -> ThreadRowPresentation.Text(
            source = item,
            kind = when (item.stream) {
                "reasoning" -> ThreadRowKind.REASONING
                "plan" -> ThreadRowKind.PLAN_STREAM
                else -> ThreadRowKind.ASSISTANT
            },
            durationLabel = item.durationMs?.let(::formatDuration),
        )

        is FeedItem.Tool -> {
            val summary = toolSummary(item.toolName, item.input)
            ThreadRowPresentation.Tool(
                key = item.id,
                label = summary.label,
                detail = summary.detail,
                iconKind = summary.iconKind,
                monospaceDetail = summary.monospaceDetail,
                activityState = if (item.state == "running") {
                    ToolActivityState.RUNNING
                } else {
                    ToolActivityState.COMPLETED
                },
                output = item.output,
            )
        }

        is FeedItem.Denial -> ThreadRowPresentation.Denial(item)
        is FeedItem.Approval -> ThreadRowPresentation.Approval(item)
        is FeedItem.Retry -> ThreadRowPresentation.Retry(item)
        is FeedItem.Error -> ThreadRowPresentation.Error(item)
        is FeedItem.Plan -> ThreadRowPresentation.Plan(item)
        is FeedItem.Question -> ThreadRowPresentation.Question(item)
        is FeedItem.FileEdit -> {
            val diff = FileDiffPresenter.present(item.oldContent, item.newContent)
            ThreadRowPresentation.FileEdit(
                source = item,
                relPath = item.relPath,
                addedLines = diff.addedLines,
                removedLines = diff.removedLines,
                diff = diff,
            )
        }

        is FeedItem.Drift -> ThreadRowPresentation.Drift(item)
        is FeedItem.SpendBlocked -> ThreadRowPresentation.SpendBlocked(item)
        is FeedItem.Peer -> ThreadRowPresentation.Peer(item)
        is FeedItem.Todo -> ThreadRowPresentation.Todo(item)
        is FeedItem.RawNotice -> if (item.eventType == SystemMarkers.ROW_EVENT_TYPE) {
            val mergeBackRow = SystemMarkers.mergeBackRow(item.text)
            if (mergeBackRow != null) {
                ThreadRowPresentation.MergeBack(item.id, item.id.removePrefix("h-"), mergeBackRow)
            } else when (val view = SystemMarkers.view(item.text)) {
                is SystemRowView.Undelivered ->
                    ThreadRowPresentation.Undelivered(item.id, item.id.removePrefix("h-"), view.row)
                is SystemRowView.Error -> ThreadRowPresentation.Error(FeedItem.Error(item.id, view.message, null))
                is SystemRowView.Notice -> ThreadRowPresentation.Notice(item.id, view.title, view.body)
            }
        } else if (item.eventType == "history.window") {
            ThreadRowPresentation.Notice(
                key = item.id,
                title = "Earlier messages are not shown",
                body = item.text,
            )
        } else if (item.eventType == EXPIRED_EVENT_TYPE) {
            ThreadRowPresentation.Notice(key = item.id, title = "Expired", body = item.text)
        } else if (item.eventType == "model.unavailable") {
            ThreadRowPresentation.Notice(
                key = item.id,
                title = "Model unavailable",
                body = item.text,
            )
        } else {
            ThreadRowPresentation.RawNotice(
                source = item,
                eventType = item.eventType,
                raw = rawNoticeDiagnostic(item),
            )
        }
    }

    private fun rawNoticeDiagnostic(item: FeedItem.RawNotice): String {
        val encoded = JsonCodec.encode(item.raw)
        if (encoded.length <= RAW_NOTICE_DIAGNOSTIC_MAX_CHARS) return encoded
        return encoded.take(RAW_NOTICE_DIAGNOSTIC_MAX_CHARS - RAW_NOTICE_TRUNCATION_MARKER.length) +
            RAW_NOTICE_TRUNCATION_MARKER
    }

    private data class ToolSummary(
        val label: String,
        val detail: String,
        val iconKind: ToolIconKind,
        val monospaceDetail: Boolean,
    )

    private data class NormalizedToolName(
        val canonical: String,
        val mcpServer: String? = null,
    )

    private fun toolSummary(toolName: String, input: JsonValue?): ToolSummary {
        switchboardToolSummary(toolName, toolValues(input))?.let { return it }
        val normalizedName = normalizedToolName(toolName)
        val canonical = normalizedName.canonical
        val values = toolValues(input)
        fun string(vararg keys: String): String? = keys.firstNotNullOfOrNull { key ->
            (values[key] as? JsonString)?.value?.takeIf(String::isNotBlank)
        }
        fun command(key: String): String? = when (val value = values[key]) {
            is JsonString -> value.value.takeIf(String::isNotBlank)
            is JsonArray -> value.values
                .mapNotNull { (it as? JsonString)?.value?.takeIf(String::isNotBlank) }
                .takeIf(List<String>::isNotEmpty)
                ?.joinToString(" ")
            else -> null
        }

        val summary = when (canonical) {
            in SHELL_TOOL_NAMES -> ToolSummary(
                label = "Terminal",
                detail = listOf("command", "cmd", "args")
                    .firstNotNullOfOrNull(::command)
                    .orEmpty(),
                iconKind = ToolIconKind.SHELL,
                monospaceDetail = true,
            )

            in READ_TOOL_NAMES -> ToolSummary("Read", filePath(values), ToolIconKind.READ, true)
            in WRITE_TOOL_NAMES -> ToolSummary("Write", filePath(values), ToolIconKind.WRITE, true)
            in EDIT_TOOL_NAMES -> {
                // A move/rename carries both the source and destination path -
                // matches src/shared/tool-summary.ts's "Rename" rule.
                val movePath = string("move_path", "movePath")
                if (movePath != null) {
                    ToolSummary(
                        "Rename",
                        "${editPath(canonical, values)} → ${concisePath(movePath)}",
                        ToolIconKind.EDIT,
                        true,
                    )
                } else {
                    ToolSummary("Edit", editPath(canonical, values), ToolIconKind.EDIT, true)
                }
            }
            in NOTEBOOK_READ_TOOL_NAMES -> ToolSummary("Read notebook", filePath(values), ToolIconKind.NOTEBOOK, true)
            in NOTEBOOK_EDIT_TOOL_NAMES -> ToolSummary("Edit notebook", filePath(values), ToolIconKind.NOTEBOOK, true)
            in GREP_TOOL_NAMES -> {
                val pattern = string("pattern", "query", "regex").orEmpty()
                val path = string("path", "dir", "directory")?.let(::concisePath)
                ToolSummary(
                    "Search",
                    if (pattern.isBlank()) "" else pattern + (path?.let { " in $it" } ?: ""),
                    ToolIconKind.SEARCH,
                    true,
                )
            }

            in GLOB_TOOL_NAMES -> ToolSummary(
                "Find files",
                string("pattern", "query", "glob").orEmpty(),
                ToolIconKind.SEARCH,
                true,
            )

            in LIST_TOOL_NAMES -> ToolSummary(
                "List files",
                concisePath(string("path", "dir", "directory").orEmpty()),
                ToolIconKind.FILES,
                true,
            )

            in WEB_FETCH_TOOL_NAMES -> {
                // Host identifies it; a full URL just wraps a narrow row.
                val url = string("url", "uri")
                val host = url?.let(WEB_FETCH_HOST::find)?.groupValues?.getOrNull(1)
                ToolSummary(
                    "Fetch",
                    host ?: url.orEmpty(),
                    ToolIconKind.WEB,
                    false,
                )
            }

            in WEB_SEARCH_TOOL_NAMES -> ToolSummary(
                "Web search",
                string("query", "q").orEmpty(),
                ToolIconKind.WEB,
                false,
            )

            in TASK_TOOL_NAMES -> ToolSummary(
                "Subagent",
                string("description", "prompt", "task").orEmpty(),
                ToolIconKind.TASK,
                false,
            )

            in TODO_TOOL_NAMES -> {
                val count = listOf("todos", "plan", "items")
                    .firstNotNullOfOrNull { key -> (values[key] as? JsonArray)?.values?.size }
                ToolSummary(
                    "Plan",
                    count?.let { "$it ${if (it == 1) "item" else "items"}" }.orEmpty(),
                    ToolIconKind.TODO,
                    false,
                )
            }

            else -> unknownToolSummary(toolName, values)
        }
        val label = normalizedName.mcpServer?.let { server ->
            "${humanizeKey(server)} · ${humanizeKey(canonical)}"
        } ?: summary.label
        return summary.copy(
            label = label,
            detail = condenseToolDetail(summary.detail),
        )
    }

    /**
     * Port of src/shared/tool-summary.ts `summarizeSwitchboardTool`: the
     * Switchboard MCP tools' arguments are Markdown, so each gets an action
     * label and the one field that identifies it.
     */
    private fun switchboardToolSummary(toolName: String, input: Map<String, JsonValue>): ToolSummary? {
        val name = SWITCHBOARD_TOOL.matchEntire(toolName)?.groupValues?.get(1) ?: return null
        // Codex nests an MCP call's arguments (codex-adapter.ts `codexToolInput`).
        val values = if ("arguments" in input) (input["arguments"] as? JsonObject)?.values.orEmpty() else input
        fun string(key: String) = (values[key] as? JsonString)?.value?.takeIf(String::isNotEmpty)
        val pr = prLabel(values["pr"])
        fun withPr(rest: String) = listOf(pr, rest).filter(String::isNotEmpty).joinToString(" · ")
        val (label, detail) = when (name) {
            "create_pull_request" -> "Open pull request" to condenseToolDetail(string("title").orEmpty())
            "reply_to_conversation" -> "Reply" to pr
            "resolve_conversation" -> "Resolve" to pr
            "rerun_check" -> "Re-run check" to pr
            "comment_on_line" -> "Comment on line" to string("path")?.let { path ->
                concisePath(path) + ((values["line"] as? JsonNumber)?.let { ":${it.source}" }.orEmpty())
            }.orEmpty()
            "draft_review" -> "Draft review" to withPr(
                (values["comments"] as? JsonArray)?.values?.size?.takeIf { it > 0 }
                    ?.let { "$it ${if (it == 1) "comment" else "comments"}" }.orEmpty(),
            )
            "get_pr_status" -> "PR status" to pr
            "list_pr_conversations" -> "PR conversations" to pr
            "get_pr_diff" -> "PR diff" to withPr(concisePath(string("path").orEmpty()))
            "send_agent_message" -> "Send to session" to ""
            "list_agent_sessions" -> "List sessions" to ""
            else -> return null
        }
        return ToolSummary(label, detail, ToolIconKind.OTHER, name == "comment_on_line")
    }

    /** "#612" from a number, "612", "#612" or a pull request URL. */
    private fun prLabel(value: JsonValue?): String {
        if (value is JsonNumber) return "#${value.source}"
        val text = (value as? JsonString)?.value?.trim()?.takeIf(String::isNotEmpty) ?: return ""
        val number = PR_NUMBER.matchEntire(text)?.groupValues?.get(1)
            ?: PR_URL_NUMBER.find(text)?.groupValues?.get(1)
        return number?.let { "#$it" } ?: condenseToolDetail(text, 60)
    }

    private fun toolValues(input: JsonValue?): Map<String, JsonValue> = when (input) {
        is JsonObject -> input.values
        is JsonString -> runCatching { JsonCodec.parse(input.value) as? JsonObject }
            .getOrNull()
            ?.values
            .orEmpty()
        else -> emptyMap()
    }

    private fun filePath(values: Map<String, JsonValue>): String =
        FILE_PATH_KEYS
            .firstNotNullOfOrNull { key -> (values[key] as? JsonString)?.value?.takeIf(String::isNotBlank) }
            ?.let(::concisePath)
            .orEmpty()

    private fun editPath(canonical: String, values: Map<String, JsonValue>): String {
        val explicit = filePath(values)
        if (explicit.isNotBlank() || canonical !in setOf("apply_patch", "patch")) return explicit
        val patch = listOf("patch", "input", "diff")
            .firstNotNullOfOrNull { key ->
                (values[key] as? JsonString)?.value?.takeIf(String::isNotBlank)
            }
            .orEmpty()
        val paths = APPLY_PATCH_FILE.findAll(patch).map { it.groupValues[1] }.toList()
        return when (paths.size) {
            0 -> ""
            1 -> concisePath(paths.single())
            else -> "${paths.size} files"
        }
    }

    private fun unknownToolSummary(
        toolName: String,
        values: Map<String, JsonValue>,
    ): ToolSummary {
        val best = UNKNOWN_TOOL_DETAIL_KEYS.firstNotNullOfOrNull { (key, monospace) ->
            (values[key] as? JsonString)?.value?.takeIf(String::isNotBlank)?.let { it to monospace }
        }
        return ToolSummary(
            label = humanizeToolName(toolName),
            detail = best?.first ?: values.keys.joinToString(", ") {
                humanizeKey(it).lowercase(Locale.US)
            },
            iconKind = ToolIconKind.OTHER,
            monospaceDetail = best?.second ?: false,
        )
    }

    private fun normalizedToolName(toolName: String): NormalizedToolName {
        val parts = toolName.split("__")
        val isMcp = parts.size >= 3 && parts.first().equals("mcp", ignoreCase = true)
        return NormalizedToolName(
            canonical = canonicalToolName(if (isMcp) parts.last() else toolName),
            mcpServer = parts.getOrNull(1)?.takeIf { isMcp },
        )
    }

    private fun canonicalToolName(toolName: String): String = toolName
        .replace(TOOL_CAMEL_CASE, "$1_$2")
        .lowercase(Locale.US)
        .replace(TOOL_NAME_SEPARATORS, "_")
        .trim('_')

    private fun humanizeToolName(toolName: String): String =
        humanizeKey(normalizedToolName(toolName).canonical).ifBlank { "Tool" }

    private fun humanizeKey(value: String): String = value
        .replace(TOOL_CAMEL_CASE, "$1 $2")
        .replace(TOOL_KEY_SEPARATORS, " ")
        .trim()
        .lowercase(Locale.US)
        .replaceFirstChar { it.titlecase(Locale.US) }

    private fun condenseToolDetail(detail: String, max: Int = TOOL_DETAIL_MAX_CHARS): String =
        detail.replace(TOOL_WHITESPACE, " ").trim().let { condensed ->
            if (condensed.length <= max) condensed
            else condensed.take(max - 1) + "…"
        }

    /**
     * Last two segments - matches src/shared/tool-summary.ts's shortenPath so
     * a deep path reads the same length on every surface. See
     * tests/fixtures/tool-summary-cases.json.
     */
    private fun concisePath(path: String): String {
        val parts = path.split('/').filter(String::isNotBlank)
        return if (parts.size > 2) "…/${parts.takeLast(2).joinToString("/")}" else path
    }

    private fun contentStatus(state: ThreadLoadState): ThreadContentStatus = when (state) {
        is ThreadLoadState.Loading -> ThreadContentStatus(
            label = "Showing saved messages",
            kind = ThreadContentStatusKind.CACHED,
            showProgress = true,
        )

        is ThreadLoadState.Failed -> ThreadContentStatus(
            label = "Showing saved messages",
            kind = ThreadContentStatusKind.ERROR,
            detail = state.message,
            canRetry = true,
        )

        is ThreadLoadState.Ready -> when {
            state.recoveryMessage != null -> ThreadContentStatus(
                label = if (state.cached) "Showing saved messages" else "Thread loaded",
                kind = ThreadContentStatusKind.ERROR,
                detail = state.recoveryMessage,
                showProgress = state.refreshing || state.thread.awaitingReseed,
                canRetry = true,
            )

            state.cached -> ThreadContentStatus(
                label = "Saved on this device",
                kind = ThreadContentStatusKind.CACHED,
                showProgress = state.refreshing || state.thread.awaitingReseed,
            )

            state.refreshing || state.thread.awaitingReseed -> ThreadContentStatus(
                label = "Thread loaded",
                kind = ThreadContentStatusKind.NORMAL,
            )

            else -> ThreadContentStatus(
                label = "Thread loaded",
                kind = ThreadContentStatusKind.NORMAL,
            )
        }
    }

    private fun formatDuration(durationMs: Long): String =
        if (durationMs < 1_000) {
            "${durationMs}ms"
        } else {
            String.format(Locale.US, "%.1fs", durationMs / 1_000.0)
        }

    private fun formatInteger(value: Long): String =
        NumberFormat.getIntegerInstance(Locale.US).format(value)

}

sealed interface ApprovalActions {
    data object Plain : ApprovalActions
    data class DenyOnly(val card: HostWriteCard) : ApprovalActions
    data class HostWrite(val card: HostWriteCard, val buttons: List<HostWriteButton>, val preview: HostWritePreview) : ApprovalActions
}

enum class ThreadApprovalDecision {
    APPROVE,
    DENY,
}

enum class ThreadPlanAction {
    IMPLEMENT,
    ITERATE,
}

sealed interface ThreadUiAction {
    data class Approval(
        val requestId: String,
        val decision: ThreadApprovalDecision,
        /** An agent's pull request write card: the resolve choice or the review verdict. */
        val response: HostWriteResponse? = null,
    ) : ThreadUiAction

    data class AnswerQuestion(
        val requestId: String,
        val answers: List<List<String>>,
    ) : ThreadUiAction

    data class Plan(
        val planId: String,
        val action: ThreadPlanAction,
    ) : ThreadUiAction

    data class OpenFile(
        val fileEditId: String,
        val repoRoot: String,
        val relPath: String,
    ) : ThreadUiAction

    data class SendUndelivered(
        val messageId: String,
        val targetThreadId: String,
        val text: String,
    ) : ThreadUiAction
}

data class QuestionSelections(
    private val byRequestId: Map<String, List<List<String>>>,
    /** Typed "None of the above" text per question, as on the desktop QuestionCard. */
    private val otherByRequestId: Map<String, List<String>> = emptyMap(),
) : Serializable {
    fun forRequest(requestId: String): List<List<String>> = byRequestId[requestId].orEmpty()

    fun otherFor(requestId: String): List<String> = otherByRequestId[requestId].orEmpty()

    fun with(requestId: String, answers: List<List<String>>): QuestionSelections =
        copy(byRequestId = byRequestId + (requestId to answers))

    fun withOther(requestId: String, texts: List<String>): QuestionSelections =
        copy(otherByRequestId = otherByRequestId + (requestId to texts))

    companion object {
        fun empty(): QuestionSelections = QuestionSelections(emptyMap())
    }
}

object QuestionSelectionReducer {
    fun toggle(
        state: QuestionSelections,
        item: FeedItem.Question,
        questionIndex: Int,
        label: String,
    ): QuestionSelections {
        if (item.answers != null) return state
        val question = item.questions.getOrNull(questionIndex) ?: return state
        if (question.options.none { it.label == label }) return state
        val current = state.forRequest(item.requestId).normalized(item.questions.size)
        val selected = current[questionIndex]
        val replacement = if (question.multiSelect) {
            if (label in selected) selected - label else selected + label
        } else {
            listOf(label)
        }
        // Picking an option clears that question's typed text.
        return state.with(
            item.requestId,
            current.mapIndexed { index, answers ->
                if (index == questionIndex) replacement else answers
            },
        ).withOther(item.requestId, state.otherFor(item.requestId).replaced(item.questions.size, questionIndex, ""))
    }

    /** Typing replaces that question's picks, as the typed text is what gets sent. */
    fun type(
        state: QuestionSelections,
        item: FeedItem.Question,
        questionIndex: Int,
        text: String,
    ): QuestionSelections {
        if (item.answers != null || questionIndex !in item.questions.indices) return state
        val picks = state.forRequest(item.requestId).normalized(item.questions.size)
        return state
            .with(item.requestId, picks.mapIndexed { index, answers -> if (index == questionIndex) emptyList() else answers })
            .withOther(item.requestId, state.otherFor(item.requestId).replaced(item.questions.size, questionIndex, text))
    }

    /** Port of `resolveQuestionAnswers` (src/shared/question-answers.ts): typed text, else the picks in pick order. */
    fun resolved(state: QuestionSelections, item: FeedItem.Question): List<List<String>> {
        val picks = state.forRequest(item.requestId).normalized(item.questions.size)
        val other = state.otherFor(item.requestId)
        return picks.mapIndexed { index, answers ->
            other.getOrNull(index)?.trim()?.takeIf(String::isNotEmpty)?.let(::listOf) ?: answers
        }
    }

    fun canSubmit(state: QuestionSelections, item: FeedItem.Question): Boolean =
        item.answers == null &&
            item.questions.isNotEmpty() &&
            resolved(state, item).all(List<String>::isNotEmpty)

    private fun List<List<String>>.normalized(size: Int): List<List<String>> =
        List(size) { index -> getOrNull(index).orEmpty() }

    private fun List<String>.replaced(size: Int, at: Int, text: String): List<String> =
        List(size) { index -> if (index == at) text else getOrNull(index).orEmpty() }
}

object ThreadInteractionPolicy {
    fun approval(
        item: FeedItem.Approval,
        decision: ThreadApprovalDecision,
        response: HostWriteResponse? = null,
    ): ThreadUiAction.Approval? = if (item.state == "pending") {
        ThreadUiAction.Approval(item.requestId, decision, response)
    } else {
        null
    }

    /**
     * What the phone offers on an approval card. A pull request write an agent
     * asked for is approvable only on a backend that takes a phone's approval
     * ([HostWriteCards.PHONE_APPROVAL_CAPABILITY]); an older one refuses it.
     */
    fun approvalActions(item: FeedItem.Approval, backendTakesPhoneApproval: Boolean): ApprovalActions {
        val card = item.hostWrite ?: return ApprovalActions.Plain
        // A card the phone cannot show in full would post text the user never saw.
        val preview = HostWriteCards.preview(card).takeIf { backendTakesPhoneApproval }
            ?: return ApprovalActions.DenyOnly(card)
        val shown = HostWriteCards.shownDigest(item.requestId, card) ?: return ApprovalActions.DenyOnly(card)
        // Every approval says which draft it showed in full; the backend refuses one that does not.
        val buttons = HostWriteCards.buttons(card).map { it.copy(response = it.response.copy(shown = shown)) }
        return ApprovalActions.HostWrite(card, buttons, preview)
    }

    /** Whether the card offers "Don't wake the agent": one the Switchboard server opened, on a backend that takes it. */
    fun offersQuiet(item: FeedItem.Approval, backendAsyncApproval: Boolean): Boolean =
        backendAsyncApproval && HostWriteCards.isServerCard(item.requestId)

    /** The response an answer sends when the user chose not to wake the agent. */
    fun quietly(response: HostWriteResponse?, quiet: Boolean): HostWriteResponse? =
        if (quiet) (response ?: HostWriteResponse()).copy(quiet = true) else response

    /** A long draft starts collapsed, and nothing is approved until it has been opened. */
    fun hostWriteApprovable(actions: ApprovalActions.HostWrite, expanded: Boolean): Boolean =
        !actions.preview.long || expanded

    fun answer(
        item: FeedItem.Question,
        selections: QuestionSelections,
    ): ThreadUiAction.AnswerQuestion? = if (QuestionSelectionReducer.canSubmit(selections, item)) {
        ThreadUiAction.AnswerQuestion(item.requestId, QuestionSelectionReducer.resolved(selections, item))
    } else {
        null
    }

    fun plan(item: FeedItem.Plan, action: ThreadPlanAction): ThreadUiAction.Plan =
        ThreadUiAction.Plan(item.planId, action)

    fun openFile(item: FeedItem.FileEdit): ThreadUiAction.OpenFile =
        ThreadUiAction.OpenFile(item.fileEditId, item.repoRoot, item.relPath)
}
