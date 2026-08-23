package app.switchboard.mobile.ui.browse

import app.switchboard.mobile.data.local.OfflineSnapshot
import app.switchboard.mobile.domain.remote.BrowseDecisions
import app.switchboard.mobile.domain.remote.Conversation
import app.switchboard.mobile.domain.remote.Project
import app.switchboard.mobile.domain.remote.SessionSummary
import app.switchboard.mobile.domain.remote.Workspace
import java.io.Serializable
import java.util.Locale

sealed interface BrowseRoute : Serializable {
    data object Projects : BrowseRoute

    data class Conversations(
        val projectPath: String,
        val projectName: String,
    ) : BrowseRoute
}

@ConsistentCopyVisibility
data class BrowseNavigationState private constructor(
    private val backStack: List<BrowseRoute>,
) : Serializable {
    init {
        require(backStack.isNotEmpty()) { "Browse navigation stack cannot be empty" }
        require(backStack.first() == BrowseRoute.Projects) {
            "Browse navigation must start at Projects"
        }
    }

    val current: BrowseRoute
        get() = backStack.last()

    val canGoBack: Boolean
        get() = backStack.size > 1

    fun openProject(projectPath: String, projectName: String): BrowseNavigationState = copy(
        backStack = backStack + BrowseRoute.Conversations(projectPath, projectName),
    )

    fun back(): BrowseNavigationState =
        if (canGoBack) copy(backStack = backStack.dropLast(1)) else this

    companion object {
        fun root(): BrowseNavigationState = BrowseNavigationState(listOf(BrowseRoute.Projects))
    }
}

sealed interface BrowseLoadState<out T> {
    data class Loading<T>(val cached: List<T> = emptyList()) : BrowseLoadState<T>

    data class Ready<T>(
        val items: List<T>,
        val cached: Boolean = false,
        val refreshing: Boolean = false,
        val recoveryMessage: String? = null,
    ) : BrowseLoadState<T>

    data class Failed<T>(
        val message: String,
        val cached: List<T> = emptyList(),
    ) : BrowseLoadState<T>
}

data class BrowseProjectRecord(
    val project: Project,
    val archivedSessionIds: Set<String> = emptySet(),
)

data class BrowseConversationRecord(
    val conversation: Conversation,
    val archived: Boolean = false,
)

data class BrowseState(
    val connectionId: String,
    val connectionLabel: String,
    val offlineSnapshot: OfflineSnapshot,
    val projects: BrowseLoadState<BrowseProjectRecord>,
    val workspaces: BrowseLoadState<Workspace> = BrowseLoadState.Loading(),
    val conversationsByProject: Map<String, BrowseLoadState<BrowseConversationRecord>> = emptyMap(),
    val collapsedWorkspaceIds: Set<String> = emptySet(),
    val renamingConversationIds: Set<String> = emptySet(),
    val renameErrors: Map<String, String> = emptyMap(),
    val threadActivity: Map<String, BrowseThreadActivity> = emptyMap(),
)

sealed interface BrowseRequest {
    data object Projects : BrowseRequest

    data class Conversations(val projectPath: String) : BrowseRequest
}

enum class BrowseStatusKind {
    NORMAL,
    CACHED,
    ERROR,
}

data class BrowseStatus(
    val label: String,
    val kind: BrowseStatusKind,
    val detail: String? = null,
    val showProgress: Boolean = false,
    val canRetry: Boolean = false,
)

data class BrowseProjectRow(
    val project: Project,
    val path: String,
    val name: String,
    val sessionCount: Int,
    val unread: Int,
    val status: String?,
)

data class BrowseConversationRow(
    val conversation: Conversation,
    val id: String,
    val title: String,
    val agentType: String,
    val updatedAt: Long,
    val availableOffline: Boolean,
    val unread: Int,
    val status: String?,
    val originSource: String? = null,
)

