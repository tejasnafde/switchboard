package app.switchboard.mobile.data.remote

import app.switchboard.mobile.domain.remote.ChatSettle
import app.switchboard.mobile.domain.remote.ChatSnooze
import app.switchboard.mobile.domain.remote.RemoteOutcome
import app.switchboard.mobile.domain.remote.SessionSummary
import app.switchboard.mobile.platform.log.SbLog
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.update

/**
 * Home's settled times newer than the project list's, by machine and chat:
 * this phone's own Settle and Undo, and `app:conversation-settled` broadcasts,
 * so a row leaves or comes back before the list is read again. An entry goes
 * once a list agrees with it, so a later unsettle the backend makes without a
 * broadcast (a new user turn) shows from the next read.
 */
class ChatSettleStore {
    private val held = MutableStateFlow<Map<String, Map<String, Long?>>>(emptyMap())
    val state: StateFlow<Map<String, Map<String, Long?>>> = held

    fun put(connectionId: String, threadId: String, settledAt: Long?) {
        held.update { all -> all + (connectionId to (all[connectionId].orEmpty() + (threadId to settledAt))) }
    }

    fun applyEvent(connectionId: String, event: ChatSettle.Event) = put(connectionId, event.conversationId, event.settledAt)

    /** Drops each entry the project list agrees with. */
    fun reconcile(connectionId: String, sessions: List<SessionSummary>) {
        held.update { all ->
            val mine = all[connectionId] ?: return@update all
            val listed = sessions.associate { it.id to (it.settledAt != null) }
            val next = mine.filterNot { (id, settledAt) -> listed[id] == (settledAt != null) }
            if (next.size == mine.size) all else all + (connectionId to next)
        }
    }

    fun of(connectionId: String, threadId: String): Long? = held.value[connectionId]?.get(threadId)

    private fun drop(connectionId: String, threadId: String) {
        held.update { all -> all[connectionId]?.let { all + (connectionId to (it - threadId)) } ?: all }
    }

    /** Settle a Done or idle chat: the row leaves at once and comes back when the backend refuses. */
    fun settle(client: SwitchboardRemoteClient, threadId: String, settledAt: Long, onDone: (String?) -> Unit) {
        put(client.connectionId, threadId, settledAt)
        client.settleConversation(threadId) { response ->
            val failure = when (val outcome = response.outcome) {
                is RemoteOutcome.Failure -> outcome.message
                is RemoteOutcome.Success -> if (outcome.value) null else "the chat has no stored row"
            }
            if (failure == null) {
                onDone(null)
            } else {
                SbLog.w(LOG_SCOPE, "could not settle $threadId; the row comes back: $failure")
                drop(client.connectionId, threadId)
                onDone("Could not settle. Try again")
            }
        }
    }

    /**
     * Undo a settle, as the desktop does: a settle that ended a snooze snoozes
     * again with its values and revision, a write that also unsettles; a
     * refused one (a PR-only snooze whose PR merged) only unsettles.
     */
    fun undo(
        client: SwitchboardRemoteClient,
        undo: ChatSettle.Undo,
        snoozeStore: ChatSnoozeStore,
        now: Long,
        onDone: (String?) -> Unit,
    ) {
        put(client.connectionId, undo.threadId, null)
        val ended = undo.endedSnooze
        if (ended == null) {
            unsettle(client, undo, onDone)
            return
        }
        client.restoreSnooze(undo.threadId, ended) { response ->
            when (val outcome = response.outcome) {
                is RemoteOutcome.Failure -> {
                    SbLog.w(LOG_SCOPE, "snooze restore failed for ${undo.threadId}: ${outcome.message}")
                    unsettle(client, undo, onDone)
                }
                is RemoteOutcome.Success -> when (val answer = outcome.value) {
                    is ChatSnooze.SnoozeAnswer.Snoozed -> {
                        snoozeStore.put(client.connectionId, undo.threadId, ChatSnooze.snoozed(answer, now))
                        onDone(null)
                    }
                    is ChatSnooze.SnoozeAnswer.Refused -> {
                        SbLog.i(LOG_SCOPE, "snooze not restored for ${undo.threadId}: ${answer.reason}")
                        unsettle(client, undo, onDone)
                    }
                }
            }
        }
    }

    private fun unsettle(client: SwitchboardRemoteClient, undo: ChatSettle.Undo, onDone: (String?) -> Unit) {
        client.unsettleConversation(undo.threadId) { response ->
            val failure = when (val outcome = response.outcome) {
                is RemoteOutcome.Failure -> outcome.message
                is RemoteOutcome.Success -> if (outcome.value) null else "the chat has no stored row"
            }
            if (failure == null) {
                onDone(null)
            } else {
                SbLog.w(LOG_SCOPE, "unsettle failed for ${undo.threadId}; the chat stays settled: $failure")
                put(client.connectionId, undo.threadId, undo.settledAt)
                onDone("Could not undo the settle. Try again")
            }
        }
    }

    private companion object {
        const val LOG_SCOPE = "home:settle"
    }
}
