package app.switchboard.mobile.ui.thread

import app.switchboard.mobile.data.thread.ThreadState
import app.switchboard.mobile.domain.thread.FeedItem
import app.switchboard.mobile.protocol.JsonCodec
import java.io.Serializable
import java.util.Locale

private const val RAW_NOTICE_DIAGNOSTIC_MAX_CHARS = 8_000
private const val RAW_NOTICE_TRUNCATION_MARKER = "… <diagnostic truncated>"

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
    DRIFT,
    SPEND_BLOCKED,
    PEER,
    TODO,
    RAW_NOTICE,
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
        val source: FeedItem.Tool,
        val input: String,
        val output: String?,
    ) : ThreadRowPresentation {
        override val key = source.id
        override val kind = ThreadRowKind.TOOL
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
    ) : ThreadRowPresentation {
        override val key = source.id
        override val kind = ThreadRowKind.FILE_EDIT
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
            rows = thread.feed.map(::row),
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
                "${thread.usedTokens} / $validMaximum tokens"
            }

            thread.usedTokens != null -> "${thread.usedTokens} tokens"
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
        )
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

        is FeedItem.Tool -> ThreadRowPresentation.Tool(
            source = item,
            input = item.input?.let(JsonCodec::encode).orEmpty(),
            output = item.output,
        )

        is FeedItem.Denial -> ThreadRowPresentation.Denial(item)
        is FeedItem.Approval -> ThreadRowPresentation.Approval(item)
        is FeedItem.Retry -> ThreadRowPresentation.Retry(item)
        is FeedItem.Error -> ThreadRowPresentation.Error(item)
        is FeedItem.Plan -> ThreadRowPresentation.Plan(item)
        is FeedItem.Question -> ThreadRowPresentation.Question(item)
        is FeedItem.FileEdit -> {
            val changes = lineChanges(item.oldContent, item.newContent, item.changeKind)
            ThreadRowPresentation.FileEdit(
                source = item,
                relPath = item.relPath,
                addedLines = changes.first,
                removedLines = changes.second,
            )
        }

        is FeedItem.Drift -> ThreadRowPresentation.Drift(item)
        is FeedItem.SpendBlocked -> ThreadRowPresentation.SpendBlocked(item)
        is FeedItem.Peer -> ThreadRowPresentation.Peer(item)
        is FeedItem.Todo -> ThreadRowPresentation.Todo(item)
        is FeedItem.RawNotice -> if (item.eventType == "history.window") {
            ThreadRowPresentation.Notice(
                key = item.id,
                title = "Earlier messages are not shown",
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
                label = "Refreshing history",
                kind = ThreadContentStatusKind.NORMAL,
                showProgress = true,
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

    private fun lineChanges(oldContent: String, newContent: String, changeKind: String): Pair<Int, Int> {
        val oldLines = oldContent.lineList()
        val newLines = newContent.lineList()
        return when (changeKind) {
            "add" -> newLines.size to 0
            "delete" -> 0 to oldLines.size
            else -> {
                val shared = minOf(oldLines.size, newLines.size)
                val replacements = (0 until shared).count { oldLines[it] != newLines[it] }
                val added = replacements + (newLines.size - shared)
                val removed = replacements + (oldLines.size - shared)
                added to removed
            }
        }
    }

    private fun String.lineList(): List<String> = if (isEmpty()) emptyList() else split('\n')
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
}

data class QuestionSelections(
    private val byRequestId: Map<String, List<List<String>>>,
) : Serializable {
    fun forRequest(requestId: String): List<List<String>> = byRequestId[requestId].orEmpty()

    fun with(requestId: String, answers: List<List<String>>): QuestionSelections =
        copy(byRequestId = byRequestId + (requestId to answers))

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
        return state.with(
            item.requestId,
            current.mapIndexed { index, answers ->
                if (index == questionIndex) replacement else answers
            },
        )
    }

    fun canSubmit(state: QuestionSelections, item: FeedItem.Question): Boolean =
        item.answers == null &&
            item.questions.isNotEmpty() &&
            state.forRequest(item.requestId)
                .normalized(item.questions.size)
                .all(List<String>::isNotEmpty)

    private fun List<List<String>>.normalized(size: Int): List<List<String>> =
        List(size) { index -> getOrNull(index).orEmpty() }
}

object ThreadInteractionPolicy {
    fun approval(
        item: FeedItem.Approval,
        decision: ThreadApprovalDecision,
    ): ThreadUiAction.Approval? = if (item.state == "pending") {
        ThreadUiAction.Approval(item.requestId, decision)
    } else {
        null
    }

    fun answer(
        item: FeedItem.Question,
        selections: QuestionSelections,
    ): ThreadUiAction.AnswerQuestion? = if (QuestionSelectionReducer.canSubmit(selections, item)) {
        ThreadUiAction.AnswerQuestion(item.requestId, selections.forRequest(item.requestId))
    } else {
        null
    }

    fun plan(item: FeedItem.Plan, action: ThreadPlanAction): ThreadUiAction.Plan =
        ThreadUiAction.Plan(item.planId, action)

    fun openFile(item: FeedItem.FileEdit): ThreadUiAction.OpenFile =
        ThreadUiAction.OpenFile(item.fileEditId, item.repoRoot, item.relPath)
}
