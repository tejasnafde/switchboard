package app.switchboard.mobile.data.thread

import app.switchboard.mobile.data.local.OfflineSnapshot
import app.switchboard.mobile.domain.remote.MessageImage
import app.switchboard.mobile.domain.thread.FeedItem
import app.switchboard.mobile.protocol.JsonArray
import app.switchboard.mobile.protocol.JsonBoolean
import app.switchboard.mobile.protocol.JsonCodec
import app.switchboard.mobile.protocol.JsonNumber
import app.switchboard.mobile.protocol.JsonObject
import app.switchboard.mobile.protocol.JsonString

object CachedThreadStateMapper {
    fun from(
        snapshot: OfflineSnapshot,
        connectionId: String,
        threadId: String,
    ): ThreadState? {
        val threadKey = "$connectionId:$threadId"
        val thread = snapshot.cachedThreads.firstOrNull { it.threadKey == threadKey } ?: return null
        val metadata = runCatching { JsonCodec.parse(thread.rawJson) as? JsonObject }.getOrNull()
            ?: JsonObject(linkedMapOf())
        val feed = snapshot.feedRows
            .asSequence()
            .filter { it.threadKey == threadKey }
            .sortedWith(compareBy({ it.position }, { it.itemId }))
            .mapNotNull { row -> decodeFeedItem(row.rawJson) }
            .toList()
        return ThreadState(
            feed = feed,
            status = metadata.string("status") ?: "connecting",
            runtimeMode = metadata.string("runtimeMode") ?: "sandbox",
            provider = metadata.string("provider"),
            instanceId = metadata.string("instanceId"),
            instanceName = metadata.string("instanceName"),
            sessionId = metadata.string("sessionId"),
            usedTokens = metadata.long("usedTokens"),
            maxTokens = metadata.long("maxTokens"),
            costUsd = metadata.double("costUsd"),
            lastTurnDurationMs = metadata.long("lastTurnDurationMs"),
            unread = metadata.long("unread")?.toInt()?.coerceAtLeast(0) ?: 0,
        )
    }

    private fun decodeFeedItem(source: String): FeedItem? {
        val value = runCatching { JsonCodec.parse(source) as? JsonObject }.getOrNull() ?: return null
        val id = value.string("id") ?: return null
        val text = value.string("text").orEmpty()
        return when (value.string("kind")) {
            "user" -> FeedItem.User(
                id = id,
                text = text,
                at = value.long("at") ?: 0,
                images = (value.values["images"] as? JsonArray)
                    ?.values
                    .orEmpty()
                    .mapNotNull { (it as? JsonString)?.value }
                    .map { MessageImage(url = it, mimeType = null, name = null) },
            )

            "text" -> FeedItem.Text(
                id = id,
                messageId = id,
                text = text,
                stream = value.string("stream") ?: "assistant",
                done = (value.values["done"] as? JsonBoolean)?.value ?: true,
                durationMs = value.long("durationMs"),
            )

            "error" -> FeedItem.Error(id, value.string("message") ?: text, null)
            "notice" -> FeedItem.RawNotice(id, "cache.notice", text, value)
            else -> null
        }
    }

    private fun JsonObject.string(key: String): String? =
        (values[key] as? JsonString)?.value

    private fun JsonObject.long(key: String): Long? =
        (values[key] as? JsonNumber)?.source?.toLongOrNull()

    private fun JsonObject.double(key: String): Double? =
        (values[key] as? JsonNumber)?.source?.toDoubleOrNull()
}
