package app.switchboard.mobile.domain.thread

import app.switchboard.mobile.platform.log.SbLog
import app.switchboard.mobile.protocol.JsonArray
import app.switchboard.mobile.protocol.JsonNumber
import app.switchboard.mobile.protocol.JsonObject
import app.switchboard.mobile.protocol.JsonString
import app.switchboard.mobile.protocol.JsonValue
import app.switchboard.mobile.protocol.booleanOrNull
import app.switchboard.mobile.protocol.longOrNull
import app.switchboard.mobile.protocol.stringOrNull
import kotlin.math.roundToLong

/**
 * Child chats ("hub") on the phone: the view a chat reads and the rules the
 * desktop strip uses. Port of the client view and its rules in
 * src/shared/hub.ts, checked against tests/fixtures/hub-cases.json.
 */
const val HUB_CHILDREN_CAPABILITY = "hub_children_v1"
const val HUB_REMOTE_CHILDREN_CAPABILITY = "hub_remote_children_v1"

/** Runtime event: a parent's children changed. Its `threadId` is the parent's root id. */
const val HUB_CHILDREN_CHANGED = "hub.children-changed"

const val HUB_REMOTE_CHILD_NO_REPORT = "No report yet."
const val HUB_REMOTE_CHILD_READ_NOTE = "Read on the desktop."
const val HUB_UNKNOWN_CHILD_STATE = "Unknown state"

private const val LOG_SCOPE = "hub"

enum class HubChildPhase(val wire: String) {
    Starting("starting"),
    Open("open"),
    Settled("settled"),
    FailedStart("failed_start"),
    ;

    val isOpen: Boolean get() = this == Starting || this == Open

    companion object {
        fun fromWire(wire: String?): HubChildPhase? = entries.firstOrNull { it.wire == wire }
    }
}

enum class ChildState(val wire: String, val label: String) {
    Settled("settled", "Settled"),
    Starting("starting", "Starting"),
    NeedsYou("needs_you", "Needs you"),
    Working("working", "Working"),
    Limited("limited", "Limited"),
    AskedHub("asked_hub", "Asked the hub"),
    ResultReady("result_ready", "Result ready"),
    Blocked("blocked", "Blocked"),
    Failed("failed", "Failed"),
    Paused("paused", "Paused"),

    /** A state a newer backend sends that this build does not know: still listed and counted. */
    Unknown("", HUB_UNKNOWN_CHILD_STATE),
    ;

    companion object {
        fun fromWire(wire: String?): ChildState? = entries.firstOrNull { it != Unknown && it.wire == wire }
    }
}

/** `Working` and `Limited` are the PARENT's own turn and limit, not its children's: the label says whose. */
enum class ParentState(val wire: String, val label: String?) {
    Working("working", "This chat is working"),
    Limited("limited", "This chat is limited"),
    UpdatesReady("updates_ready", "Updates ready"),
    Waiting("waiting", "Waiting for children"),
    Done("done", "Done"),
    Idle("idle", null),
    ;

    companion object {
        fun fromWire(wire: String?): ParentState? = entries.firstOrNull { it.wire == wire }
    }
}

/** A chat the hub UI can open: root id, every id of its thread, title, agent, project. */
data class HubChatRef(
    val id: String,
    val familyIds: List<String>,
    val title: String,
    val agentType: String,
    val projectPath: String,
    val updatedAt: Long,
    /** Its worktree: the session starts there before the chat's history is loaded. */
    val worktreePath: String? = null,
)

data class HubWake(val kind: String, val summary: String)

/** A child on another machine. Only shown while `hub_remote_children_v1` is advertised. */
data class HubRemoteChild(
    val machineId: String,
    val machine: String,
    val connected: Boolean,
    val reconnecting: Boolean = false,
    val ageMs: Long?,
    val stopping: Boolean,
)

data class HubChildView(
    val chat: HubChatRef,
    /** The id its session runs under now; Stop goes there. */
    val liveId: String?,
    val phase: HubChildPhase,
    val state: ChildState,
    /** Working, but it already reported: its native subagents still run. */
    val reported: Boolean = false,
    val limit: String = "none",
    val waitingForSlot: Boolean = false,
    val account: String? = null,
    val branch: String? = null,
    val lastWake: HubWake? = null,
    val remote: HubRemoteChild? = null,
)

