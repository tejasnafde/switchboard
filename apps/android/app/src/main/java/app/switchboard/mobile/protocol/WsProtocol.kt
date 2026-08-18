package app.switchboard.mobile.protocol

data class ResumeCursor(
    val epoch: String?,
    val sequence: Long?,
)

sealed interface WsFrame {
    data class Request(
        val id: Long,
        val channel: String,
        val args: JsonArray,
    ) : WsFrame

    sealed interface Response : WsFrame {
        val id: Long

        data class Success(
            override val id: Long,
            val result: JsonValue?,
        ) : Response

        data class Failure(
            override val id: Long,
            val error: String,
        ) : Response
    }

    data class Send(
        val channel: String,
        val args: JsonArray,
    ) : WsFrame

    data class Event(
        val channel: String,
        val args: JsonArray,
        val sequence: Long?,
    ) : WsFrame

    data class Hello(
        val resume: ResumeCursor?,
    ) : WsFrame

    data class Ready(
        val epoch: String,
        val sequence: Long,
        val replayed: Long,
        val gap: Boolean,
    ) : WsFrame

    data class Ping(val timestamp: Long) : WsFrame

    data class Pong(val timestamp: Long) : WsFrame

    data class Auth(
        val session: String? = null,
        val pairing: String? = null,
        val label: String? = null,
    ) : WsFrame

    sealed interface Authed : WsFrame {
        data class Success(
            val session: String?,
            val scopes: List<String>,
        ) : Authed

        data class Failure(
            val error: String,
        ) : Authed
    }
}

fun WsFrame.toJson(): JsonObject {
    fun jsonObject(vararg values: Pair<String, JsonValue?>): JsonObject {
        val map = linkedMapOf<String, JsonValue>()
        values.forEach { (key, value) -> if (value != null) map[key] = value }
        return JsonObject(map)
    }

    fun number(value: Long) = JsonNumber(value.toString())

    return when (this) {
        is WsFrame.Request -> jsonObject(
            "k" to JsonString("req"),
            "id" to number(id),
            "ch" to JsonString(channel),
            "args" to args,
        )
        is WsFrame.Response.Success -> jsonObject(
            "k" to JsonString("res"),
            "id" to number(id),
            "ok" to JsonBoolean(true),
            "result" to result,
        )
        is WsFrame.Response.Failure -> jsonObject(
            "k" to JsonString("res"),
            "id" to number(id),
            "ok" to JsonBoolean(false),
            "error" to JsonString(error),
        )
        is WsFrame.Send -> jsonObject(
            "k" to JsonString("snd"),
            "ch" to JsonString(channel),
            "args" to args,
        )
        is WsFrame.Event -> jsonObject(
            "k" to JsonString("evt"),
            "ch" to JsonString(channel),
            "args" to args,
            "seq" to sequence?.let(::number),
        )
        is WsFrame.Hello -> jsonObject(
            "k" to JsonString("hello"),
            "since" to resume?.sequence?.let(::number),
            "epoch" to resume?.epoch?.let(::JsonString),
        )
        is WsFrame.Ready -> jsonObject(
            "k" to JsonString("ready"),
            "epoch" to JsonString(epoch),
            "seq" to number(sequence),
            "replayed" to number(replayed),
            "gap" to JsonBoolean(gap),
        )
        is WsFrame.Ping -> jsonObject("k" to JsonString("ping"), "t" to number(timestamp))
        is WsFrame.Pong -> jsonObject("k" to JsonString("pong"), "t" to number(timestamp))
        is WsFrame.Auth -> jsonObject(
            "k" to JsonString("auth"),
            "session" to session?.let(::JsonString),
            "pairing" to pairing?.let(::JsonString),
            "label" to label?.let(::JsonString),
        )
        is WsFrame.Authed.Success -> jsonObject(
            "k" to JsonString("authed"),
            "ok" to JsonBoolean(true),
            "session" to session?.let(::JsonString),
            "scopes" to JsonArray(scopes.map(::JsonString)),
        )
        is WsFrame.Authed.Failure -> jsonObject(
            "k" to JsonString("authed"),
            "ok" to JsonBoolean(false),
            "error" to JsonString(error),
        )
    }
}

