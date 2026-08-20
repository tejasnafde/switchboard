package app.switchboard.mobile.ui.browse

import app.switchboard.mobile.platform.protocol.TransportScope
import app.switchboard.mobile.protocol.JsonString
import app.switchboard.mobile.protocol.RuntimeEventPayload
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow

class BrowseThreadActivityIndex {
    private val mutableByScope = mutableMapOf<TransportScope, MutableStateFlow<Map<String, BrowseThreadActivity>>>()
    private val unreadMarked = mutableSetOf<Pair<TransportScope, String>>()
    private val pendingAttention = mutableMapOf<Pair<TransportScope, String>, PendingAttention>()

    @Synchronized
    fun state(scope: TransportScope): StateFlow<Map<String, BrowseThreadActivity>> =
        mutableByScope.getOrPut(scope) { MutableStateFlow(emptyMap()) }

    @Synchronized
    fun onEvent(scope: TransportScope, event: RuntimeEventPayload) {
        val flow = mutableByScope.getOrPut(scope) { MutableStateFlow(emptyMap()) }
        val before = flow.value[event.threadId] ?: BrowseThreadActivity(status = null, unread = 0)
        val key = scope to event.threadId
        val after = when (event.type) {
            "status" -> before.copy(status = (event.raw.values["status"] as? JsonString)?.value)
            "error" -> before.copy(status = "error")
            "turn.completed" -> {
                unreadMarked -= key
                before.copy(status = "idle")
            }
            "thread.read" -> {
                unreadMarked -= key
                before.copy(unread = 0)
            }
            "user.message" -> {
                unreadMarked -= key
                before
            }
            "content" -> {
                val streamKind = (event.raw.values["streamKind"] as? JsonString)?.value
                if (streamKind == "assistant" && unreadMarked.add(key)) {
                    before.copy(unread = before.unread + 1)
                } else {
                    before
                }
            }
            "request.opened" -> updateAttention(before, key, AttentionKind.Approval, opened = true, event)
            "request.closed" -> updateAttention(before, key, AttentionKind.Approval, opened = false, event)
            "question.asked" -> updateAttention(before, key, AttentionKind.Input, opened = true, event)
            "question.answered" -> updateAttention(before, key, AttentionKind.Input, opened = false, event)
            else -> before
        }
        if (after != before || event.threadId !in flow.value) {
            flow.value = flow.value + (event.threadId to after)
        }
    }

    @Synchronized
    fun markRead(scope: TransportScope, threadId: String) {
        val flow = mutableByScope.getOrPut(scope) { MutableStateFlow(emptyMap()) }
        val before = flow.value[threadId] ?: return
        unreadMarked -= scope to threadId
        flow.value = flow.value + (threadId to before.copy(unread = 0))
    }

    @Synchronized
    fun discardOtherGenerations(connectionId: String, generation: Long) {
        val stale = mutableByScope.keys.filter {
            it.connectionId == connectionId && it.generation != generation
        }
        stale.forEach(mutableByScope::remove)
        unreadMarked.removeAll { (scope, _) ->
            scope.connectionId == connectionId && scope.generation != generation
        }
        pendingAttention.keys.removeAll { (scope, _) ->
            scope.connectionId == connectionId && scope.generation != generation
        }
    }

    private fun updateAttention(
        activity: BrowseThreadActivity,
        key: Pair<TransportScope, String>,
        kind: AttentionKind,
        opened: Boolean,
        event: RuntimeEventPayload,
    ): BrowseThreadActivity {
        val requestId = (event.raw.values["requestId"] as? JsonString)
            ?.value
            ?.takeIf(String::isNotBlank)
            ?: return activity
        val before = pendingAttention[key] ?: PendingAttention()
        val after = when (kind) {
            AttentionKind.Approval -> before.copy(
                approvals = if (opened) before.approvals + requestId else before.approvals - requestId,
            )
            AttentionKind.Input -> before.copy(
                questions = if (opened) before.questions + requestId else before.questions - requestId,
            )
        }
        pendingAttention[key] = after
        return activity.copy(attention = after.presentation())
    }

    private data class PendingAttention(
        val approvals: Set<String> = emptySet(),
        val questions: Set<String> = emptySet(),
    ) {
        fun presentation(): BrowseThreadAttention = when {
            approvals.isNotEmpty() -> BrowseThreadAttention.Approval
            questions.isNotEmpty() -> BrowseThreadAttention.Input
            else -> BrowseThreadAttention.None
        }
    }

    private enum class AttentionKind {
        Approval,
        Input,
    }
}
