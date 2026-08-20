package app.switchboard.mobile.data.remote

import app.switchboard.mobile.data.local.OfflineSnapshot
import app.switchboard.mobile.domain.remote.Conversation
import app.switchboard.mobile.domain.remote.CommandBody
import app.switchboard.mobile.domain.remote.CreateConversation
import app.switchboard.mobile.domain.remote.Project
import app.switchboard.mobile.domain.remote.RemoteOutcome
import app.switchboard.mobile.domain.remote.RemoteResponse
import app.switchboard.mobile.domain.remote.Workspace
import app.switchboard.mobile.ui.browse.BrowseConversationRecord
import app.switchboard.mobile.ui.browse.BrowseCachedActivity
import app.switchboard.mobile.ui.browse.BrowseLoadState
import app.switchboard.mobile.ui.browse.BrowseProjectRecord
import app.switchboard.mobile.ui.browse.BrowseState
import app.switchboard.mobile.ui.browse.BrowseThreadActivity
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow

interface BrowseRemote {
    fun getProjects(callback: (RemoteResponse<List<Project>>) -> Unit)

    fun getConversations(
        projectPath: String,
        callback: (RemoteResponse<List<Conversation>>) -> Unit,
    )

    fun listWorkspaces(callback: (RemoteResponse<List<Workspace>>) -> Unit)

    fun createConversation(
        input: CreateConversation,
        callback: (RemoteResponse<CommandBody>) -> Unit,
    )

    fun renameConversation(
        conversationId: String,
        title: String,
        callback: (RemoteResponse<CommandBody>) -> Unit,
    )
}

fun interface BrowseCollapsePreferenceStore {
    fun save(connectionId: String, collapsedWorkspaceIds: Set<String>)
}

