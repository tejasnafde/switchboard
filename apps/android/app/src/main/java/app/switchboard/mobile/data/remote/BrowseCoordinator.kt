package app.switchboard.mobile.data.remote

import app.switchboard.mobile.data.local.OfflineSnapshot
import app.switchboard.mobile.domain.remote.Conversation
import app.switchboard.mobile.domain.remote.Project
import app.switchboard.mobile.domain.remote.RemoteOutcome
import app.switchboard.mobile.domain.remote.RemoteResponse
import app.switchboard.mobile.ui.browse.BrowseConversationRecord
import app.switchboard.mobile.ui.browse.BrowseLoadState
import app.switchboard.mobile.ui.browse.BrowseProjectRecord
import app.switchboard.mobile.ui.browse.BrowseState
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow

interface BrowseRemote {
    fun getProjects(callback: (RemoteResponse<List<Project>>) -> Unit)

    fun getConversations(
        projectPath: String,
        callback: (RemoteResponse<List<Conversation>>) -> Unit,
    )
}

class BrowseCoordinator(
    private val connectionId: String,
    connectionLabel: String,
    offlineSnapshot: OfflineSnapshot,
    private val remote: BrowseRemote,
    private val expectedGeneration: Long? = null,
) {
    private val mutableState = MutableStateFlow(
        BrowseState(
            connectionId = connectionId,
            connectionLabel = connectionLabel,
            offlineSnapshot = offlineSnapshot,
            projects = BrowseLoadState.Loading(),
        ),
    )
    val state = mutableState.asStateFlow()

    private var projectRequest = 0L
    private val conversationRequests = mutableMapOf<String, Long>()

    @Synchronized
    fun refreshProjects() {
        val request = ++projectRequest
        mutableState.value = mutableState.value.copy(
            projects = BrowseLoadState.Loading(mutableState.value.projects.items()),
        )
        remote.getProjects { response -> acceptProjects(request, response) }
    }

    @Synchronized
    fun refreshConversations(projectPath: String) {
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
    private fun acceptProjects(
        request: Long,
        response: RemoteResponse<List<Project>>,
    ) {
        if (
            response.key.connectionId != connectionId ||
            expectedGeneration?.let { response.key.generation != it } == true ||
            projectRequest != request
        ) return
        val cached = mutableState.value.projects.items()
        val next = when (val outcome = response.outcome) {
            is RemoteOutcome.Success -> BrowseLoadState.Ready(
                outcome.value.map { BrowseProjectRecord(it) },
            )
            is RemoteOutcome.Failure -> BrowseLoadState.Failed(outcome.message, cached)
        }
        mutableState.value = mutableState.value.copy(projects = next)
    }

    @Synchronized
    private fun acceptConversations(
        projectPath: String,
        request: Long,
        response: RemoteResponse<List<Conversation>>,
    ) {
        if (
            response.key.connectionId != connectionId ||
            expectedGeneration?.let { response.key.generation != it } == true ||
            conversationRequests[projectPath] != request
        ) return
        val cached = mutableState.value.conversationsByProject[projectPath]?.items().orEmpty()
        val next = when (val outcome = response.outcome) {
            is RemoteOutcome.Success -> BrowseLoadState.Ready(
                outcome.value.map { BrowseConversationRecord(it) },
            )
            is RemoteOutcome.Failure -> BrowseLoadState.Failed(outcome.message, cached)
        }
        mutableState.value = mutableState.value.copy(
            conversationsByProject = mutableState.value.conversationsByProject + (projectPath to next),
        )
    }
}

private fun <T> BrowseLoadState<T>.items(): List<T> = when (this) {
    is BrowseLoadState.Loading -> cached
    is BrowseLoadState.Ready -> items
    is BrowseLoadState.Failed -> cached
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
}
