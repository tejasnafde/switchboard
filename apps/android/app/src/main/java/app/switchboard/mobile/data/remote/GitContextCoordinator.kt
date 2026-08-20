package app.switchboard.mobile.data.remote

import app.switchboard.mobile.domain.remote.CurrentBranchResult
import app.switchboard.mobile.domain.remote.RemoteOutcome
import app.switchboard.mobile.domain.remote.RemoteResponse
import app.switchboard.mobile.platform.protocol.RequestSubmission
import app.switchboard.mobile.platform.protocol.RpcFailure
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow

fun interface GitContextRemote {
    fun currentBranch(
        cwd: String,
        callback: (RemoteResponse<CurrentBranchResult>) -> Unit,
    ): RequestSubmission
}

data class GitContextState(
    val branch: String? = null,
    val loading: Boolean = false,
    val loaded: Boolean = false,
    val missing: Boolean = false,
    val error: String? = null,
)

class GitContextCoordinator(
    private val connectionId: String,
    private val expectedGeneration: Long,
    private val cwd: String,
    branchHint: String?,
    private val remote: GitContextRemote,
) {
    private val mutableState = MutableStateFlow(
        GitContextState(branch = branchHint?.takeIf(String::isNotBlank)),
    )
    val state = mutableState.asStateFlow()
    private var request = 0L

    @Synchronized
    fun refresh() {
        val token = ++request
        mutableState.value = mutableState.value.copy(loading = true, error = null)
        val completion = GitContextCompletion(
            onResponse = { response -> accept(token, response) },
            onRejected = { reason -> reject(token, reason) },
        )
        completion.submitted(remote.currentBranch(cwd, completion::response))
    }

    @Synchronized
    fun close() {
        request += 1
    }

    @Synchronized
    private fun accept(token: Long, response: RemoteResponse<CurrentBranchResult>) {
        if (
            token != request ||
            response.key.connectionId != connectionId ||
            response.key.generation != expectedGeneration ||
            response.key.operation != BackendChannels.CurrentBranch
        ) return
        mutableState.value = when (val outcome = response.outcome) {
            is RemoteOutcome.Success -> when (val result = outcome.value) {
                is CurrentBranchResult.Available -> GitContextState(
                    branch = result.branch,
                    loaded = true,
                )
                is CurrentBranchResult.Unavailable -> mutableState.value.copy(
                    loading = false,
                    loaded = true,
                    missing = result.missing,
                    error = result.message,
                )
            }
            is RemoteOutcome.Failure -> mutableState.value.copy(
                loading = false,
                loaded = true,
                error = outcome.message,
            )
        }
    }

    @Synchronized
    private fun reject(token: Long, reason: RpcFailure) {
        if (token != request) return
        mutableState.value = mutableState.value.copy(
            loading = false,
            loaded = true,
            error = reason.branchMessage(),
        )
    }
}

private class GitContextCompletion(
    private val onResponse: (RemoteResponse<CurrentBranchResult>) -> Unit,
    private val onRejected: (RpcFailure) -> Unit,
) {
    private var submission: RequestSubmission? = null
    private var buffered: RemoteResponse<CurrentBranchResult>? = null
    private var completed = false

    fun response(response: RemoteResponse<CurrentBranchResult>) {
        val accepted = synchronized(this) {
            if (completed) return
            when (submission) {
                null -> {
                    if (buffered == null) buffered = response
                    null
                }
                is RequestSubmission.Accepted -> {
                    completed = true
                    response
                }
                is RequestSubmission.Rejected -> null
            }
        }
        accepted?.let(onResponse)
    }

    fun submitted(value: RequestSubmission) {
        val outcome = synchronized(this) {
            if (completed) return
            submission = value
            when (value) {
                is RequestSubmission.Accepted -> buffered?.let {
                    completed = true
                    GitCompletionOutcome.Response(it)
                }
                is RequestSubmission.Rejected -> {
                    completed = true
                    GitCompletionOutcome.Rejected(value.reason)
                }
            }
        }
        when (outcome) {
            null -> Unit
            is GitCompletionOutcome.Response -> onResponse(outcome.response)
            is GitCompletionOutcome.Rejected -> onRejected(outcome.reason)
        }
    }
}

private sealed interface GitCompletionOutcome {
    data class Response(val response: RemoteResponse<CurrentBranchResult>) : GitCompletionOutcome
    data class Rejected(val reason: RpcFailure) : GitCompletionOutcome
}

private fun RpcFailure.branchMessage(): String = when (this) {
    RpcFailure.NotReady -> "Machine is not ready. Retry branch lookup."
    RpcFailure.CapacityExceeded -> "Machine is busy. Retry branch lookup."
    RpcFailure.Timeout -> "Branch lookup timed out. Retry."
    RpcFailure.SendFailed -> "Could not send the branch lookup."
    RpcFailure.ConnectionReplaced -> "Machine connection changed. Retry branch lookup."
    is RpcFailure.Remote -> error
    is RpcFailure.ConnectionLost -> "Machine connection was lost. Retry branch lookup."
    RpcFailure.ServiceDestroyed -> "Branch lookup stopped when the connection service closed."
}
