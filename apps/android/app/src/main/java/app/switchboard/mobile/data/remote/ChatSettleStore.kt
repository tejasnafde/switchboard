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
 * once a list agrees with it, or once it is older than [HOLD_MS], so the list
 * wins again: a broadcast names the root chat, so an entry under a rotated id
 * is never corrected by one, and the backend unsettles on a new user turn
 * without a broadcast.
 */
class ChatSettleStore(private val clock: () -> Long = System::currentTimeMillis) {
    /** A settled time (null unsettled) and when it was held. */
    data class Held(val settledAt: Long?, val at: Long)

    private val held = MutableStateFlow<Map<String, Map<String, Held>>>(emptyMap())
    val state: StateFlow<Map<String, Map<String, Held>>> = held

    /**
     * Settle and Undo requests in flight, per machine and chat: the newest
     * one's token, and what the backend holds as far as the answers so far say
     * ([fromList]: what the project list says).
     */
    private class Op(val token: Any, var stored: Long?, var fromList: Boolean)

    private val ops = mutableMapOf<String, Op>()

    fun put(connectionId: String, threadId: String, settledAt: Long?) {
        val entry = Held(settledAt, clock())
        held.update { all -> all + (connectionId to (all[connectionId].orEmpty() + (threadId to entry))) }
    }

    fun applyEvent(connectionId: String, event: ChatSettle.Event) = put(connectionId, event.conversationId, event.settledAt)

    /** Drops each entry the project list agrees with, and each one held longer than [HOLD_MS]. */
    fun reconcile(connectionId: String, sessions: List<SessionSummary>) {
        val now = clock()
        held.update { all ->
            val mine = all[connectionId] ?: return@update all
            val listed = sessions.associate { it.id to (it.settledAt != null) }
            val next = mine.filterNot { (id, entry) ->
                listed[id] == (entry.settledAt != null) || now - entry.at >= HOLD_MS
            }
            if (next.size == mine.size) all else all + (connectionId to next)
        }
    }

    fun of(connectionId: String, threadId: String): Long? = held.value[connectionId]?.get(threadId)?.settledAt

    private fun drop(connectionId: String, threadId: String) {
        held.update { all -> all[connectionId]?.let { all + (connectionId to (it - threadId)) } ?: all }
    }

    private fun begin(connectionId: String, threadId: String, stored: Long?, fromList: Boolean): Any =
        synchronized(ops) {
            val key = "$connectionId:$threadId"
            val token = Any()
            val prior = ops[key]
            ops[key] = if (prior != null) Op(token, prior.stored, prior.fromList) else Op(token, stored, fromList)
            token
        }

    /**
     * One request answered; [stored] is what the backend holds after it when [ok].
     * Only the newest request puts the row back, and then to what the backend
     * holds, so a failed Settle and a failed Undo that overlap leave the row as
     * the backend has it.
     */
    private fun end(connectionId: String, threadId: String, token: Any, ok: Boolean, stored: Long?) {
        val revert = synchronized(ops) {
            val key = "$connectionId:$threadId"
            val op = ops[key] ?: return
            if (ok) {
                op.stored = stored
                op.fromList = false
            }
            if (op.token !== token) return
            ops.remove(key)
            op.takeUnless { ok }
        } ?: return
        if (revert.fromList) drop(connectionId, threadId) else put(connectionId, threadId, revert.stored)
    }

    /** Settle a Done or idle chat: the row leaves at once and comes back when the backend refuses. */
    fun settle(client: SwitchboardRemoteClient, threadId: String, settledAt: Long, onDone: (String?) -> Unit) {
        val token = begin(client.connectionId, threadId, stored = null, fromList = true)
        put(client.connectionId, threadId, settledAt)
        client.settleConversation(threadId) { response ->
            val failure = when (val outcome = response.outcome) {
                is RemoteOutcome.Failure -> outcome.message
                is RemoteOutcome.Success -> if (outcome.value) null else "the chat has no stored row"
            }
            end(client.connectionId, threadId, token, ok = failure == null, stored = settledAt)
            if (failure == null) {
                onDone(null)
            } else {
                SbLog.w(LOG_SCOPE, "could not settle $threadId; the row comes back: $failure")
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
        val token = begin(client.connectionId, undo.threadId, stored = undo.settledAt, fromList = false)
        put(client.connectionId, undo.threadId, null)
        val ended = undo.endedSnooze
        if (ended == null) {
            unsettle(client, undo, token, onDone)
            return
        }
        client.restoreSnooze(undo.threadId, ended) { response ->
            when (val outcome = response.outcome) {
                is RemoteOutcome.Failure -> {
                    SbLog.w(LOG_SCOPE, "snooze restore failed for ${undo.threadId}: ${outcome.message}")
                    unsettle(client, undo, token, onDone)
                }
                is RemoteOutcome.Success -> when (val answer = outcome.value) {
                    is ChatSnooze.SnoozeAnswer.Snoozed -> {
                        snoozeStore.put(client.connectionId, undo.threadId, ChatSnooze.snoozed(answer, now))
                        end(client.connectionId, undo.threadId, token, ok = true, stored = null)
                        onDone(null)
                    }
                    is ChatSnooze.SnoozeAnswer.Refused -> {
                        SbLog.i(LOG_SCOPE, "snooze not restored for ${undo.threadId}: ${answer.reason}")
                        unsettle(client, undo, token, onDone)
                    }
                }
            }
        }
    }

    private fun unsettle(
        client: SwitchboardRemoteClient,
        undo: ChatSettle.Undo,
        token: Any,
        onDone: (String?) -> Unit,
    ) {
        client.unsettleConversation(undo.threadId) { response ->
            val failure = when (val outcome = response.outcome) {
                is RemoteOutcome.Failure -> outcome.message
                is RemoteOutcome.Success -> if (outcome.value) null else "the chat has no stored row"
            }
            end(client.connectionId, undo.threadId, token, ok = failure == null, stored = null)
            if (failure == null) {
                onDone(null)
            } else {
                SbLog.w(LOG_SCOPE, "unsettle failed for ${undo.threadId}; the row goes back to what the backend holds: $failure")
                onDone("Could not undo the settle. Try again")
            }
        }
    }

    companion object {
        /** Longer than a project list read: after it the list wins over an entry it disagrees with. */
        const val HOLD_MS = 10_000L
        private const val LOG_SCOPE = "home:settle"
    }
}