/** `provider:hub-list-children` answer. */
data class HubChatView(
    val self: HubChatRef?,
    val parent: HubChatRef?,
    val children: List<HubChildView>,
    val state: ParentState?,
    val heldUpdates: Long? = null,
) {
    /** The view with every `remote` field dropped, for a backend without `hub_remote_children_v1`. */
    fun withoutRemote(): HubChatView =
        if (children.none { it.remote != null }) this else copy(children = children.map { it.copy(remote = null) })

    companion object {
        val EMPTY = HubChatView(self = null, parent = null, children = emptyList(), state = null)
    }
}

object HubChildren {
    /**
     * Decodes a `provider:hub-list-children` answer. A state this build does
     * not know reads as [ChildState.Unknown]; a child with a malformed chat or
     * an unknown phase is left out and logged.
     */
    fun decode(value: JsonValue?): HubChatView {
        val raw = value as? JsonObject ?: return HubChatView.EMPTY
        val children = (raw.values["children"] as? JsonArray)?.values.orEmpty().mapNotNull { child(it) }
        val stateWire = raw.stringOrNull("state")
        val state = ParentState.fromWire(stateWire)
        if (stateWire != null && state == null) SbLog.w(LOG_SCOPE, "unknown parent state $stateWire")
        return HubChatView(
            self = chatRef(raw.values["self"]),
            parent = chatRef(raw.values["parent"]),
            children = children,
            state = state,
            heldUpdates = raw.longOrNull("heldUpdates"),
        )
    }

    private fun child(value: JsonValue): HubChildView? {
        val raw = value as? JsonObject ?: return null
        val chat = chatRef(raw.values["chat"])
        if (chat == null) {
            SbLog.w(LOG_SCOPE, "child without a chat left out")
            return null
        }
        val stateWire = raw.stringOrNull("state")
        val state = ChildState.fromWire(stateWire) ?: ChildState.Unknown.also {
            SbLog.w(LOG_SCOPE, "child ${chat.id} has unknown state $stateWire")
        }
        val phase = HubChildPhase.fromWire(raw.stringOrNull("phase"))
        if (phase == null) {
            SbLog.w(LOG_SCOPE, "child ${chat.id} left out: unknown phase ${raw.stringOrNull("phase")}")
            return null
        }
        return HubChildView(
            chat = chat,
            liveId = raw.stringOrNull("liveId"),
            phase = phase,
            state = state,
            reported = raw.booleanOrNull("reported") == true,
            limit = raw.stringOrNull("limit") ?: "none",
            waitingForSlot = raw.booleanOrNull("waitingForSlot") == true,
            account = raw.stringOrNull("account"),
            branch = raw.stringOrNull("branch"),
            lastWake = (raw.values["lastWake"] as? JsonObject)?.let { wake ->
                val kind = wake.stringOrNull("kind") ?: return@let null
                HubWake(kind, wake.stringOrNull("summary").orEmpty())
            },
            remote = remote(raw.values["remote"]),
        )
    }

    /** A `remote` note, read from the wire or a fixture. */
    fun remote(value: JsonValue?): HubRemoteChild? {
        val raw = value as? JsonObject ?: return null
        val machineId = raw.stringOrNull("machineId") ?: return null
        return HubRemoteChild(
            machineId = machineId,
            machine = raw.stringOrNull("machine") ?: machineId,
            connected = raw.booleanOrNull("connected") == true,
            reconnecting = raw.booleanOrNull("reconnecting") == true,
            ageMs = (raw.values["ageMs"] as? JsonNumber)?.source?.toDoubleOrNull()?.toLong(),
            stopping = raw.booleanOrNull("stopping") == true,
        )
    }

