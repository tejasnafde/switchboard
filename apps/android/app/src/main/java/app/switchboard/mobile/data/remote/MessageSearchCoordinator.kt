package app.switchboard.mobile.data.remote

import app.switchboard.mobile.domain.remote.MessageSearchResult
import app.switchboard.mobile.domain.remote.RemoteOutcome
import app.switchboard.mobile.domain.remote.RemoteResponse
import app.switchboard.mobile.platform.log.SbLog
import app.switchboard.mobile.platform.protocol.Cancelable
import app.switchboard.mobile.platform.protocol.RequestSubmission
import app.switchboard.mobile.platform.protocol.RpcFailure
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow

interface MessageSearchRemote {
    fun searchMessages(
        query: String,
        callback: (RemoteResponse<List<MessageSearchResult>>) -> Unit,
    ): RequestSubmission
}

fun interface MessageSearchScheduler {
    fun schedule(delayMillis: Long, action: () -> Unit): Cancelable
}

data class MessageSearchState(
    val query: String = "",
    val results: List<MessageSearchResult> = emptyList(),
    val loading: Boolean = false,
    val searched: Boolean = false,
    val error: String? = null,
)

class MessageSearchCoordinator(
    private val connectionId: String,
    private val expectedGeneration: Long,
    private val remote: MessageSearchRemote,
    private val scheduler: MessageSearchScheduler,
    private val debounceMillis: Long = 200,
    private val resultLimit: Int = 40,
    /** The query typed before this connection was ready, or on the one it replaces; [retry] searches it. */
    initialQuery: String = "",
) {
    private val mutableState = MutableStateFlow(MessageSearchState())
    val state = mutableState.asStateFlow()

    private var pending: Cancelable? = null
    private var request = 0L

    init {
        if (initialQuery.isNotEmpty()) mutableState.value = MessageSearchState(query = initialQuery)
    }

    @Synchronized
    fun updateQuery(value: String) {
        pending?.cancel()
        pending = null
        request += 1
        val trimmed = value.trim()
        mutableState.value = MessageSearchState(query = value)
        if (trimmed.length < 2) return
        val token = request
        pending = scheduler.schedule(debounceMillis) {
            perform(token, trimmed)
        }
    }

    @Synchronized
    fun retry() {
        val trimmed = mutableState.value.query.trim()
        if (trimmed.length < 2) return
        pending?.cancel()
        pending = null
        val token = ++request
        perform(token, trimmed)
    }

    @Synchronized
    fun close() {
        pending?.cancel()
        pending = null
        request += 1
    }

    @Synchronized
    private fun perform(token: Long, query: String) {
        if (token != request) return
        pending = null
        mutableState.value = mutableState.value.copy(
            loading = true,
            searched = true,
            error = null,
        )
        val completion = MessageSearchCompletion(
            onResponse = { response -> accept(token, query, response) },
            onRejected = { reason -> reject(token, query, reason) },
        )
        val submission = remote.searchMessages(query, completion::response)
        completion.submitted(submission)
    }

    @Synchronized
    private fun accept(
        token: Long,
        query: String,
        response: RemoteResponse<List<MessageSearchResult>>,
    ) {
        if (token != request || mutableState.value.query.trim() != query) return
        if (response.key.connectionId != connectionId || response.key.generation != expectedGeneration) {
            // The connection was replaced while this search was in flight; a new
            // coordinator searches again, and this one must not spin forever.
            SbLog.i(LOG_SCOPE, "$connectionId reply from gen=${response.key.generation}, expected $expectedGeneration")
            mutableState.value = mutableState.value.copy(
                loading = false,
                error = RpcFailure.ConnectionReplaced.searchMessage(),
            )
            return
        }
        mutableState.value = when (val outcome = response.outcome) {
            is RemoteOutcome.Success -> mutableState.value.copy(
                results = outcome.value.take(resultLimit),
                loading = false,
                searched = true,
                error = null,
            )

            is RemoteOutcome.Failure -> mutableState.value.copy(
                results = emptyList(),
                loading = false,
                searched = true,
                error = outcome.message,
            ).also { SbLog.w(LOG_SCOPE, "$connectionId search failed: ${outcome.message}") }
        }
    }

    @Synchronized
    private fun reject(token: Long, query: String, reason: RpcFailure) {
        if (token != request || mutableState.value.query.trim() != query) return
        mutableState.value = mutableState.value.copy(
            results = emptyList(),
            loading = false,
            searched = true,
            error = reason.searchMessage(),
        )
        SbLog.w(LOG_SCOPE, "$connectionId search not sent: $reason")
    }

    private companion object {
        const val LOG_SCOPE = "search"
    }
}

private class MessageSearchCompletion(
    private val onResponse: (RemoteResponse<List<MessageSearchResult>>) -> Unit,
    private val onRejected: (RpcFailure) -> Unit,
) {
    private var submission: RequestSubmission? = null
    private var buffered: RemoteResponse<List<MessageSearchResult>>? = null
    private var completed = false

    fun response(response: RemoteResponse<List<MessageSearchResult>>) {
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
                    SearchSubmissionOutcome.Response(it)
                }

                is RequestSubmission.Rejected -> {
                    completed = true
                    SearchSubmissionOutcome.Rejected(value.reason)
                }
            }
        }
        when (outcome) {
            null -> Unit
            is SearchSubmissionOutcome.Response -> onResponse(outcome.response)
            is SearchSubmissionOutcome.Rejected -> onRejected(outcome.reason)
        }
    }
}

private sealed interface SearchSubmissionOutcome {
    data class Response(
        val response: RemoteResponse<List<MessageSearchResult>>,
    ) : SearchSubmissionOutcome

    data class Rejected(val reason: RpcFailure) : SearchSubmissionOutcome
}

private fun RpcFailure.searchMessage(): String = when (this) {
    RpcFailure.NotReady -> "Machine is not ready. Retry search."
    RpcFailure.CapacityExceeded -> "Machine is busy. Retry search."
    RpcFailure.Timeout -> "Search timed out. Retry."
    RpcFailure.SendFailed -> "Could not send the search request."
    RpcFailure.ConnectionReplaced -> "Machine connection changed. Retry search."
    is RpcFailure.Remote -> error
    is RpcFailure.ConnectionLost -> "Machine connection was lost. Retry search."
    RpcFailure.ServiceDestroyed -> "Search stopped when the connection service closed."
}
