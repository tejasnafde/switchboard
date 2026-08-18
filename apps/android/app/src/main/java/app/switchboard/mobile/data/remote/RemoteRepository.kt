package app.switchboard.mobile.data.remote

import app.switchboard.mobile.domain.remote.CommandFollowUp
import app.switchboard.mobile.domain.remote.RemoteOutcome
import app.switchboard.mobile.domain.remote.RemoteRequestKey
import app.switchboard.mobile.domain.remote.RemoteResponse

class GenerationGuardedRemoteRepository {
    private val latest = mutableMapOf<Pair<String, String>, RemoteRequestKey>()

    @Synchronized
    fun begin(key: RemoteRequestKey) {
        latest[key.connectionId to key.operation] = key
    }

    fun <T> accept(
        response: RemoteResponse<T>,
        consumer: (RemoteResponse<T>) -> Unit,
    ) {
        val isCurrent = synchronized(this) {
            latest[response.key.connectionId to response.key.operation] == response.key
        }
        if (isCurrent) consumer(response)
    }

    /**
     * A successful mutation stays successful even if its UI refresh fails.
     * Failed commands do not launch a refresh whose result could obscure them.
     */
    fun <C, F> commandThenBestEffortRefresh(
        command: ((RemoteResponse<C>) -> Unit) -> Unit,
        refresh: ((RemoteResponse<F>) -> Unit) -> Unit,
        consumer: (CommandFollowUp<C, F>) -> Unit,
    ) {
        command { commandResult ->
            if (commandResult.outcome is RemoteOutcome.Failure) {
                consumer(CommandFollowUp(commandResult, null))
            } else {
                refresh { refreshResult ->
                    consumer(CommandFollowUp(commandResult, refreshResult))
                }
            }
        }
    }
}
