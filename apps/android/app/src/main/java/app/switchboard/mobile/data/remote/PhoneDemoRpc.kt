package app.switchboard.mobile.data.remote

import android.util.Log
import app.switchboard.mobile.domain.thread.ExpiredRequests
import app.switchboard.mobile.platform.protocol.Cancelable
import app.switchboard.mobile.platform.protocol.RequestSubmission
import app.switchboard.mobile.platform.protocol.RpcFailure
import app.switchboard.mobile.platform.protocol.RpcOutcome
import app.switchboard.mobile.platform.protocol.TransportScheduler
import app.switchboard.mobile.platform.protocol.TransportScope
import app.switchboard.mobile.protocol.JsonArray
import app.switchboard.mobile.protocol.JsonBoolean
import app.switchboard.mobile.protocol.JsonNull
import app.switchboard.mobile.protocol.JsonNumber
import app.switchboard.mobile.protocol.JsonObject
import app.switchboard.mobile.protocol.JsonString
import app.switchboard.mobile.protocol.JsonValue
import app.switchboard.mobile.protocol.RuntimeEventPayload
import java.io.Closeable

/**
 * The demo backend: answers [RemoteRpc] calls from [PhoneDemoFixture] and
 * plays its scripts on [scheduler]. The Kotlin twin of `DemoTransport` in
 * `src/shared/phone-demo/phone-demo.ts`; it holds no socket and writes nothing.
 *
 * Every answer and event runs on [scheduler], never inside [invoke], so a
 * caller that holds its own lock while it sends (the thread coordinator) sees
 * the echo after it has recorded the optimistic bubble, as with a real socket.
 *
 * One addition over the TS player: the events a chat has played are replayed
 * after its history loads. A native thread opens from `load-session-by-id`
 * alone, so without this a chat opened after its script ran would lose it.
 */