    private fun chatRef(value: JsonValue?): HubChatRef? {
        val raw = value as? JsonObject ?: return null
        return HubChatRef(
            id = raw.stringOrNull("id") ?: return null,
            familyIds = (raw.values["familyIds"] as? JsonArray)?.values.orEmpty()
                .mapNotNull { (it as? JsonString)?.value },
            title = raw.stringOrNull("title").orEmpty(),
            agentType = raw.stringOrNull("agentType").orEmpty(),
            projectPath = raw.stringOrNull("projectPath").orEmpty(),
            updatedAt = (raw.values["updatedAt"] as? JsonNumber)?.source?.toDoubleOrNull()?.toLong() ?: 0,
            worktreePath = raw.stringOrNull("worktreePath"),
        )
    }

    /** "40 s", "3 min", "2 h", "4 days". Rounds half up, like `Math.round`. */
    fun formatAge(ms: Long): String {
        val s = maxOf(0L, jsRound(ms / 1000.0))
        return when {
            s < 60 -> "$s s"
            s < 3600 -> "${jsRound(s / 60.0)} min"
            s < 48 * 3600 -> "${jsRound(s / 3600.0)} h"
            else -> "${jsRound(s / 86400.0)} days"
        }
    }

    /**
     * The state text of a child. A child on another machine names it while it
     * waits for a slot or an approval there, while its machine reconnects, and
     * while a Stop waits; a machine that is not connected replaces the state.
     */
    fun childStateLabel(child: HubChildView): String {
        val r = child.remote
        if (r?.stopping == true) return "Stopping on ${r.machine}"
        if (r != null && !r.connected) {
            if (r.reconnecting) return "Reconnecting on ${r.machine}"
            return "${r.machine} offline${r.ageMs?.let { ", last seen ${formatAge(it)} ago" }.orEmpty()}"
        }
        if (child.reported) return "Reported, subagents still running"
        val on = r?.let { " on ${it.machine}" }.orEmpty()
        if (child.state == ChildState.Starting && child.waitingForSlot) return "Waiting for a slot$on"
        if (child.state == ChildState.NeedsYou && r != null) return "Needs approval$on"
        return child.state.label
    }

    /** The short state word of a narrow row; its machine badge names the machine. */
    fun childStateWord(child: HubChildView): String {
        val r = child.remote
        if (r?.stopping == true) return "Stopping"
        if (r != null && !r.connected) return if (r.reconnecting) "Reconnecting" else "Offline"
        return child.state.label
    }

    fun parentStateLabel(state: ParentState?): String? = state?.label

    /** "1 child", "3 children". */
    fun childCount(n: Int): String = "$n ${if (n == 1) "child" else "children"}"

    /** "3 children", or "4 children on 3 machines" when they run on more than one machine (this one counts). */
    fun childrenCount(children: List<HubChildView>): String {
        val machines = children.map { it.remote?.machineId ?: LOCAL_MACHINE }.toSet().size
        return childCount(children.size) + if (machines > 1) " on $machines machines" else ""
    }

    /** The chip: "Hub · 3 children" and the parent state when it has one. */
    fun chipText(view: HubChatView): String {
        val label = parentStateLabel(view.state)
        return "Hub · ${childrenCount(view.children)}${label?.let { " · $it" }.orEmpty()}"
    }

    /**
     * Whether a child row offers Stop. A remote child's state is unknown while
     * its machine is not connected, so its Stop stays offered while it is open.
     */
    fun canStop(child: HubChildView): Boolean {
        val r = child.remote
        return if (r != null) {
            !r.stopping && (child.state == ChildState.Working || (!r.connected && child.phase.isOpen))
        } else {
            child.state == ChildState.Working && child.liveId != null
        }
    }

    /** Where a child's Stop goes (`provider:interrupt`): its live session, or a remote child's own id. */
    fun stopTarget(child: HubChildView): String? = child.liveId ?: child.remote?.let { child.chat.id }

    /**
     * The chat list's rule: a row whose hub parent is another row of the same
     * list is left out; a child whose parent is absent stays.
     */
    fun <T> topLevel(rows: List<T>, id: (T) -> String, parentId: (T) -> String?): List<T> {
        val ids = rows.mapTo(mutableSetOf(), id)
        return rows.filterNot { row -> parentId(row)?.let { it in ids } == true }
    }

    private const val LOCAL_MACHINE = "local"

    private fun jsRound(value: Double): Long = Math.floor(value + 0.5).roundToLong()
}