class BrowseCoordinator(
    private val connectionId: String,
    connectionLabel: String,
    offlineSnapshot: OfflineSnapshot,
    private val remote: BrowseRemote,
    private val expectedGeneration: Long? = null,
    initialCollapsedWorkspaceIds: Set<String> = emptySet(),
    private val collapsePreferenceStore: BrowseCollapsePreferenceStore? = null,
    private val snapshotStore: BrowseSnapshotStore = EmptyBrowseSnapshotStore,
) {
    private val saved = runCatching { snapshotStore.load(connectionId) }
        .getOrDefault(BrowseSnapshotSeed())
    private val mutableState = MutableStateFlow(
        BrowseState(
            connectionId = connectionId,
            connectionLabel = connectionLabel,
            offlineSnapshot = offlineSnapshot,
            projects = saved.projects.asCachedLoadState { BrowseProjectRecord(it) },
            workspaces = saved.workspaces.asCachedLoadState { it },
            conversationsByProject = saved.conversationsByProject.mapValues { (_, conversations) ->
                conversations.asCachedLoadState { BrowseConversationRecord(it) }
            },
            collapsedWorkspaceIds = initialCollapsedWorkspaceIds,
            threadActivity = BrowseCachedActivity.from(offlineSnapshot, connectionId),
        ),
    )
    val state = mutableState.asStateFlow()

    private var projectRequest = 0L
    private var workspaceRequest = 0L
    private val conversationRequests = mutableMapOf<String, Long>()
    private val renameRequests = mutableMapOf<String, Long>()
    private val optimisticRenames = mutableMapOf<String, OptimisticRename>()
    private var closed = false

    @Synchronized
    fun refreshProjects() {
        if (closed) return
        refreshProjectIndex()
        refreshWorkspaces()
    }

    @Synchronized
    fun refreshProjectIndex() {
        if (closed) return
        val request = ++projectRequest
        mutableState.value = mutableState.value.copy(
            projects = BrowseLoadState.Loading(mutableState.value.projects.items()),
        )
        remote.getProjects { response -> acceptProjects(request, response) }
    }

    @Synchronized
    private fun refreshWorkspaces() {
        if (closed) return
        val request = ++workspaceRequest
        mutableState.value = mutableState.value.copy(
            workspaces = BrowseLoadState.Loading(mutableState.value.workspaces.items()),
        )
        remote.listWorkspaces { response -> acceptWorkspaces(request, response) }
    }

    @Synchronized
    fun refreshConversations(projectPath: String) {
        if (closed) return
        val request = conversationRequests.getOrDefault(projectPath, 0) + 1
        conversationRequests[projectPath] = request
        val prior = mutableState.value.conversationsByProject[projectPath]
        mutableState.value = mutableState.value.copy(
            conversationsByProject = mutableState.value.conversationsByProject + (
                projectPath to BrowseLoadState.Loading(prior?.items().orEmpty())
            ),
        )
        remote.getConversations(projectPath) { response ->
            acceptConversations(projectPath, request, response)
        }
    }

    @Synchronized
    fun updateOfflineSnapshot(snapshot: OfflineSnapshot) {
        mutableState.value = mutableState.value.copy(offlineSnapshot = snapshot)
    }

    @Synchronized
    fun updateThreadActivity(activity: Map<String, BrowseThreadActivity>) {
        mutableState.value = mutableState.value.copy(
            threadActivity = mutableState.value.threadActivity + activity,
        )
    }

    @Synchronized
    fun toggleWorkspace(workspaceId: String) {
        if (closed) return
        val next = mutableState.value.collapsedWorkspaceIds.toMutableSet().apply {
            if (!add(workspaceId)) remove(workspaceId)
        }
        mutableState.value = mutableState.value.copy(collapsedWorkspaceIds = next)
        collapsePreferenceStore?.save(connectionId, next)
    }

    @Synchronized
    fun renameConversation(projectPath: String, conversationId: String, requestedTitle: String) {
        if (closed) return
        val title = requestedTitle.trim()
        val current = mutableState.value.conversationsByProject[projectPath]
            ?.items()
            ?.firstOrNull { it.conversation.id == conversationId }
            ?.conversation
            ?: return
        if (title.isEmpty() || title == current.title) return

        val request = renameRequests.getOrDefault(conversationId, 0) + 1
        renameRequests[conversationId] = request
        optimisticRenames[conversationId] = OptimisticRename(current.title, title)
        updateConversation(projectPath, conversationId) { it.copy(title = title) }
        mutableState.value = mutableState.value.copy(
            renamingConversationIds = mutableState.value.renamingConversationIds + conversationId,
            renameErrors = mutableState.value.renameErrors - conversationId,
        )
        remote.createConversation(
            CreateConversation(
                id = current.id,
                projectPath = current.projectPath,
                agentType = current.agentType,
                title = current.title,
                worktreePath = current.worktreePath,
                worktreeBranch = current.worktreeBranch,
            ),
        ) { response ->
            if (!acceptRenameResponse(conversationId, request, response)) return@createConversation
            when (val outcome = response.outcome) {
                is RemoteOutcome.Failure -> failRename(projectPath, conversationId, outcome.message)
                is RemoteOutcome.Success -> remote.renameConversation(conversationId, title) { rename ->
                    if (!acceptRenameResponse(conversationId, request, rename)) return@renameConversation
                    when (val renamed = rename.outcome) {
                        is RemoteOutcome.Failure -> failRename(
                            projectPath,
                            conversationId,
                            renamed.message,
                        )
                        is RemoteOutcome.Success -> finishRename(projectPath, conversationId)
                    }
                }
            }
        }
    }

    @Synchronized
    private fun acceptProjects(
        request: Long,
        response: RemoteResponse<List<Project>>,
    ) {
        if (
            closed ||
            response.key.connectionId != connectionId ||
            expectedGeneration?.let { response.key.generation != it } == true ||
            projectRequest != request
        ) return
        val cached = mutableState.value.projects.items()
        val next = when (val outcome = response.outcome) {
            is RemoteOutcome.Success -> {
                runCatching { snapshotStore.saveProjects(connectionId, outcome.value) }
                BrowseLoadState.Ready(outcome.value.map { BrowseProjectRecord(it) })
            }
            is RemoteOutcome.Failure -> BrowseLoadState.Failed(outcome.message, cached)
        }
        mutableState.value = mutableState.value.copy(projects = next)
    }

    @Synchronized
    private fun acceptWorkspaces(
        request: Long,
        response: RemoteResponse<List<Workspace>>,
    ) {
        if (closed || !accepts(response) || workspaceRequest != request) return
        val cached = mutableState.value.workspaces.items()
        val next = when (val outcome = response.outcome) {
            is RemoteOutcome.Success -> {
                runCatching { snapshotStore.saveWorkspaces(connectionId, outcome.value) }
                BrowseLoadState.Ready(outcome.value)
            }
            is RemoteOutcome.Failure -> BrowseLoadState.Failed(outcome.message, cached)
        }
        mutableState.value = mutableState.value.copy(workspaces = next)
    }

    @Synchronized
    private fun acceptConversations(
        projectPath: String,
        request: Long,
        response: RemoteResponse<List<Conversation>>,
    ) {
        if (
            closed ||
            response.key.connectionId != connectionId ||
            expectedGeneration?.let { response.key.generation != it } == true ||
            conversationRequests[projectPath] != request
        ) return
        val cached = mutableState.value.conversationsByProject[projectPath]?.items().orEmpty()
        val next = when (val outcome = response.outcome) {
            is RemoteOutcome.Success -> {
                runCatching {
                    snapshotStore.saveConversations(connectionId, projectPath, outcome.value)
                }
                BrowseLoadState.Ready(outcome.value.map { conversation ->
                    val title = optimisticRenames[conversation.id]?.requestedTitle
                    BrowseConversationRecord(
                        if (title == null) conversation else conversation.copy(title = title),
                    )
                })
            }
            is RemoteOutcome.Failure -> BrowseLoadState.Failed(outcome.message, cached)
        }
        mutableState.value = mutableState.value.copy(
            conversationsByProject = mutableState.value.conversationsByProject + (projectPath to next),
        )
    }

    private fun accepts(response: RemoteResponse<*>): Boolean =
        response.key.connectionId == connectionId &&
            expectedGeneration?.let { response.key.generation == it } != false

    @Synchronized
    private fun acceptRenameResponse(
        conversationId: String,
        request: Long,
        response: RemoteResponse<*>,
    ): Boolean = !closed && accepts(response) && renameRequests[conversationId] == request

    @Synchronized
    fun close() {
        if (closed) return
        closed = true
        projectRequest += 1
        workspaceRequest += 1
        conversationRequests.replaceAll { _, request -> request + 1 }
        renameRequests.replaceAll { _, request -> request + 1 }
    }

    @Synchronized
    private fun failRename(projectPath: String, conversationId: String, message: String) {
        val original = optimisticRenames.remove(conversationId)?.originalTitle ?: return
        updateConversation(projectPath, conversationId) { it.copy(title = original) }
        mutableState.value = mutableState.value.copy(
            renamingConversationIds = mutableState.value.renamingConversationIds - conversationId,
            renameErrors = mutableState.value.renameErrors + (conversationId to message),
        )
    }

    @Synchronized
    private fun finishRename(projectPath: String, conversationId: String) {
        optimisticRenames.remove(conversationId)
        mutableState.value = mutableState.value.copy(
            renamingConversationIds = mutableState.value.renamingConversationIds - conversationId,
            renameErrors = mutableState.value.renameErrors - conversationId,
        )
        refreshConversations(projectPath)
    }

    private fun updateConversation(
        projectPath: String,
        conversationId: String,
        transform: (Conversation) -> Conversation,
    ) {
        val state = mutableState.value
        val current = state.conversationsByProject[projectPath] ?: return
        val updated = current.mapItems { record ->
            if (record.conversation.id == conversationId) {
                record.copy(conversation = transform(record.conversation))
            } else {
                record
            }
        }
        mutableState.value = state.copy(
            conversationsByProject = state.conversationsByProject + (projectPath to updated),
        )
    }

    private data class OptimisticRename(
        val originalTitle: String,
        val requestedTitle: String,
    )
}

