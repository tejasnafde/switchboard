package app.switchboard.mobile.data.remote

import app.switchboard.mobile.protocol.JsonArray
import app.switchboard.mobile.protocol.JsonCodec
import app.switchboard.mobile.protocol.JsonNumber
import app.switchboard.mobile.protocol.JsonObject
import app.switchboard.mobile.protocol.JsonString
import app.switchboard.mobile.protocol.JsonValue

/**
 * The demo fixture, `src/shared/phone-demo/fixture/phone-demo.json`. The build
 * packs that one file as the asset [ASSET_NAME], so this phone shows the same
 * demo as the Expo app. The conventions are the ones in `phone-demo.ts`:
 * `@now`, `@now-60000` and `@now+5000` are times relative to the demo start,
 * and in a script `@thread` is the chat it plays in and `@message` a fresh id.
 */
class PhoneDemoFixture private constructor(private val root: JsonObject) {
    val connectionId: String = root.obj("connection").string("id")
    val connectionLabel: String = root.obj("connection").string("label")
    val projectPath: String = root.obj("project").string("path")
    val projectName: String = root.obj("project").string("name")
    val chats: List<Chat> = root.array("chats").map { Chat(it as JsonObject) }
    val pullRequests: List<JsonObject> = root.array("pullRequests").map { it as JsonObject }
    private val scripts: JsonObject = root.obj("scripts")

    class Chat internal constructor(val raw: JsonObject) {
        val id: String = raw.string("id")
        val title: String = raw.string("title")
        val agentType: String = raw.string("agentType")
        val branch: String = raw.string("branch")
        val updatedAt: Long = raw.long("updatedAt")
        val statusLine: String = raw.string("statusLine")
        val messages: List<JsonObject> = raw.array("messages").map { it as JsonObject }
        val pending: List<JsonObject> = raw.array("pending").map { it as JsonObject }
        internal val scripts: JsonObject = raw.obj("scripts")

        /** When the chat started: its first message, else its last update. */
        val startedAt: Long
            get() = (messages.firstOrNull()?.values?.get("timestamp") as? JsonNumber)?.source?.toLongOrNull() ?: updatedAt
    }

    data class Step(val atMs: Long, val event: JsonObject)

    fun chat(id: String): Chat? = chats.firstOrNull { it.id == id }

    /** A chat's script, or the global one of that name, with `@thread` and `@message` filled in. */
    fun script(chatId: String, name: String, messageId: String): List<Step> {
        val steps = chat(chatId)?.scripts?.values?.get(name) as? JsonArray
            ?: scripts.values[name] as? JsonArray
            ?: return emptyList()
        val tokens = mapOf(THREAD_TOKEN to chatId, MESSAGE_TOKEN to messageId)
        return steps.values.map { step ->
            val raw = step as JsonObject
            Step(
                atMs = raw.long("atMs"),
                event = substitute(raw.obj("event"), tokens) as JsonObject,
            )
        }
    }

    companion object {
        const val ASSET_NAME = "phone-demo.json"
        const val THREAD_TOKEN = "@thread"
        const val MESSAGE_TOKEN = "@message"
        private val NOW_TOKEN = Regex("^@now([+-]\\d+)?$")

        fun parse(json: String, nowMs: Long): PhoneDemoFixture =
            PhoneDemoFixture(materialize(JsonCodec.parse(json), nowMs) as JsonObject)

        /** Replace every `@now` token with a real time, anchored at [nowMs]. */
        fun materialize(value: JsonValue, nowMs: Long): JsonValue = when (value) {
            is JsonString -> NOW_TOKEN.matchEntire(value.value)?.let { match ->
                val offset = match.groupValues[1].takeIf(String::isNotEmpty)?.toLong() ?: 0L
                JsonNumber((nowMs + offset).toString())
            } ?: value
            is JsonArray -> JsonArray(value.values.map { materialize(it, nowMs) })
            is JsonObject -> JsonObject(
                value.values.mapValuesTo(LinkedHashMap()) { (_, item) -> materialize(item, nowMs) },
            )
            else -> value
        }

        private fun substitute(value: JsonValue, tokens: Map<String, String>): JsonValue = when (value) {
            is JsonString -> tokens[value.value]?.let(::JsonString) ?: value
            is JsonArray -> JsonArray(value.values.map { substitute(it, tokens) })
            is JsonObject -> JsonObject(
                value.values.mapValuesTo(LinkedHashMap()) { (_, item) -> substitute(item, tokens) },
            )
            else -> value
        }
    }
}

private fun JsonObject.obj(key: String): JsonObject =
    values[key] as? JsonObject ?: error("Demo fixture: $key is not an object")

private fun JsonObject.array(key: String): List<JsonValue> =
    (values[key] as? JsonArray)?.values ?: error("Demo fixture: $key is not a list")

private fun JsonObject.string(key: String): String =
    (values[key] as? JsonString)?.value ?: error("Demo fixture: $key is not a string")

private fun JsonObject.long(key: String): Long =
    (values[key] as? JsonNumber)?.source?.toLongOrNull() ?: error("Demo fixture: $key is not a whole number")