sealed interface BrowseProjectsPresentation {
    data object Loading : BrowseProjectsPresentation
    data object Empty : BrowseProjectsPresentation
    data class Failure(val message: String) : BrowseProjectsPresentation
    data class Content(
        val rows: List<BrowseProjectRow>,
        val status: BrowseStatus,
    ) : BrowseProjectsPresentation
}

sealed interface BrowseConversationsPresentation {
    data object Loading : BrowseConversationsPresentation
    data object Empty : BrowseConversationsPresentation
    data class Failure(val message: String) : BrowseConversationsPresentation
    data class Content(
        val rows: List<BrowseConversationRow>,
        val status: BrowseStatus,
    ) : BrowseConversationsPresentation
}

class OfflineBrowseIndex private constructor(
    private val threadIds: Set<String>,
) {
    fun contains(threadId: String): Boolean = threadId in threadIds

    companion object {
        fun from(snapshot: OfflineSnapshot, connectionId: String): OfflineBrowseIndex {
            val prefix = "$connectionId:"
            return OfflineBrowseIndex(
                snapshot.cachedThreads
                    .asSequence()
                    .map { it.threadKey }
                    .filter { it.startsWith(prefix) }
                    .map { it.removePrefix(prefix) }
                    .toSet(),
            )
        }

        fun empty(): OfflineBrowseIndex = OfflineBrowseIndex(emptySet())
    }
}

object BrowsePresenter {
    fun projects(
        state: BrowseLoadState<BrowseProjectRecord>,
        activity: Map<String, BrowseThreadActivity> = emptyMap(),
    ): BrowseProjectsPresentation {
        val items = state.items()
        if (items.isEmpty()) {
            return when (state) {
                is BrowseLoadState.Loading -> BrowseProjectsPresentation.Loading
                is BrowseLoadState.Ready -> state.recoveryMessage
                    ?.let(BrowseProjectsPresentation::Failure)
                    ?: BrowseProjectsPresentation.Empty
                is BrowseLoadState.Failed -> BrowseProjectsPresentation.Failure(state.message)
            }
        }
        return BrowseProjectsPresentation.Content(
            rows = items.map { record ->
                val visibleThreadIds = record.project.sessions
                    .map(SessionSummary::id)
                    .filterNot(record.archivedSessionIds::contains)
                val projectActivity = BrowseParityDecisions.projectActivity(visibleThreadIds, activity)
                BrowseProjectRow(
                    project = record.project,
                    path = record.project.path,
                    name = record.project.name,
                    sessionCount = record.project.sessions.count {
                        it.id !in record.archivedSessionIds
                    },
                    unread = projectActivity.unread,
                    status = projectActivity.status,
                )
            },
            status = status(state, "projects", items.size),
        )
    }

    fun conversations(
        state: BrowseLoadState<BrowseConversationRecord>,
        offlineIndex: OfflineBrowseIndex,
        activity: Map<String, BrowseThreadActivity> = emptyMap(),
    ): BrowseConversationsPresentation {
        val visible = state.items().filterNot(BrowseConversationRecord::archived)
        if (visible.isEmpty()) {
            return when (state) {
                is BrowseLoadState.Loading -> BrowseConversationsPresentation.Loading
                is BrowseLoadState.Ready -> state.recoveryMessage
                    ?.let(BrowseConversationsPresentation::Failure)
                    ?: BrowseConversationsPresentation.Empty
                is BrowseLoadState.Failed -> BrowseConversationsPresentation.Failure(state.message)
            }
        }
        val sorted = BrowseDecisions.sortConversations(visible.map { it.conversation })
        return BrowseConversationsPresentation.Content(
            rows = sorted.map { conversation ->
                BrowseConversationRow(
                    conversation = conversation,
                    id = conversation.id,
                    title = conversation.title,
                    agentType = conversation.agentType,
                    updatedAt = conversation.updatedAt,
                    availableOffline = offlineIndex.contains(conversation.id),
                    unread = activity[conversation.id]?.unread ?: 0,
                    status = activity[conversation.id]?.status,
                    originSource = conversation.originSource,
                )
            },
            status = status(state, "conversations", visible.size),
        )
    }