private fun <T, R> List<T>.asCachedLoadState(transform: (T) -> R): BrowseLoadState<R> =
    if (isEmpty()) {
        BrowseLoadState.Loading()
    } else {
        BrowseLoadState.Ready(map(transform), cached = true)
    }

private fun <T> BrowseLoadState<T>.items(): List<T> = when (this) {
    is BrowseLoadState.Loading -> cached
    is BrowseLoadState.Ready -> items
    is BrowseLoadState.Failed -> cached
}

private fun <T> BrowseLoadState<T>.mapItems(transform: (T) -> T): BrowseLoadState<T> = when (this) {
    is BrowseLoadState.Loading -> copy(cached = cached.map(transform))
    is BrowseLoadState.Ready -> copy(items = items.map(transform))
    is BrowseLoadState.Failed -> copy(cached = cached.map(transform))
}

class SwitchboardBrowseRemote(
    private val client: SwitchboardRemoteClient,
) : BrowseRemote {
    override fun getProjects(callback: (RemoteResponse<List<Project>>) -> Unit) {
        client.getProjects(callback)
    }

    override fun getConversations(
        projectPath: String,
        callback: (RemoteResponse<List<Conversation>>) -> Unit,
    ) {
        client.getConversations(projectPath, callback)
    }

    override fun listWorkspaces(callback: (RemoteResponse<List<Workspace>>) -> Unit) {
        client.listWorkspaces(callback)
    }

    override fun createConversation(
        input: CreateConversation,
        callback: (RemoteResponse<CommandBody>) -> Unit,
    ) {
        client.createConversation(input, callback)
    }

    override fun renameConversation(
        conversationId: String,
        title: String,
        callback: (RemoteResponse<CommandBody>) -> Unit,
    ) {
        client.renameConversation(conversationId, title, callback)
    }
}