class PhoneDemoRpc(
    private val fixture: PhoneDemoFixture,
    private val scheduler: TransportScheduler,
    private val demoScope: TransportScope,
    private val nowMs: () -> Long = System::currentTimeMillis,
    private val log: (String) -> Unit = { Log.d(TAG, it) },
) : RemoteRpc, Closeable {
    private val listeners = linkedSetOf<(TransportScope, RuntimeEventPayload) -> Unit>()
    private val timers = mutableMapOf<String, List<Cancelable>>()
    private val status = mutableMapOf<String, String>()
    private val pending = fixture.chats.associateTo(mutableMapOf()) { it.id to it.pending.toMutableList() }
    private val played = mutableMapOf<String, MutableList<JsonObject>>()
    private var started = false
    private var closed = false
    private var plays = 0
    private var requests = 0L

    override val scope: TransportScope?
        @Synchronized get() = if (closed) null else demoScope

    override fun invoke(
        expectedScope: TransportScope,
        channel: String,
        args: JsonArray,
        callback: (RpcOutcome) -> Unit,
    ): RequestSubmission {
        val requestId = synchronized(this) {
            if (closed || expectedScope != demoScope) null else ++requests
        }
        if (requestId == null) {
            callback(RpcOutcome.Failure(RpcFailure.ConnectionReplaced))
            return RequestSubmission.Rejected(RpcFailure.ConnectionReplaced)
        }
        scheduler.schedule(0) {
            val outcome = synchronized(this) {
                if (closed) {
                    RpcOutcome.Failure(RpcFailure.Remote(ENDED))
                } else {
                    try {
                        RpcOutcome.Success(answer(channel, args.values))
                    } catch (refusal: DemoRefusal) {
                        log("refused $channel: ${refusal.message}")
                        RpcOutcome.Failure(RpcFailure.Remote(refusal.message.orEmpty()))
                    }
                }
            }
            callback(outcome)
            if (channel == BackendChannels.LoadSession) replay(args.values.firstOrNull().stringOrNull())
        }
        return RequestSubmission.Accepted(requestId, demoScope)
    }

    override fun onRuntimeEvent(listener: (TransportScope, RuntimeEventPayload) -> Unit): Cancelable {
        synchronized(this) {
            if (closed) return Cancelable {}
            listeners += listener
            if (!started) {
                started = true
                fixture.chats.forEach { play(it.id, "connect") }
            }
        }
        return Cancelable { synchronized(this) { listeners -= listener } }
    }

    /** A thread's status as the demo backend sees it. */
    @Synchronized
    fun statusOf(threadId: String): String = status[threadId] ?: "idle"

    @Synchronized
    override fun close() {
        if (closed) return
        closed = true
        timers.values.flatten().forEach(Cancelable::cancel)
        timers.clear()
        listeners.clear()
        played.clear()
    }

    private fun play(threadId: String, name: String) {
        timers[threadId]?.forEach(Cancelable::cancel)
        val steps = fixture.script(threadId, name, "demo-$name-${++plays}")
        timers[threadId] = steps.map { step -> scheduler.schedule(step.atMs) { emit(step.event) } }
    }

    private fun emit(event: JsonObject) {
        val targets = synchronized(this) {
            if (closed) return
            val threadId = event.stringOrNull("threadId") ?: return
            when (event.stringOrNull("type")) {
                "status" -> event.stringOrNull("status")?.let { status[threadId] = it }
                "request.closed" -> pending[threadId]?.removeAll {
                    it.stringOrNull("requestId") == event.stringOrNull("requestId")
                }
            }
            played.getOrPut(threadId) { mutableListOf() } += event
            listeners.toList()
        }
        deliver(targets, event)
    }

    /** Plays a chat's past events again for a thread screen that just loaded its history. */
    private fun replay(threadId: String?) {
        val (targets, events) = synchronized(this) {
            if (closed || threadId == null) return
            listeners.toList() to played[threadId].orEmpty().toList()
        }
        events.forEach { deliver(targets, it) }
    }

    private fun deliver(targets: List<(TransportScope, RuntimeEventPayload) -> Unit>, event: JsonObject) {
        val payload = RuntimeEventPayload.parse(event) ?: return
        targets.forEach { it(demoScope, payload) }
    }

    /**
     * The user's message echoes back first, then the scripted reply plays.
     * Both are queued rather than emitted here: [answer] runs under this
     * object's lock, and a listener takes its own lock.
     */
    private fun acceptTurn(threadId: String, text: String, origin: String?, displayBody: String?) {
        chat(threadId)
        val echo =
            JsonObject(
                linkedMapOf<String, JsonValue>(
                    "type" to JsonString("user.message"),
                    "threadId" to JsonString(threadId),
                    "text" to JsonString(text),
                ).apply {
                    displayBody?.let { put("displayBody", JsonString(it)) }
                    origin?.let { put("origin", JsonString(it)) }
                    put("at", JsonNumber(nowMs().toString()))
                },
            )
        timers[threadId]?.forEach(Cancelable::cancel)
        val echoTimer = scheduler.schedule(0) { emit(echo) }
        play(threadId, "reply")
        timers[threadId] = listOf(echoTimer) + timers[threadId].orEmpty()
    }

    private fun chat(threadId: String?): PhoneDemoFixture.Chat =
        threadId?.let(fixture::chat) ?: throw DemoRefusal(NOT_IN_DEMO)

    private fun answer(channel: String, args: List<JsonValue>): JsonValue? = when (channel) {
        BackendChannels.ServerVersion -> JsonString("demo")
        BackendChannels.GetProjects -> projects()
        BackendChannels.ListWorkspaces,
        BackendChannels.ListQueuedTurns,
        BackendChannels.ListSkills,
        BackendChannels.ListCatalog,
        BackendChannels.ListProviderInstances,
        BackendChannels.PullRequestLinks,
        BackendChannels.PullRequestLinkableChats,
        -> JsonArray(emptyList())
        BackendChannels.GetConversations -> conversations(args.firstOrNull().stringOrNull())
        BackendChannels.LoadSession -> loadSession(args.firstOrNull().stringOrNull())
        BackendChannels.MarkRead -> obj("ok" to JsonBoolean(true), "at" to number(nowMs()))
        GET_PENDING_HANDOFF -> obj("from" to JsonNull)
        SET_PENDING_HANDOFF -> obj("ok" to JsonBoolean(true))
        BackendChannels.GetSetting,
        BackendChannels.ListModels,
        // The pickers keep their choice on the phone; nothing runs to apply it to.
        BackendChannels.SetRuntimeMode,
        BackendChannels.SetModel,
        BackendChannels.StopSession,
        -> null
        BackendChannels.PushViewing -> obj("ok" to JsonBoolean(true))
        BackendChannels.StartSession -> {
            val chat = chat((args.firstOrNull() as? JsonObject)?.stringOrNull("threadId"))
            obj(
                "threadId" to JsonString(chat.id),
                "provider" to JsonString("claude"),
                "status" to JsonString(statusOf(chat.id)),
                "cwd" to JsonString(fixture.projectPath),
            )
        }
        BackendChannels.GetPendingRequests ->
            JsonArray(pending[args.firstOrNull().stringOrNull()].orEmpty().toList())
        BackendChannels.SubmitUserTurn -> {
            val envelope = args.firstOrNull() as? JsonObject ?: throw DemoRefusal(NOT_IN_DEMO)
            acceptTurn(
                threadId = chat(envelope.stringOrNull("threadId")).id,
                text = envelope.stringOrNull("providerText").orEmpty(),
                origin = envelope.stringOrNull("origin"),
                displayBody = envelope.stringOrNull("displayBody"),
            )
            obj(
                "status" to JsonString("accepted"),
                "accepted" to JsonBoolean(true),
                "duplicate" to JsonBoolean(false),
                "state" to JsonString("completed"),
                "acceptedAt" to number(nowMs()),
            )
        }
        BackendChannels.SendTurn -> {
            acceptTurn(
                threadId = chat(args.getOrNull(0).stringOrNull()).id,
                text = args.getOrNull(1).stringOrNull().orEmpty(),
                origin = args.getOrNull(4).stringOrNull(),
                displayBody = null,
            )
            null
        }
        BackendChannels.RespondToRequest -> {
            val threadId = args.getOrNull(0).stringOrNull().orEmpty()
            val requestId = args.getOrNull(1).stringOrNull()
            if (pending[threadId].orEmpty().none { it.stringOrNull("requestId") == requestId }) {
                throw DemoRefusal(ExpiredRequests.REFUSED)
            }
            play(threadId, if (args.getOrNull(2).stringOrNull() == "approve") "approve" else "deny")
            null
        }
        BackendChannels.Interrupt -> {
            val threadId = args.firstOrNull().stringOrNull().orEmpty()
            val live = statusOf(threadId) == "running"
            if (live) play(threadId, "interrupt")
            obj("live" to JsonBoolean(live))
        }
        BackendChannels.PullRequestList -> pullRequestList()
        BackendChannels.PullRequestDetail -> {
            val pr = findPullRequest(args.firstOrNull()) ?: throw DemoRefusal(NOT_IN_DEMO)
            val detail = pr.values["detail"] as? JsonObject
            val merged = LinkedHashMap(pr.values).apply {
                remove("detail")
                detail?.values?.let(::putAll)
            }
            obj("ok" to JsonBoolean(true), "data" to JsonObject(merged))
        }
        BackendChannels.PullRequestLinkedChats -> {
            val branch = findPullRequest(args.firstOrNull())?.stringOrNull("sourceBranch")
            JsonArray(
                fixture.chats.filter { branch != null && it.branch == branch }.map { chat ->
                    obj(
                        "id" to JsonString(chat.id),
                        "familyIds" to JsonArray(listOf(JsonString(chat.id))),
                        "title" to JsonString(chat.title),
                        "agentType" to JsonString(chat.agentType),
                        "projectPath" to JsonString(fixture.projectPath),
                        "updatedAt" to number(chat.updatedAt),
                        "linkSource" to JsonString("auto"),
                    )
                },
            )
        }
        else -> throw DemoRefusal(NOT_IN_DEMO)
    }

    private fun projects(): JsonArray = JsonArray(
        listOf(
            obj(
                "path" to JsonString(fixture.projectPath),
                "name" to JsonString(fixture.projectName),
                "workspaceId" to JsonNull,
                "sessions" to JsonArray(
                    fixture.chats.map { chat ->
                        obj(
                            "id" to JsonString(chat.id),
                            "source" to JsonString("claude-code"),
                            "title" to JsonString(chat.title),
                            "startedAt" to number(chat.startedAt),
                            "messageCount" to number(chat.messages.size.toLong()),
                            "filePath" to JsonString(""),
                            "worktreeBranch" to JsonString(chat.branch),
                            "agentType" to JsonString(chat.agentType),
                            "statusLine" to JsonString(chat.statusLine),
                        )
                    },
                ),
            ),
        ),
    )

    private fun conversations(projectPath: String?): JsonArray {
        if (projectPath != fixture.projectPath) return JsonArray(emptyList())
        return JsonArray(
            fixture.chats.map { chat ->
                obj(
                    "id" to JsonString(chat.id),
                    "project_path" to JsonString(fixture.projectPath),
                    "agent_type" to JsonString(chat.agentType),
                    "session_id" to JsonNull,
                    "title" to JsonString(chat.title),
                    "created_at" to number(chat.startedAt),
                    "updated_at" to number(chat.updatedAt),
                    "worktree_branch" to JsonString(chat.branch),
                    "status_line" to JsonString(chat.statusLine),
                )
            },
        )
    }

    private fun loadSession(threadId: String?): JsonObject {
        val chat = threadId?.let(fixture::chat)
            ?: return obj("messages" to JsonArray(emptyList()), "meta" to JsonNull)
        return obj(
            "messages" to JsonArray(chat.messages),
            "total" to number(chat.messages.size.toLong()),
            "meta" to obj(
                "id" to JsonString(chat.id),
                "title" to JsonString(chat.title),
                "projectPath" to JsonString(fixture.projectPath),
                "agentType" to JsonString(chat.agentType),
                "worktreeBranch" to JsonString(chat.branch),
            ),
        )
    }

    private fun pullRequestList(): JsonObject {
        val first = fixture.pullRequests.firstOrNull()?.values?.get("ref") as? JsonObject
        val sources = first?.let { ref ->
            listOf(
                obj(
                    "repo" to obj(
                        "host" to (ref.values["host"] ?: JsonNull),
                        "owner" to (ref.values["owner"] ?: JsonNull),
                        "name" to (ref.values["name"] ?: JsonNull),
                    ),
                    "projectPaths" to JsonArray(listOf(JsonString(fixture.projectPath))),
                    "error" to JsonNull,
                ),
            )
        }.orEmpty()
        return obj(
            "ok" to JsonBoolean(true),
            "data" to obj(
                "prs" to JsonArray(
                    fixture.pullRequests.map { pr -> JsonObject(LinkedHashMap(pr.values).apply { remove("detail") }) },
                ),
                "sources" to JsonArray(sources),
                "unsupportedProjects" to JsonArray(emptyList()),
                "fetchedAt" to number(nowMs()),
                "hidden" to JsonArray(emptyList()),
            ),
        )
    }

    private fun findPullRequest(raw: JsonValue?): JsonObject? {
        val wanted = raw as? JsonObject ?: return null
        return fixture.pullRequests.firstOrNull { pr ->
            val ref = pr.values["ref"] as? JsonObject ?: return@firstOrNull false
            ref.numberOrNull("number") == wanted.numberOrNull("number") &&
                listOf("owner", "name", "host").all { ref.stringOrNull(it) == wanted.stringOrNull(it) }
        }
    }

    private class DemoRefusal(message: String) : RuntimeException(message)

    companion object {
        /** What a demo screen says when the user reaches for something it cannot do. */
        const val NOT_IN_DEMO = "Not in the demo. Pair a machine to use this."
        const val ENDED = "The demo has ended"
        private const val GET_PENDING_HANDOFF = "app:get-conversation-pending-handoff"
        private const val SET_PENDING_HANDOFF = "app:set-conversation-pending-handoff"
        private const val TAG = "PhoneDemoRpc"
    }
}

private fun obj(vararg fields: Pair<String, JsonValue>): JsonObject = JsonObject(linkedMapOf(*fields))

private fun number(value: Long): JsonNumber = JsonNumber(value.toString())

private fun JsonValue?.stringOrNull(): String? = (this as? JsonString)?.value

private fun JsonObject.stringOrNull(key: String): String? = (values[key] as? JsonString)?.value

private fun JsonObject.numberOrNull(key: String): Double? = (values[key] as? JsonNumber)?.source?.toDoubleOrNull()