    fun workspaces(state: BrowseLoadState<Workspace>): List<Workspace> = state.items()

    private fun <T> BrowseLoadState<T>.items(): List<T> = when (this) {
        is BrowseLoadState.Loading -> cached
        is BrowseLoadState.Ready -> items
        is BrowseLoadState.Failed -> cached
    }

    private fun <T> status(
        state: BrowseLoadState<T>,
        noun: String,
        count: Int,
    ): BrowseStatus = when (state) {
        is BrowseLoadState.Loading -> BrowseStatus(
            label = "Showing saved $noun",
            kind = BrowseStatusKind.CACHED,
            showProgress = true,
        )

        is BrowseLoadState.Failed -> BrowseStatus(
            label = "Showing saved $noun",
            kind = BrowseStatusKind.ERROR,
            detail = state.message,
            canRetry = true,
        )

        is BrowseLoadState.Ready -> when {
            state.recoveryMessage != null -> BrowseStatus(
                label = if (state.cached) "Showing saved $noun" else "$count $noun",
                kind = BrowseStatusKind.ERROR,
                detail = state.recoveryMessage,
                showProgress = state.refreshing,
                canRetry = true,
            )

            state.cached -> BrowseStatus(
                label = "Saved on this device",
                kind = BrowseStatusKind.CACHED,
                showProgress = state.refreshing,
            )

            else -> BrowseStatus(
                label = if (state.refreshing) "Refreshing $noun" else "$count $noun",
                kind = BrowseStatusKind.NORMAL,
                showProgress = state.refreshing,
            )
        }
    }
}

object BrowseRowPolicy {
    fun projectTrailingLabel(row: BrowseProjectRow): String = when {
        row.status.isFailureStatus() -> requireNotNull(row.status)
        row.unread > 0 -> "${row.unread} unread"
        !row.status.isNullOrBlank() -> row.status
        row.sessionCount == 1 -> "1 chat"
        else -> "${row.sessionCount} chats"
    }

    fun conversationSupportingLabel(row: BrowseConversationRow): String = listOfNotNull(
        if (row.originSource == "cursor") "Cursor" else agentLabel(row.agentType),
        when {
            row.status.isFailureStatus() -> row.status
            row.unread > 0 -> "${row.unread} unread"
            !row.status.isNullOrBlank() -> row.status
            row.availableOffline -> "saved"
            else -> null
        },
    ).joinToString(" · ")

    private fun agentLabel(agentType: String): String = when (agentType) {
        "claude", "claude-code" -> "Claude"
        "codex" -> "Codex"
        "opencode" -> "OpenCode"
        else -> agentType
    }

    private fun String?.isFailureStatus(): Boolean = this == "error" || this == "failed"
}

enum class BrowseActivityTone {
    ACTIVE,
    ATTENTION,
    ERROR,
    UNREAD,
    MUTED,
}

object BrowseVisualPolicy {
    fun projectMonogram(name: String): String {
        val words = name.trim()
            .split(Regex("[^A-Za-z0-9]+"))
            .filter(String::isNotBlank)
        if (words.isEmpty()) return "•"
        return if (words.size > 1) {
            words.take(2).joinToString("") { it.first().toString().uppercase(Locale.ROOT) }
        } else {
            words.single().take(2).uppercase(Locale.ROOT)
        }
    }

    fun activityTone(status: String?, unread: Int): BrowseActivityTone = when (status) {
        "error", "failed" -> BrowseActivityTone.ERROR
        "running", "streaming", "working" -> BrowseActivityTone.ACTIVE
        "starting", "connecting", "waiting", "queued" -> BrowseActivityTone.ATTENTION
        else -> if (unread > 0) BrowseActivityTone.UNREAD else BrowseActivityTone.MUTED
    }
}
