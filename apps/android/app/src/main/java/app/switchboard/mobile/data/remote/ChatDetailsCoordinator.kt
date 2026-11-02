package app.switchboard.mobile.data.remote

import app.switchboard.mobile.domain.remote.CurrentBranchResult
import app.switchboard.mobile.domain.remote.RemoteOutcome
import app.switchboard.mobile.domain.remote.RemoteResponse
import app.switchboard.mobile.domain.thread.BranchName
import app.switchboard.mobile.domain.thread.DetailsRead
import app.switchboard.mobile.domain.thread.DiffStat
import app.switchboard.mobile.domain.thread.UsageLimits
import app.switchboard.mobile.platform.protocol.RequestSubmission
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

/** The reads of the chat Details sheet (`details_sheet_v1`). */
interface ChatDetailsRemote {
    fun currentBranch(cwd: String, callback: (RemoteResponse<CurrentBranchResult>) -> Unit): RequestSubmission
    fun diffStat(cwd: String, callback: (RemoteResponse<DiffStat?>) -> Unit): RequestSubmission
    fun instanceUsage(instanceId: String, callback: (RemoteResponse<UsageLimits?>) -> Unit): RequestSubmission
}

data class ChatDetailsState(
    val branch: DetailsRead<BranchName> = DetailsRead.Reading,
    val diff: DetailsRead<DiffStat> = DetailsRead.Reading,
    /** Null while reading, or when the limits cannot be read. */
    val usage: UsageLimits? = null,
    val usageReading: Boolean = false,
)

/**
 * Reads the branch, the diff stat and the account's usage limits each time
 * the sheet opens. A response from an older open, or from another connection
 * generation, is dropped.
 */
class ChatDetailsCoordinator(
    private val expectedGeneration: Long,
    private val cwd: String,
    private val remote: ChatDetailsRemote,
    private val log: (String) -> Unit = {},
) {
    private val mutableState = MutableStateFlow(ChatDetailsState())
    val state: StateFlow<ChatDetailsState> = mutableState.asStateFlow()
    private var request = 0L

    @Synchronized
    fun refresh(instanceId: String) {
        val token = ++request
        mutableState.value = ChatDetailsState(usageReading = true)
        submitted(token, remote.currentBranch(cwd) { response ->
            update(token, response) {
                val branch = when (val outcome = response.outcome) {
                    is RemoteOutcome.Success -> when (val result = outcome.value) {
                        is CurrentBranchResult.Available -> DetailsRead.Read(BranchName(result.branch))
                        is CurrentBranchResult.Unavailable -> DetailsRead.Failed
                    }
                    is RemoteOutcome.Failure -> failed("branch", outcome.message)
                }
                it.copy(branch = branch)
            }
        }) { it.copy(branch = DetailsRead.Failed) }
        submitted(token, remote.diffStat(cwd) { response ->
            update(token, response) {
                val diff = when (val outcome = response.outcome) {
                    is RemoteOutcome.Success -> outcome.value?.let { stat -> DetailsRead.Read(stat) } ?: DetailsRead.Failed
                    is RemoteOutcome.Failure -> failed("diff stat", outcome.message)
                }
                it.copy(diff = diff)
            }
        }) { it.copy(diff = DetailsRead.Failed) }
        submitted(token, remote.instanceUsage(instanceId) { response ->
            update(token, response) {
                val usage = when (val outcome = response.outcome) {
                    is RemoteOutcome.Success -> outcome.value
                    is RemoteOutcome.Failure -> {
                        log("reading the usage limits failed: ${outcome.message}")
                        null
                    }
                }
                it.copy(usage = usage, usageReading = false)
            }
        }) { it.copy(usageReading = false) }
    }

    @Synchronized
    fun close() {
        request += 1
    }

    private fun failed(what: String, message: String): DetailsRead<Nothing> {
        log("reading the $what failed: $message")
        return DetailsRead.Failed
    }

    @Synchronized
    private fun <T> update(token: Long, response: RemoteResponse<T>, change: (ChatDetailsState) -> ChatDetailsState) {
        if (token != request || response.key.generation != expectedGeneration) return
        mutableState.value = change(mutableState.value)
    }

    /** A request the client never sent fails its row at once. */
    @Synchronized
    private fun submitted(token: Long, submission: RequestSubmission, failed: (ChatDetailsState) -> ChatDetailsState) {
        if (submission is RequestSubmission.Rejected && token == request) mutableState.value = failed(mutableState.value)
    }
}