object WsProtocol {
    fun encode(frame: WsFrame): String = JsonCodec.encode(frame.toJson())

    fun decode(wire: String): WsFrame? {
        val frame = try {
            JsonCodec.parse(wire) as? JsonObject
        } catch (_: RuntimeException) {
            null
        } ?: return null

        return when (frame.stringOrNull("k")) {
            "req" -> {
                val id = frame.longOrNull("id") ?: return null
                val channel = frame.stringOrNull("ch") ?: return null
                val args = frame.values["args"] as? JsonArray ?: return null
                WsFrame.Request(id, channel, args)
            }
            "res" -> {
                val id = frame.longOrNull("id") ?: return null
                when (frame.booleanOrNull("ok")) {
                    true -> WsFrame.Response.Success(id, frame.values["result"])
                    false -> WsFrame.Response.Failure(
                        id,
                        frame.stringOrNull("error") ?: return null,
                    )
                    null -> null
                }
            }
            "snd" -> {
                val channel = frame.stringOrNull("ch") ?: return null
                val args = frame.values["args"] as? JsonArray ?: return null
                WsFrame.Send(channel, args)
            }
            "evt" -> {
                val channel = frame.stringOrNull("ch") ?: return null
                val args = frame.values["args"] as? JsonArray ?: return null
                WsFrame.Event(channel, args, frame.longOrNull("seq"))
            }
            "hello" -> {
                val since = frame.longOrNull("since")
                val epoch = frame.stringOrNull("epoch")
                WsFrame.Hello(
                    if (since == null && epoch == null) null else ResumeCursor(epoch, since),
                )
            }
            "ready" -> WsFrame.Ready(
                epoch = frame.stringOrNull("epoch") ?: return null,
                sequence = frame.longOrNull("seq") ?: return null,
                replayed = frame.longOrNull("replayed") ?: return null,
                gap = frame.booleanOrNull("gap") ?: return null,
            )
            "ping" -> WsFrame.Ping(frame.longOrNull("t") ?: return null)
            "pong" -> WsFrame.Pong(frame.longOrNull("t") ?: return null)
            "auth" -> {
                val session = frame.stringOrNull("session")
                val pairing = frame.stringOrNull("pairing")
                if (session == null && pairing == null) return null
                WsFrame.Auth(session, pairing, frame.stringOrNull("label"))
            }
            "authed" -> when (frame.booleanOrNull("ok")) {
                true -> {
                    val scopes = (frame.values["scopes"] as? JsonArray)?.values
                        ?.map { (it as? JsonString)?.value ?: return null }
                        ?: return null
                    WsFrame.Authed.Success(frame.stringOrNull("session"), scopes)
                }
                false -> WsFrame.Authed.Failure(frame.stringOrNull("error") ?: return null)
                null -> null
            }
            else -> null
        }
    }
}

enum class RuntimeEventKind {
    Known,
    Extension,
}

data class RuntimeEventPayload(
    val type: String,
    val threadId: String,
    val kind: RuntimeEventKind,
    val raw: JsonObject,
) {
    companion object {
        private val knownTypes = setOf(
            "content",
            "user.message",
            "tool.started",
            "tool.completed",
            "tool.denied",
            "request.opened",
            "request.closed",
            "turn.completed",
            "turn.retrying",
            "error",
            "status",
            "session",
            "session.provider",
            "context_window",
            "model.variants",
            "plan.proposed",
            "question.asked",
            "question.answered",
            "file.edited",
            "worktree.drift",
            "spend.blocked",
            "thread.read",
            "peer.message",
            "todo.updated",
        )

        fun parse(raw: JsonObject): RuntimeEventPayload? {
            val type = raw.stringOrNull("type") ?: return null
            val threadId = raw.stringOrNull("threadId") ?: return null
            return RuntimeEventPayload(
                type = type,
                threadId = threadId,
                kind = if (type in knownTypes) RuntimeEventKind.Known else RuntimeEventKind.Extension,
                raw = raw,
            )
        }
    }
}
