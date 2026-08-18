package app.switchboard.mobile.ui.browse

import app.switchboard.mobile.platform.protocol.TransportScope
import app.switchboard.mobile.protocol.JsonString
import app.switchboard.mobile.protocol.RuntimeEventPayload
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow

class BrowseThreadActivityIndex {
    private val mutableByScope = mutableMapOf<TransportScope, MutableStateFlow<Map<String, BrowseThreadActivity>>>()
    private val unreadMarked = mutableSetOf<Pair<TransportScope, String>>()

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
    }
}
