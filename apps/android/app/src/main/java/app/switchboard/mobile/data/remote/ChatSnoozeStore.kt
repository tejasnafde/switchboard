package app.switchboard.mobile.data.remote

import app.switchboard.mobile.domain.remote.ChatSnooze
import app.switchboard.mobile.domain.remote.RemoteOutcome
import app.switchboard.mobile.domain.remote.SessionSummary
import app.switchboard.mobile.platform.log.SbLog
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.update

/**
 * The phone's newest copy of each chat's snooze state, by machine and chat:
 * the project list's copy, `app:conversation-snoozed` broadcasts and this
 * phone's own answers, the higher revision winning ([ChatSnooze.newer]).
 * Home and the Thread screen both read it, so a snooze from either shows on both.
 */
class ChatSnoozeStore {
    private val held = MutableStateFlow<Map<String, Map<String, ChatSnooze.State>>>(emptyMap())
    val state: StateFlow<Map<String, Map<String, ChatSnooze.State>>> = held

    /** Takes [state] unless the one held is of a later revision (a broadcast can arrive after a newer answer). */
    fun put(connectionId: String, threadId: String, state: ChatSnooze.State) {
        held.update { all ->
            val mine = all[connectionId].orEmpty()
            val prior = mine[threadId]
            if (prior != null && prior.snoozeRev > state.snoozeRev) {
                all
            } else {
                val next = state.copy(unsettled = state.unsettled || state.snoozed || prior?.unsettled == true)
                all + (connectionId to (mine + (threadId to next)))
            }
        }
    }

    fun applyEvent(connectionId: String, event: ChatSnooze.Event) = put(connectionId, event.conversationId, event.state)

    /**
     * Takes the project list's copy of every chat it is not older than, except a
     * same-revision copy with a Woke mark already cleared here (clearing it keeps the revision).
     */
    fun seed(connectionId: String, sessions: List<SessionSummary>) {
        held.update { all ->
            val mine = all[connectionId].orEmpty()
            val next = mine.toMutableMap()
            sessions.forEach { session ->
                val prior = mine[session.id]
                val listed = session.snooze
                val newer = prior == null || listed.snoozeRev > prior.snoozeRev ||
                    (listed.snoozeRev == prior.snoozeRev && (prior.woke || !listed.woke))
                if (newer) next[session.id] = listed
            }
            if (next == mine) all else all + (connectionId to next)
        }
    }

    fun of(connectionId: String, threadId: String): ChatSnooze.State? = held.value[connectionId]?.get(threadId)

    /** Snooze from the sheet. Calls back with the line to show when it did not happen, or null. */
    fun snooze(
        client: SwitchboardRemoteClient,
        threadId: String,
        until: Long?,
        pr: String?,
        preset: String,
        now: Long,
        onDone: (String?) -> Unit,
    ) {
        client.snoozeConversation(threadId, until, pr, preset) { response ->
            when (val outcome = response.outcome) {
                is RemoteOutcome.Failure -> {
                    SbLog.w(LOG_SCOPE, "could not snooze $threadId: ${outcome.message}")
                    onDone("Could not snooze. Try again")
                }
                is RemoteOutcome.Success -> when (val answer = outcome.value) {
                    is ChatSnooze.SnoozeAnswer.Snoozed -> {
                        put(client.connectionId, threadId, ChatSnooze.snoozed(answer, now))
                        onDone(null)
                    }
                    is ChatSnooze.SnoozeAnswer.Refused -> {
                        SbLog.i(LOG_SCOPE, "snooze refused for $threadId: ${answer.reason}")
                        onDone(ChatSnooze.snoozeRefusalText(answer.reason))
                    }
                }
            }
        }
    }

    /** Wake now: end the snooze with no Woke mark. */
    fun wake(client: SwitchboardRemoteClient, threadId: String, onDone: (String?) -> Unit) {
        client.unsnoozeConversation(threadId) { response ->
            when (val outcome = response.outcome) {
                is RemoteOutcome.Failure -> {
                    SbLog.w(LOG_SCOPE, "could not wake $threadId: ${outcome.message}")
                    onDone("Could not wake the chat. Try again")
                }
                is RemoteOutcome.Success -> if (outcome.value.ok) {
                    val prior = of(client.connectionId, threadId) ?: ChatSnooze.State.None
                    put(client.connectionId, threadId, ChatSnooze.woken(outcome.value, prior))
                    onDone(null)
                } else {
                    onDone("This chat is no longer snoozed")
                }
            }
        }
    }

    /** The Thread screen of a woken chat opened: drop its Woke mark here and on the backend. */
    fun markWokeSeen(client: SwitchboardRemoteClient, threadId: String) {
        val current = of(client.connectionId, threadId) ?: return
        if (!current.woke) return
        put(client.connectionId, threadId, current.copy(wokeAt = null, wokeReason = null, wokePrSummary = null))
        client.markWokeSeen(threadId) { response ->
            (response.outcome as? RemoteOutcome.Failure)?.let {
                SbLog.w(LOG_SCOPE, "could not clear the Woke mark of $threadId: ${it.message}")
            }
        }
    }

    private companion object {
        const val LOG_SCOPE = "home:snooze"
    }
}
